import { z } from "zod";

/**
 * Configuração do menu de entrada determinístico (spec 2026-11-11 §4).
 *
 * Os textos ao cliente vivem AQUI como dados semeados — o comportamento
 * (máquina de estados, handler) nunca embute mensagem fixa: renderiza o que
 * a configuração diz. Ao ligar o menu pela tela, estes defaults são gravados
 * na linha de config e o operador edita qualquer um.
 *
 * `menuConfigSchema` é o schema de ESCRITA/validação da rota de config:
 * rejeita mais de 8 opções e rótulo vazio. Campos escalares têm `.catch`
 * porque a mesma forma é lida do banco por código defensivo (leitura nunca
 * lança — fail-open: config ilegível = menu não opera, fluxo normal segue).
 */

export const TEXTOS_PADRAO_DO_MENU = {
  boas_vindas_cnpj: "Olá, seja bem-vindo à [empresa]! Para agilizar, informe o CNPJ da sua empresa.",
  cnpj_conhecido: "Que bom ter você de volta, [empresa_cliente]! Com qual setor deseja falar?\n[opcoes]",
  pedido_cnpj: "Não reconheci esse CNPJ. Pode enviar de novo?",
  seguir_sem_cnpj: "Sem problemas, vamos seguir. Com qual setor deseja falar?\n[opcoes]",
  menu_setores: "Com qual setor deseja falar?\n[opcoes]",
  opcao_invalida: "Não entendi. Responda com o número do setor:\n[opcoes]",
  confirmacao_fila: "Pronto! Você está na fila do [setor]. Em instantes um atendente fala com você.",
  aviso_setor_padrao: "Vou te encaminhar para o [setor]. Em instantes um atendente fala com você.",
} as const;

export type ChaveDeTextoDoMenu = keyof typeof TEXTOS_PADRAO_DO_MENU;

const texto = (padrao: string) => z.string().max(2000).catch(padrao);

export const menuTextosSchema = z
  .object({
    boas_vindas_cnpj: texto(TEXTOS_PADRAO_DO_MENU.boas_vindas_cnpj),
    cnpj_conhecido: texto(TEXTOS_PADRAO_DO_MENU.cnpj_conhecido),
    pedido_cnpj: texto(TEXTOS_PADRAO_DO_MENU.pedido_cnpj),
    seguir_sem_cnpj: texto(TEXTOS_PADRAO_DO_MENU.seguir_sem_cnpj),
    menu_setores: texto(TEXTOS_PADRAO_DO_MENU.menu_setores),
    opcao_invalida: texto(TEXTOS_PADRAO_DO_MENU.opcao_invalida),
    confirmacao_fila: texto(TEXTOS_PADRAO_DO_MENU.confirmacao_fila),
    aviso_setor_padrao: texto(TEXTOS_PADRAO_DO_MENU.aviso_setor_padrao),
  })
  .catch({ ...TEXTOS_PADRAO_DO_MENU });

export const menuOpcaoSchema = z.object({
  sector_id: z.string().uuid(),
  rotulo: z.string().trim().min(1).max(60),
  ordem: z.number().int().min(0).max(7),
});

export const menuConfigSchema = z.object({
  ativo: z.boolean().catch(false),
  pedir_cnpj: z.boolean().catch(true),
  textos: menuTextosSchema,
  setor_padrao_id: z.string().uuid().nullable().catch(null),
  opcoes: z.array(menuOpcaoSchema).max(8).default([]),
});

export type MenuConfig = z.infer<typeof menuConfigSchema>;
export type MenuOpcao = z.infer<typeof menuOpcaoSchema>;
