import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { logger } from "@/lib/logger";
import { janelaDeEnvioAberta, proximaAberturaDaJanela } from "@/lib/agent-engine/pacing/engine";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { comercialExigeHumanoViaSupabase, restricaoComercialBarra } from "@/lib/escalacao/assunto-comercial";
import { canalDaConversa } from "@/lib/followup/janela-de-disparo";

/**
 * O envio de SISTEMA — a porta canônica para as mensagens que o produto manda
 * por configuração de operador, sem turno de IA: o menu de entrada e a
 * saudação na assumida (spec 2026-11-11).
 *
 * ─── O que replica e por quê ───────────────────────────────────────────────
 *
 * Copia a ordem das réguas do atalho inline do follow-up
 * (`lib/followup/enviar-texto-fixo.ts`), na mesma sequência testada:
 *   janela de DISPARO do canal → restrição COMERCIAL → ritmo ANTI-BAN →
 *   envio pela porta única `sendMessageHandler` → contabiliza no ritmo.
 * Perguntar na ordem inversa (ritmo antes da janela) devolve "espere 1,2 s"
 * para um envio que só sai amanhã às 8h.
 *
 * ─── O que NÃO replica, e por quê ──────────────────────────────────────────
 *
 *  - `send_ledger`: sua `job_id` tem FK para `job_queue` — menu e saudação
 *    não têm job. A idempotência vem do `internalMessageId` DETERMINÍSTICO
 *    (`chaveDoEnvio`): o handler reconcilia o 23505 na própria linha e o
 *    retry do dispatcher nunca duplica a mensagem. É a mesma garantia do
 *    caminho de mídia do agente (`media_*_id` determinístico por run).
 *  - gate de ELEGIBILIDADE da IA: ele governa a IA falar; estas mensagens
 *    são o produto falando com o texto que o OPERADOR escreveu — a saudação,
 *    por definição, dispara quando um HUMANO assume (conversa silenciada,
 *    dono humano), estados que o gate vetaria. Veto de contato que vale
 *    mesmo assim: `is_blocked`/STOP — a porta única já recusa fail-closed.
 *  - faixa do follow-up (`send_window` do agente): sem enrollment, a régua
 *    não existe; o canal responde pela janela.
 */

export interface EnvioDeSistemaInput {
  organizationId: string;
  conversationId: string;
  contactId: string;
  /** Corpo JÁ renderizado pelo chamador (placeholders resolvidos). */
  body: string;
  /** UUID determinística p/ esta tentativa lógica (`chaveDoEnvio`). */
  chave: string;
  /** Identifica o remetente sistêmico nos metadados e logs: "menu-de-entrada", "saudacao-assumida". */
  atorRotulo: string;
  metadata: Record<string, unknown>;
  agora?: Date;
}

export type ResultadoDoEnvio = "sent" | "queued" | "adiado" | "bloqueado" | "erro";

export interface DesfechoDoEnvio {
  resultado: ResultadoDoEnvio;
  /** Presente em `adiado`: o primeiro instante em que vale tentar de novo. */
  ate?: Date;
}

/**
 * Deriva a uuid-v4-shape do contexto lógico do envio. Determinística POR
 * CONSTRUÇÃO: a mesma conversa/etapa/mensagem → a mesma linha de `messages`
 * mesmo que o dispatcher re-execute o handler mil vezes.
 */
export function chaveDoEnvio(...partes: string[]): string {
  const hex = createHash("sha256").update(partes.join("|")).digest("hex").slice(0, 32);
  const alinhavos = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ];
  return alinhavos.join("-");
}

export async function enviarTextoDeSistema(
  admin: SupabaseClient,
  input: EnvioDeSistemaInput,
): Promise<DesfechoDoEnvio> {
  const agora = input.agora ?? new Date();
  const body = input.body.trim();
  if (!body) return { resultado: "erro" };

  try {
    const sessao = await canalDaConversa(admin, input.organizationId, input.conversationId, input.contactId);

    // 1. Janela de disparo do canal (a tela de Proteção de envio). Sem canal,
    // não há janela a consultar — o envio segue, como no follow-up.
    if (sessao !== null) {
      const knobs = await knobsDoCanal(admin, input.organizationId, sessao);
      if (knobs !== null && !janelaDeEnvioAberta(agora, knobs)) {
        const ate = proximaAberturaDaJanela(agora, knobs, false, () => 0);
        logger.info("[sistema] envio adiado — fora da janela de disparo", {
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
          ator: input.atorRotulo,
        });
        return { resultado: "adiado", ate: ate instanceof Date ? ate : new Date(agora.getTime() + 30 * 60 * 1000) };
      }
    }

    // 2. Restrição comercial — texto de operador tem o MESMO veto do agente;
    // sem esta régua o atalho entregaria o preço que a cadeia barra.
    const barra = await restricaoComercialBarra(
      body,
      () => comercialExigeHumanoViaSupabase(admin, input.organizationId),
      (mensagem, contexto) => logger.warn(`[sistema] ${mensagem}`, { organization_id: input.organizationId, ...contexto }),
    );
    if (barra) {
      return { resultado: "bloqueado" };
    }

    // 3. Ritmo anti-ban (espaçamento/teto). ADIA em vez de dormir, igual ao
    // follow-up: quem espera é o dispatcher do evento, não este request.
    const ritmo = await criarPacingDoCanal(admin);
    if (sessao !== null) {
      const decisao = await ritmo.decide(input.organizationId, sessao, agora);
      if (decisao.liberado !== true) {
        const ate = decisao.liberaEm instanceof Date ? decisao.liberaEm : new Date(agora.getTime() + 30 * 1000);
        logger.info("[sistema] envio adiado pelo ritmo do canal", {
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
          ator: input.atorRotulo,
          motivo: decisao.motivo ?? null,
        });
        return { resultado: "adiado", ate };
      }
    }

    // 4. A porta única. `internalMessageId` = chave determinística: INSERT em
    // messages com esse id; 23505 → o handler reconcilia a linha existente e
    // NENHUMA segunda mensagem sai.
    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: input.organizationId,
        actor: { type: "webhook_source", id: `sistema:${input.atorRotulo}` },
        requestId: input.chave,
        internalMessageId: input.chave,
      },
      { conversation_id: input.conversationId, type: "text", body, metadata: input.metadata },
    );

    const status = (mensagem as { status?: string } | null)?.status;
    if (status === "failed") {
      logger.warn("[sistema] envio falhou no canal", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        ator: input.atorRotulo,
      });
      return { resultado: "erro" };
    }
    if (status === "queued") {
      // O canal segurou (sessão ≠ WORKING): o reenvio tem dono (watchdog);
      // NÃO contabiliza no ritmo — a entrega real ainda vai acontecer.
      return { resultado: "queued" };
    }

    // 5. Contabiliza o envio no ritmo (a mensagem saiu). Falha de contabilidade
    // é aberta (log), nunca derruba um envio que já aconteceu.
    if (sessao !== null) {
      try {
        await ritmo.registraEnvio(input.organizationId, sessao, new Date());
      } catch {
        logger.warn("[sistema] não consegui contabilizar o envio no ritmo", {
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
        });
      }
    }
    return { resultado: "sent" };
  } catch (erro) {
    logger.warn("[sistema] envio de sistema falhou", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      ator: input.atorRotulo,
      erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return { resultado: "erro" };
  }
}
