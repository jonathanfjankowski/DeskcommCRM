-- manifest: Registro de atendimento: demandas.resumo_encerramento (conteúdo) + fn_demanda_encerrar aceita título/conteúdo (7 args, compatível com 5) + trigger de anonimização redige o conteúdo; título reusa assunto

-- 9339 — registro de atendimento (spec 2026-11-11-atendimento-suporte-menu-setores-design.md §5).
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `demandas.resumo_encerramento text` — o CONTEÚDO do registro ("o que
--      foi conversado"), gravado no encerramento. O TÍTULO reusa `assunto`
--      (coluna existente, já redigida pela cascata LGPD e já no export do
--      titular) — DIRC: integrar, não duplicar.
--   2. `fn_demanda_encerrar` ganha `p_titulo`/`p_resumo` (default null):
--      `assunto = coalesce(p_titulo, assunto)` e `resumo_encerramento =
--      p_resumo`. A atividade `demand_closed` passa a carregar o título no
--      payload (a timeline mostra; o registro completo vive na demanda —
--      source of truth).
--   3. Trigger `trg_redigir_demandas_ao_anonimizar` na transição
--      `is_anonymized false→true` de contacts: redige o conteúdo por QUALQUER
--      caminho que anonimize, não só a cascata (mesmo padrão e mesma razão do
--      trigger de tarefas, 0659/0280). O assunto já é redigido pela cascata;
--      aqui só o conteúdo novo. Fato operacional (desfecho, estado, datas)
--      é PRESERVADO.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- A assinatura antiga (5 args) é DROPPADA antes do create: `create or replace`
-- com args a mais criaria um OVERLOAD, e chamadores de 5 args continuariam
-- caindo na função velha (sem registro). Com o drop, a resolução por defaults
-- leva todos os chamadores à função nova — o comportamento de 5 args é o de
-- sempre (assunto preservado, resumo null). O invariante
-- registro-de-atendimento-lgpd prova os dois lados.
--
-- Coluna nova NULÁVEL, sem backfill: nenhuma demanda existente muda. Tudo
-- idempotente, reaplicável pelo update.sh.

alter table public.demandas add column if not exists resumo_encerramento text;

comment on column public.demandas.resumo_encerramento is
  'Conteúdo do registro de atendimento (migration 9339): o que foi conversado, escrito pelo atendente ao encerrar. O título é demandas.assunto. Dado pessoal quando aponta para um contato: a cascata LGPD e o trigger trg_redigir_demandas_ao_anonimizar o apagam na anonimização; desfecho/estado/datas são preservados (fato operacional).';

drop function if exists public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid);

create or replace function public.fn_demanda_encerrar(p_org uuid,p_demanda uuid,p_expected bigint,p_desfecho text,p_actor uuid,p_titulo text default null,p_resumo text default null)
returns public.demandas language plpgsql security definer set search_path=public as $$
declare d public.demandas; pre_contact uuid;
begin
 if p_desfecho not in ('resolvida','convertida','nao_procede','encerrada_pelo_cliente','perdida','expirada_sem_resposta') then
  raise exception 'invalid_desfecho' using errcode='22023'; end if;
 select * into d from public.demandas where id=p_demanda and organization_id=p_org;
 if not found then raise exception 'demanda_not_found' using errcode='P0002'; end if;
 pre_contact:=d.contact_id;
 perform public.fn_service_lock(p_org,d.contact_id);
 select * into d from public.demandas where id=p_demanda and organization_id=p_org for no key update;
 if d.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if d.revision<>p_expected or d.fechada_em is not null then raise exception 'demanda_stale' using errcode='PT409'; end if;
 update public.demandas set revision=revision+1,desfecho=p_desfecho,fechada_em=clock_timestamp(),
  encerrada_por=p_actor,estado=case when p_desfecho in ('resolvida','convertida') then 'resolvida' else 'encerrada' end,
  proximo_passo=null,proximo_passo_em=null,
  assunto=coalesce(p_titulo,assunto),resumo_encerramento=p_resumo,
  updated_at=clock_timestamp()
  where id=p_demanda and organization_id=p_org returning * into d;
 insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,payload,performed_at,performed_by_user_id)
 select p_org,l.id,d.contact_id,'crm',d.id,'demand_closed',jsonb_build_object('demanda_id',d.id,'desfecho',p_desfecho,'titulo',d.assunto),clock_timestamp(),p_actor
 from public.crm_leads l where l.organization_id=p_org and l.contact_id=d.contact_id;
 return d;
end; $$;

revoke execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_demanda_encerrar(uuid,uuid,bigint,text,uuid,text,text) to service_role;

-- O gancho é a transição is_anonymized false→true na própria contacts: roda na
-- MESMA transação e alcança qualquer caminho que anonimize (padrão do trigger
-- de tarefas). Função de trigger não exige EXECUTE de quem dispara o UPDATE;
-- revogar das três origens a mantém fora da lista de exceções do invariante
-- de hardening, que é congelada.
create or replace function public.fn_redigir_demandas_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.demandas
     set resumo_encerramento = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_demandas_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_demandas_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_demandas_ao_anonimizar on public.contacts;
create trigger trg_redigir_demandas_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_demandas_do_contato_anonimizado();

notify pgrst, 'reload schema';
