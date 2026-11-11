-- manifest: saudação na assumida — trigger em conversation_assignment_events emite conversation.atendente_assumiu (claim/transfer/routing/handoff com dono real); o envio é do handler, trigger nunca faz HTTP

-- 9341 — saudação na assumida (spec 2026-11-11 §3.6).
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
-- Trigger AFTER INSERT em `conversation_assignment_events` — a tabela que
-- `fn_conversation_assign` escreve para TODOS os motivos (claim manual,
-- transferência, roteamento automático via fn_channel_routing_claim,
-- automações e MCP passam todos pela mesma função). O trigger emite
-- `conversation.atendente_assumiu` no event_log; o handler
-- (lib/atendimento/saudacao-na-assumida.ts) renderiza o template da org e
-- envia pela cadeia canônica. Trigger NUNCA faz HTTP (anti-pattern 9).
--
-- ─── Guardas ───────────────────────────────────────────────────────────────
--
--   * `to_user_id is null` (release/revogação) não é assumida — não emite;
--   * motivos fora de claim/transfer/routing/handoff não emitem;
--   * o fato tem de corresponder ao DONO REAL da conversa na mesma org
--     (mesma guarda do trigger irmão fn_interromper_turnos_ao_assumir):
--     atribuição ultrapassada não dispara saudação.
--
-- O evento nasce `pending` (consumível); o irmão de revogação nasce `done`
-- porque é registro, não fila. O formato do tipo casa o CHECK event_type_format
-- (dois segmentos). Idempotência do envio é do handler (send_ledger por
-- assignment_event_id), não do trigger.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- Trigger novo, sem dado legado; evento novo sem consumidor até o handler
-- existir (event_log acumula pending — o handler nasce na mesma entrega).
-- Tudo idempotente, reaplicável pelo update.sh.

create or replace function public.fn_emit_saudacao_na_assumida()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Release e revogação não são assumida; só os motivos que entregam a
  -- conversa a uma pessoa.
  if new.to_user_id is null or new.reason not in ('claim', 'transfer', 'routing', 'handoff') then
    return new;
  end if;
  -- O fato de atribuição deve corresponder ao dono real, na MESMA organização
  -- (guarda do trigger irmão fn_interromper_turnos_ao_assumir).
  if not exists (select 1 from public.conversations c
    where c.organization_id = new.organization_id and c.id = new.conversation_id
      and c.assigned_to_user_id = new.to_user_id) then
    return new;
  end if;
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (
    new.organization_id,
    'conversation.atendente_assumiu',
    'conversation',
    new.conversation_id,
    jsonb_build_object(
      'conversation_id', new.conversation_id,
      'assignment_event_id', new.id,
      'to_user_id', new.to_user_id,
      'reason', new.reason
    )
  );
  return new;
end;
$$;

revoke execute on function public.fn_emit_saudacao_na_assumida() from public, anon, authenticated;
grant  execute on function public.fn_emit_saudacao_na_assumida() to service_role;

drop trigger if exists trg_saudacao_na_assumida on public.conversation_assignment_events;
create trigger trg_saudacao_na_assumida
  after insert on public.conversation_assignment_events
  for each row
  execute function public.fn_emit_saudacao_na_assumida();

notify pgrst, 'reload schema';
