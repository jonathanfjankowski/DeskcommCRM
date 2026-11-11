import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { atendimentoDeclarado } from "@/lib/schemas/settings";
import { logger } from "@/lib/logger";
import { renderTemplate } from "@/lib/atendimento/menu-de-entrada/render";
import { chaveDoEnvio, enviarTextoDeSistema } from "@/lib/atendimento/envio-de-sistema";
import { marcaDaSaida } from "@/lib/branding/saida";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";

/**
 * A saudação de quem ASSUMIU (spec 2026-11-11 §3.6) — consumidora do evento
 * `conversation.atendente_assumiu`, emitido pelo trigger na tabela única de
 * atribuição. Por isso ela pega TODOS os caminhos: claim pelo botão,
 * transferência, distribuição automática do routing-worker, automação e MCP
 * passam todos por `fn_conversation_assign`.
 *
 * Regras que a tela não pode perder:
 *   * desligado por omissão — só envia com `saudacao_na_assumida.ativo`
 *     EXPLÍCITO; template vazio não dispara texto inventado (nada hardcoded);
 *   * conversa encerrada ou assumida por outra pessoa no meio do caminho:
 *     silêncio — a saudação de quem perdeu o posto seria pior que nenhuma;
 *   * idempotência: a chave deriva do `assignment_event_id` — o retry do
 *     dispatcher recai na MESMA linha de `messages` (o handler de envio
 *     reconcilia o 23505); duas assumidas na mesma conversa ganham duas
 *     saudações porque são dois eventos, e é isso que o operador pediu;
 *   * adiado pela janela/ritmo volta como `retry` com o instante — a saudação
 *     espera a abertura em vez de se perder; bloqueio comercial fecha o
 *     consumo com `ok` + detalhe: insistir no mesmo texto não muda a regra.
 */

export const SAUDACAO_ASSUMIDA_HANDLER_KEY = "saudacao-assumida.v1";

const payloadSchema = z.object({
  conversation_id: z.string().uuid(),
  assignment_event_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  reason: z.string(),
});

const conversaSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  contact_id: z.string().nullable(),
  status: z.string(),
  assigned_to_user_id: z.string().nullable(),
  assigned_to_user_name: z.string().nullable(),
});

const TERMINAIS = new Set(["closed", "archived", "resolved"]);

export const saudacaoNaAssumidaHandler: EventHandler = {
  key: SAUDACAO_ASSUMIDA_HANDLER_KEY,
  events: ["conversation.atendente_assumiu"],
  naOrgParada: "pula",
  async handle(row: EventRow): Promise<HandlerResult> {
    const base = { consumer_key: SAUDACAO_ASSUMIDA_HANDLER_KEY };
    const payload = payloadSchema.safeParse(row.payload);
    if (!payload.success) {
      logger.warn("[saudacao] evento com payload ilegível", {
        organization_id: row.organization_id,
        event_log_id: row.id,
      });
      return { ...base, status: "skipped", detail: "payload_ilegivel" };
    }
    const { conversation_id, assignment_event_id, to_user_id } = payload.data;

    const admin = createAdminClient();
    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", row.organization_id)
      .maybeSingle();
    const atendimento = atendimentoDeclarado((org as { settings?: unknown } | null)?.settings);
    if (!atendimento.saudacao_na_assumida.ativo) {
      return { ...base, status: "skipped", detail: "desligado" };
    }

    const { data: linha, error } = await admin
      .from("conversations")
      .select("id, organization_id, contact_id, status, assigned_to_user_id, assigned_to_user_name")
      .eq("id", conversation_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    if (error) return { ...base, status: "error", detail: "leitura_conversa" };
    const conversa = linha ? conversaSchema.safeParse(linha) : null;
    if (!linha || !conversa?.success) {
      return { ...base, status: "skipped", detail: "conversa_inexistente" };
    }
    const c = conversa.data;
    if (TERMINAIS.has(c.status)) return { ...base, status: "skipped", detail: "conversa_encerrada" };
    if (c.assigned_to_user_id !== to_user_id) return { ...base, status: "skipped", detail: "assumida_ultrapassada" };
    if (!c.contact_id) return { ...base, status: "skipped", detail: "sem_contato" };

    // A coluna desnormalizada (0202) traz o nome na linha; o fallback cobre a
    // raridade histórica (atribuída antes da migration) pelo MESMO resolvedor
    // da tela — sem segundo caminho para o nome de uma pessoa.
    const nome =
      c.assigned_to_user_name ??
      (await nomesDosAtendentes(row.organization_id, [to_user_id])).get(to_user_id) ??
      null;
    if (!nome) {
      logger.warn("[saudacao] sem nome do atendente — não se manda 'olá, meu nome é'", {
        organization_id: row.organization_id,
        conversation_id,
      });
      return { ...base, status: "skipped", detail: "sem_nome" };
    }

    const template = atendimento.saudacao_na_assumida.template;
    if (!template.trim()) return { ...base, status: "skipped", detail: "template_vazio" };

    // `[empresa]` pela marca DA SAÍDA (banco acima do .env — white-label), que
    // é a fachada certa para o que alcança o cliente fora do DOM.
    const marca = await marcaDaSaida(row.organization_id);
    const corpo = renderTemplate(template, { nome, empresa: marca.nome });
    if (!corpo.trim()) return { ...base, status: "skipped", detail: "template_vazio" };

    const desfecho = await enviarTextoDeSistema(admin, {
      organizationId: row.organization_id,
      conversationId: conversation_id,
      contactId: c.contact_id,
      body: corpo,
      // ASSUMPTION: derivar a chave do evento de atribuição é o contrato de
      // "uma saudação por assumida" — a próxima assumida é outro evento, com
      // outra chave, e é isso que o operador pediu ("sempre que um atendente
      // assume"). Trocar a origem da derivação mudaria o comportamento do
      // cliente sem passar por esta frase.
      chave: chaveDoEnvio("saudacao-assumida", conversation_id, assignment_event_id),
      atorRotulo: "saudacao-assumida",
      metadata: { saudacao_assumida: true, assignment_event_id },
    });

    switch (desfecho.resultado) {
      case "sent":
      case "queued":
        return { ...base, status: "ok" };
      case "adiado":
        return {
          ...base,
          status: "retry",
          retry_at: (desfecho.ate ?? new Date(Date.now() + 30 * 60 * 1000)).toISOString(),
          detail: "adiado_janela_ou_ritmo",
        };
      case "bloqueado":
        return { ...base, status: "ok", detail: "bloqueado_restricao_comercial" };
      case "erro":
      default:
        return { ...base, status: "error", detail: "envio" };
    }
  },
};
