import { normalizeCnpj } from "@/lib/crm-b2b/normalize";

import type { MenuConfig } from "./schema";
import type { EstadoDoMenu } from "./estado";
import { parseOpcaoDoMenu, opcoesOrdenadas } from "./parser";
import { renderTemplate } from "./render";

/**
 * A máquina do menu de entrada — o coração determinístico (spec §3).
 *
 * PURO por construção: recebe o estado persistido, a config, o texto do
 * inbound e os Fatos já resolvidos por quem chama (empresa conhecida — o
 * handler olhou o banco; marca — o branding da org) e devolve o passo: qual
 * mensagem renderizada mandar, qual estado gravar, qual setor rotear. Nenhum
 * I/O, nenhum LLM, nenhum relógio. Um handler burro conecta as pontas.
 *
 * Limites de tentativa (Revisão Foco 1 — ninguém morre no silêncio):
 * CNPJ até 2 repetições, opção até 1 repetição; estourou, roteia (setor
 * padrão ou a primeira opção) e o cliente cai na fila humana de qualquer
 * forma. Áudio/mídia sem texto conta como tentativa inválida.
 */

export type AcaoDoMenu =
  | "boas_vindas"
  | "pedido_cnpj"
  | "menu"
  | "seguir_sem_cnpj"
  | "opcao_invalida"
  | "rotear"
  | "setor_padrao"
  | "nada";

export interface PassoDoMenu {
  acao: AcaoDoMenu;
  /** Já renderizado (placeholders resolvidos). Vazio em `nada`. */
  texto: string;
  /** O estado a persistir; `concluido` = o writer remove a chave. */
  proximoEstado: EstadoDoMenu | null;
  setorId?: string;
  empresaId?: string;
}

export interface EntradaDaMaquina {
  /** O estado lido para a sessão corrente; `null` = menu ainda não começou. */
  estado: EstadoDoMenu | null;
  config: MenuConfig;
  /** Corpo da mensagem inbound; `null` para mídia sem texto. */
  texto: string | null;
  /** Empresa do CNPJ respondido (ou do contato, ao iniciar): resolvida pelo handler. */
  empresaConhecida: { id: string; nome: string } | null;
  /** `conversations.service_revision` da sessão que está falando. */
  serviceRevision: number;
  /** Marca da organização para `[empresa]` (white-label, resolvida do banco). */
  marca?: string | null;
  /** Nome do setor padrão para `[setor]` no aviso (resolvido pelo handler). */
  setorPadraoNome?: string | null;
}

const MAX_TENTATIVAS_CNPJ = 2;
const MAX_TENTATIVAS_SETOR = 1;

export function decidirPassoDoMenu(entrada: EntradaDaMaquina): PassoDoMenu {
  const { config, estado, serviceRevision } = entrada;
  const opcoes = opcoesOrdenadas(config.opcoes);
  if (opcoes.length === 0) {
    // Menu ligado sem opção é config incompleta: não opera, fail-open para o
    // fluxo normal — o handler não grava estado nem manda nada.
    return { acao: "nada", texto: "", proximoEstado: null };
  }

  const vars = { empresa: entrada.marca ?? null, opcoes };
  const novo = (parcial: Partial<EstadoDoMenu> & { etapa: EstadoDoMenu["etapa"] }): EstadoDoMenu => ({
    service_revision: serviceRevision,
    tentativas_cnpj: 0,
    tentativas_setor: 0,
    empresa_id: null,
    ...parcial,
  });

  if (estado === null) {
    if (entrada.empresaConhecida) {
      // Contato que já tem empresa não é interrogado: saudação + menu direto.
      return {
        acao: "menu",
        texto: renderTemplate(config.textos.cnpj_conhecido, {
          ...vars,
          empresa_cliente: entrada.empresaConhecida.nome,
        }),
        proximoEstado: novo({ etapa: "setor", empresa_id: entrada.empresaConhecida.id }),
        empresaId: entrada.empresaConhecida.id,
      };
    }
    if (config.pedir_cnpj) {
      return {
        acao: "boas_vindas",
        texto: renderTemplate(config.textos.boas_vindas_cnpj, vars),
        proximoEstado: novo({ etapa: "cnpj" }),
      };
    }
    return {
      acao: "menu",
      texto: renderTemplate(config.textos.menu_setores, vars),
      proximoEstado: novo({ etapa: "setor" }),
    };
  }

  if (estado.etapa === "cnpj") {
    const cnpj = entrada.texto !== null ? normalizeCnpj(entrada.texto) : null;
    if (cnpj) {
      const conhecida = entrada.empresaConhecida;
      return {
        acao: "menu",
        texto: renderTemplate(
          conhecida ? config.textos.cnpj_conhecido : config.textos.menu_setores,
          conhecida ? { ...vars, empresa_cliente: conhecida.nome } : vars,
        ),
        proximoEstado: novo({ etapa: "setor", empresa_id: conhecida?.id ?? null }),
        ...(conhecida ? { empresaId: conhecida.id } : {}),
      };
    }
    if (estado.tentativas_cnpj < MAX_TENTATIVAS_CNPJ) {
      return {
        acao: "pedido_cnpj",
        texto: renderTemplate(config.textos.pedido_cnpj, vars),
        proximoEstado: novo({ ...estado, etapa: "cnpj", tentativas_cnpj: estado.tentativas_cnpj + 1 }),
      };
    }
    // Estourou: segue SEM empresa. O atendente pode vincular depois na tela.
    return {
      acao: "seguir_sem_cnpj",
      texto: renderTemplate(config.textos.seguir_sem_cnpj, vars),
      proximoEstado: novo({ etapa: "setor" }),
    };
  }

  // etapa "setor"
  const escolha = parseOpcaoDoMenu(entrada.texto, config.opcoes);
  if (escolha) {
    return {
      acao: "rotear",
      texto: renderTemplate(config.textos.confirmacao_fila, { ...vars, setor: escolha.rotulo }),
      proximoEstado: novo({ ...estado, etapa: "concluido" }),
      setorId: escolha.sector_id,
    };
  }
  if (estado.tentativas_setor < MAX_TENTATIVAS_SETOR) {
    return {
      acao: "opcao_invalida",
      texto: renderTemplate(config.textos.opcao_invalida, vars),
      proximoEstado: novo({ ...estado, etapa: "setor", tentativas_setor: estado.tentativas_setor + 1 }),
    };
  }
  if (config.setor_padrao_id) {
    return {
      acao: "setor_padrao",
      texto: renderTemplate(config.textos.aviso_setor_padrao, {
        ...vars,
        setor: entrada.setorPadraoNome ?? null,
      }),
      proximoEstado: novo({ ...estado, etapa: "concluido" }),
      setorId: config.setor_padrao_id,
    };
  }
  // Sem setor padrão configurado, o destino honesto é a primeira opção do menu.
  const primeira = opcoes[0]!;
  return {
    acao: "rotear",
    texto: renderTemplate(config.textos.confirmacao_fila, { ...vars, setor: primeira.rotulo }),
    proximoEstado: novo({ ...estado, etapa: "concluido" }),
    setorId: primeira.sector_id,
  };
}
