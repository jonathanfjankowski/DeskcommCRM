import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { normalizeCnpj } from "@/lib/crm-b2b/normalize";
import { definirSetorDaConversa } from "@/lib/atendimento/setor-da-conversa";
import { marcaDaSaida } from "@/lib/branding/saida";
import { chaveDoEnvio, enviarTextoDeSistema } from "@/lib/atendimento/envio-de-sistema";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

import { menuConfigSchema } from "./schema";
import { lerEstadoDoMenu, metadataComEstadoDoMenu } from "./estado";
import { decidirPassoDoMenu } from "./maquina";
import { empresaDoContato, vincularEmpresaPorCnpj } from "./empresa-por-cnpj";

/**
 * O PORTEIRO (spec 2026-11-11 §3) — handler determinístico de `message.received`
 * que roda ANTES do `aiResponseHandler` e conversa com o cliente SEM modelo:
 * pede o CNPJ, casa a empresa (vinculando sem CRUD), apresenta o menu numerado
 * e entrega a conversa à FILA do setor escolhido. O complemento é
 * `deveCederTurnoAoMenu` no drain, que impede o turno de IA da MESMA mensagem
 * — o registro antes do handler legado fecha a outra janela: a fila persiste
 * (pending + silenciada) e o legado, ao checar elegibilidade, já vê a conversa
 * tomada. A ordem dos handlers é o protocolo; quem a inverte reabre a corrida.
 *
 * ─── Escrita e desfecho ────────────────────────────────────────────────────
 *
 *   * envio ANTES de persistir: adiou (janela/ritmo) ou falhou → `retry`/`error`
 *     SEM gravar estado; a mesma mensagem reentra, a mesma chave determinística
 *     impede duplicata, e nada ficou meio-persistido;
 *   * `bloqueado` por restrição comercial → estado AVANÇA com `ok`: insistir no
 *     mesmo texto na próxima mensagem não muda a regra, e deixar o cliente sem
 *     menu é o pior desfecho — a fila ainda vem;
 *   * rotear: pending + `bot_silenced_until='infinity'` (o automático saiu de
 *     campo) → `definirSetorDaConversa` (o escritor único, que também pede a
 *     distribuição) → estado concluído (a chave sai do metadata).
 *
 * Registro de leitura do produto: `origem: "automacao"` — o vocabulário de
 * `setor_origem` (manual/ia/automacao) não nomeia o porteiro; a origem real do
 * ator fica no `ator.id` da auditoria, e `menu-de-entrada` nomeia quem decidiu.
 */

export const MENU_DE_ENTRADA_HANDLER_KEY = "menu-de-entrada.v1";

const payloadSchema = z.object({
  message_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  channel_session_id: z.string().uuid().nullable(),
  body_preview: z.string().optional(),
});

const conversaSchema = z.object({
  id: z.string().uuid(),
  contact_id: z.string().nullable(),
  status: z.string(),
  assigned_to_user_id: z.string().nullable(),
  sector_id: z.string().nullable(),
  service_revision: z.number().int().nonnegative(),
  metadata: z.unknown(),
  is_group: z.boolean().nullable(),
});

const TERMINAIS = ["closed", "archived", "resolved"];
const NA_FILA = ["open", "pending"];

export const menuDeEntradaHandler: EventHandler = {
  key: MENU_DE_ENTRADA_HANDLER_KEY,
  events: ["message.received"],
  naOrgParada: "pula",
  async handle(row: EventRow): Promise<HandlerResult> {
    const base = { consumer_key: MENU_DE_ENTRADA_HANDLER_KEY };
    const payload = payloadSchema.safeParse(row.payload);
    if (!payload.success) return { ...base, status: "skipped", detail: "payload_ilegivel" };
    const { message_id, conversation_id, channel_session_id } = payload.data;

    const admin = createAdminClient();
    try {
      const conv = await admin
        .from("conversations")
        .select("id, contact_id, status, assigned_to_user_id, sector_id, service_revision, metadata, is_group")
        .eq("id", conversation_id)
        .eq("organization_id", row.organization_id)
        .maybeSingle();
      if (conv.error) return { ...base, status: "error", detail: "leitura_conversa" };
      const parsed = conv.data ? conversaSchema.safeParse(conv.data) : null;
      if (!parsed?.success) return { ...base, status: "skipped", detail: "conversa_inexistente" };
      const c = parsed.data;
      if (c.is_group === true || TERMINAIS.includes(c.status)) return { ...base, status: "skipped" };

      const canal = channel_session_id;
      if (!canal) return { ...base, status: "skipped", detail: "sem_canal" };

      // Config por número + módulo dos setores ligado: sem um dos dois, o
      // porteiro não existe e a conversa segue o fluxo de sempre (fail-open).
      if (!(await moduloLigado(admin, "setores"))) return { ...base, status: "skipped", detail: "setores_desligados" };
      const cfg = await admin
        .from("menu_de_entrada")
        .select("id, ativo, pedir_cnpj, textos, setor_padrao_id")
        .eq("organization_id", row.organization_id)
        .eq("channel_session_id", canal)
        .maybeSingle();
      if (cfg.error) return { ...base, status: "error", detail: "leitura_config" };
      const linhaCfg = cfg.data as { id: string; ativo: boolean } | null;
      if (!linhaCfg || linhaCfg.ativo !== true) return { ...base, status: "skipped", detail: "sem_config_ativa" };
      const opts = await admin
        .from("menu_de_entrada_opcoes")
        .select("sector_id, rotulo, ordem")
        .eq("organization_id", row.organization_id)
        .eq("menu_id", linhaCfg.id)
        .order("ordem", { ascending: true });
      const configParse = menuConfigSchema.safeParse({
        ativo: true,
        pedir_cnpj: (cfg.data as { pedir_cnpj?: boolean }).pedir_cnpj,
        textos: (cfg.data as { textos?: unknown }).textos,
        setor_padrao_id: (cfg.data as { setor_padrao_id?: string | null }).setor_padrao_id,
        opcoes: opts.data ?? [],
      });
      if (!configParse.success) {
        logger.warn("[menu] config ilegível — porteiro não opera nesta mensagem", {
          organization_id: row.organization_id,
          menu_id: linhaCfg.id,
        });
        return { ...base, status: "skipped", detail: "config_ilegivel" };
      }
      const config = configParse.data;

      const contato = await admin
        .from("contacts")
        .select("id, is_blocked")
        .eq("id", payload.data.contact_id)
        .eq("organization_id", row.organization_id)
        .maybeSingle();
      if ((contato.data as { is_blocked?: boolean } | null)?.is_blocked === true) {
        return { ...base, status: "skipped", detail: "contato_bloqueado" };
      }

      const estado = lerEstadoDoMenu(c.metadata, c.service_revision);
      // Dono humano ao meio: a fila assumiu — o porteiro se cala (não fala por
      // cima de gente, mesmo com estado aberto na revisão desta conversa).
      if (c.assigned_to_user_id) return { ...base, status: "skipped", detail: "conversa_com_dono" };
      const startable = NA_FILA.includes(c.status) && c.sector_id === null;
      if (!estado && !startable) return { ...base, status: "skipped", detail: "fora_do_menu" };

      // O corpo INTEIRO, não o preview truncado do evento (um CNPJ colado no
      // fim de uma frase ainda é um CNPJ).
      const msg = await admin
        .from("messages")
        .select("type, body")
        .eq("id", message_id)
        .eq("organization_id", row.organization_id)
        .maybeSingle();
      const tipo = (msg.data as { type?: string } | null)?.type;
      const corpo = (msg.data as { body?: string | null } | null)?.body ?? null;
      const texto = tipo === "text" && corpo !== null ? corpo : (payload.data.body_preview?.trim() || null);

      // Fatos de empresa que a máquina recebe prontos (ela é pura; o banco é aqui).
      let empresaConhecida: { id: string; nome: string } | null = null;
      let empresaIdResolvida: string | null = null;
      const cnpjRespondido = estado?.etapa === "cnpj" && texto !== null ? normalizeCnpj(texto) : null;
      if (cnpjRespondido && payload.data.contact_id) {
        const vinculo = await vincularEmpresaPorCnpj(admin, {
          organizationId: row.organization_id,
          contactId: payload.data.contact_id,
          cnpj: texto as string,
          actorUserId: null,
        });
        if (vinculo.ok) {
          empresaIdResolvida = vinculo.empresaId;
          // Empresa QUE ACABA DE NASCER não tem "bom te ver de volta": a máquina
          // recebe null e segue com o texto neutro do menu.
          if (!vinculo.criada) empresaConhecida = { id: vinculo.empresaId, nome: vinculo.nome };
        } else if (vinculo.motivo !== "cnpj_invalido") {
          logger.warn("[menu] vínculo de empresa falhou — o menu segue sem empresa", {
            organization_id: row.organization_id,
            conversation_id,
            motivo: vinculo.motivo,
          });
        }
      } else if (!estado && config.pedir_cnpj) {
        const doContato = await empresaDoContato(admin, {
          organizationId: row.organization_id,
          contactId: payload.data.contact_id,
        });
        if (doContato) {
          empresaConhecida = { id: doContato.id, nome: doContato.nome };
          empresaIdResolvida = doContato.id;
        }
      }

      let setorPadraoNome: string | null = null;
      if (config.setor_padrao_id) {
        const setor = await admin
          .from("attendant_sectors")
          .select("name")
          .eq("organization_id", row.organization_id)
          .eq("id", config.setor_padrao_id)
          .maybeSingle();
        setorPadraoNome = (setor.data as { name?: string } | null)?.name ?? null;
      }

      const marca = await marcaDaSaida(row.organization_id);
      const passo = decidirPassoDoMenu({
        estado,
        config,
        texto,
        empresaConhecida,
        serviceRevision: c.service_revision,
        marca: marca.nome,
        setorPadraoNome,
      });
      if (passo.acao === "nada" || !passo.texto) return { ...base, status: "skipped", detail: "nada_a_dizer" };

      // ─── Reivindicação de posse ANTES de falar ─────────────────────────────
      // O primeiro passo do menu silencia o bot NA HORA, antes de qualquer
      // rede: o handler legado (`aiResponseHandler`, que atende justamente as
      // orgs SEM agente publicado — ver o comentário no worker) roda depois
      // deste na ordem sequencial do dispatcher e, ao checar elegibilidade, já
      // vê `conversa_silenciada` e se cala. Se o envio falhar ou adiar, a
      // conversa fica silenciada SEM estado gravado: a próxima mensagem dela
      // reentra pelo `startable` (o menu recomeça) e a fila de sem-dono é o
      // anti-morte — silenciada aberta conta como espera, nunca como perdida.
      if (!estado && startable) {
        await admin
          .from("conversations")
          .update({ bot_silenced_until: "infinity" })
          .eq("id", conversation_id)
          .eq("organization_id", row.organization_id);
      }

      const chave = chaveDoEnvio(
        "menu",
        conversation_id,
        String(c.service_revision),
        passo.acao,
        message_id,
      );
      const envio = await enviarTextoDeSistema(admin, {
        organizationId: row.organization_id,
        conversationId: conversation_id,
        contactId: payload.data.contact_id,
        body: passo.texto,
        chave,
        atorRotulo: "menu-de-entrada",
        metadata: { menu_de_entrada: true, etapa: passo.acao },
      });

      if (envio.resultado === "adiado") {
        return {
          ...base,
          status: "retry",
          retry_at: (envio.ate ?? new Date(Date.now() + 60 * 1000)).toISOString(),
          detail: "adiado_janela_ou_ritmo",
        };
      }
      if (envio.resultado === "erro") return { ...base, status: "error", detail: "envio" };

      // sent | queued | bloqueado → o estado avança (bloqueado com aviso no
      // detail: o texto está barrado, a posição da conversa no fluxo não).
      const terminal = passo.acao === "rotear" || passo.acao === "setor_padrao";
      if (terminal && passo.setorId) {
        const proximo = passo.proximoEstado;
        const metadata = metadataComEstadoDoMenu(c.metadata, proximo ?? {
          service_revision: c.service_revision,
          etapa: "concluido",
          tentativas_cnpj: 0,
          tentativas_setor: 0,
          empresa_id: empresaIdResolvida,
        });
        const upd = await admin
          .from("conversations")
          .update({ status: "pending", bot_silenced_until: "infinity", metadata })
          .eq("id", conversation_id)
          .eq("organization_id", row.organization_id);
        if ((upd as { error?: unknown }).error) return { ...base, status: "error", detail: "persistencia_fila" };
        const setor = await definirSetorDaConversa({
          db: admin,
          organizationId: row.organization_id,
          conversationId: conversation_id,
          sectorId: passo.setorId,
          origem: "automacao",
          ator: { tipo: "automacao", id: MENU_DE_ENTRADA_HANDLER_KEY },
          requestId: row.id,
        });
        if (!setor.ok) {
          // A fila pedida não existe mais (apagaram o setor no meio do voo) ou
          // a conversa encerrou. O cliente já foi confirmado na fila de fato
          // (pending, sem dono): o aviso vai no log, o evento se encerra aqui.
          logger.warn("[menu] roteio recusado pelo escritor de setor", {
            organization_id: row.organization_id,
            conversation_id,
            motivo: setor.motivo,
          });
        }
        return { ...base, status: "ok", detail: envio.resultado === "bloqueado" ? "bloqueado_restricao_comercial" : undefined };
      }

      if (passo.proximoEstado) {
        const estadoFinal = empresaIdResolvida
          ? { ...passo.proximoEstado, empresa_id: passo.proximoEstado.empresa_id ?? empresaIdResolvida }
          : passo.proximoEstado;
        const metadata = metadataComEstadoDoMenu(c.metadata, estadoFinal);
        const upd = await admin
          .from("conversations")
          .update({ metadata })
          .eq("id", conversation_id)
          .eq("organization_id", row.organization_id);
        if ((upd as { error?: unknown }).error) return { ...base, status: "error", detail: "persistencia_estado" };
      }
      return { ...base, status: "ok", detail: envio.resultado === "bloqueado" ? "bloqueado_restricao_comercial" : undefined };
    } catch (erro) {
      logger.warn("[menu] porteiro falhou — a conversa segue o fluxo normal", {
        organization_id: row.organization_id,
        conversation_id,
        erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
      });
      return { ...base, status: "error", detail: "excecao" };
    }
  },
};
