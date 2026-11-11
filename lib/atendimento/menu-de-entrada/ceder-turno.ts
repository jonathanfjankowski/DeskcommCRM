import type { Pool } from "pg";

import { logger } from "@/lib/logger";

/**
 * O gate do dreno (spec 2026-11-11 §3.5): enquanto o menu de entrada possui a
 * conversa, o turno de IA nem é enfileirado. Irmão de
 * `deveCederTurnoAoRetorno`, inclusive no desfecho: erro de leitura devolve
 * `false` e a IA segue o caminho de sempre — fail-ABERTO para o fluxo normal,
 * porque a pergunta "este canal tem porteiro?" só pode silenciar quem respondeu
 * sim. Quem quer calar a IA inteira liga o modo humano da org
 * (`settings.atendimento.somente_humano`), que é veto explícito, não derivado.
 *
 * A posse é UMA consulta, três metades — divergir do handler é turno IA+menu
 * na mesma mensagem:
 *   1. estado do menu VIVO na service_revision atual (etapa cnpj/setor);
 *   2. conversa que o menu ainda vai começar (sem dono, sem fila, em aberto);
 *   3. conversa já REIVINDICADA pelo handler (silenciada duradoura, sem dono,
 *      sem fila) — cobre o intervalo entre a reivindicação e a gravação do
 *      estado, incluindo o retry de um envio adiado.
 */

export interface PedidoDeCessaoMenu {
  organizationId: string;
  conversationId: string;
}

const CONSULTA = `
select 1
  from public.conversations c
  join public.menu_de_entrada m
    on m.organization_id = c.organization_id
   and m.channel_session_id = c.channel_session_id
   and m.ativo
  join public.contacts ct
    on ct.id = c.contact_id
   and ct.organization_id = c.organization_id
 where c.organization_id = $1
   and c.id = $2
   and ct.kind is distinct from 'whatsapp_group'
   and ct.is_blocked is not true
   and (
     (
       c.metadata->'menu_de_entrada' is not null
       and (c.metadata->'menu_de_entrada'->>'service_revision') ~ '^[0-9]+$'
       and (c.metadata->'menu_de_entrada'->>'service_revision')::bigint = c.service_revision
       and c.metadata->'menu_de_entrada'->>'etapa' in ('cnpj', 'setor')
     )
     or (
       c.assigned_to_user_id is null
       and c.sector_id is null
       and (c.status in ('open', 'pending') or c.bot_silenced_until = 'infinity')
     )
   )
 limit 1`;

export async function deveCederTurnoAoMenu(
  pool: Pick<Pool, "query">,
  pedido: PedidoDeCessaoMenu,
): Promise<boolean> {
  try {
    const { rows } = await pool.query(CONSULTA, [pedido.organizationId, pedido.conversationId]);
    return rows.length > 0;
  } catch (erro) {
    logger.warn("drain: não deu para saber se o menu possui a conversa — o turno segue o caminho de sempre", {
      organization_id: pedido.organizationId,
      conversation_id: pedido.conversationId,
      erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return false;
  }
}
