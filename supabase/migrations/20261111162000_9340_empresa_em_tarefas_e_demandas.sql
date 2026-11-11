-- manifest: empresa cliente (FK composta para companies) em crm_tasks e demandas — o ticket/atendimento aponta direto para o cliente; on delete set null (company_id) preserva o registro

-- 9340 — empresa em tarefas e demandas (spec 2026-11-11 §6).
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
-- `company_id uuid null` em `crm_tasks` e `demandas`, com FK COMPOSTA
-- (organization_id, company_id) → companies(organization_id, id): a empresa
-- do ticket tem de ser da MESMA organização — o banco segura (régua 0801).
--
-- ─── Por que FK direta, e não a cadeia via people ──────────────────────────
--
-- A cadeia contacts.person_id → people → company_people → companies modela
-- "pessoa que trabalha na empresa" — ambígua para "cliente deste atendimento"
-- (uma pessoa pode ter várias empresas; uma tarefa pode ser de outra empresa
-- que a do contato que ligou). O vínculo direto é a source of truth do
-- "cliente deste ticket/atendimento" (DIRC: integrar via FK). A herança
-- automática (demanda → tarefa; contato → demanda) é da camada de aplicação.
--
-- `on delete set null (company_id)`: apagar a empresa NÃO apaga o histórico
-- de atendimentos/tarefas — o registro fica, sem o ponteiro (lista de colunas
-- PG15+, padrão 9062; sem ela o SET NULL anularia organization_id junto).
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- Colunas NULÁVEIS, sem backfill: nenhum registro existente muda. `companies`
-- ganha o unique composto (organization_id, id) — redundante com a PK, é o par
-- que a FK referencia (precedente meta_templates 0729 / channel_sessions 9338).
-- Índices parciais (company_id is not null): a esmagadora maioria das linhas
-- não tem empresa; o índice só cobre quem filtra. Tudo idempotente.

do $mig$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'companies_organization_id_id_key'
       and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
      add constraint companies_organization_id_id_key unique (organization_id, id);
  end if;
end;
$mig$;

alter table public.crm_tasks add column if not exists company_id uuid;
alter table public.demandas add column if not exists company_id uuid;

do $mig$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'crm_tasks_company_fk'
       and conrelid = 'public.crm_tasks'::regclass
  ) then
    alter table public.crm_tasks
      add constraint crm_tasks_company_fk
      foreign key (organization_id, company_id)
      references public.companies (organization_id, id)
      on delete set null (company_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'demandas_company_fk'
       and conrelid = 'public.demandas'::regclass
  ) then
    alter table public.demandas
      add constraint demandas_company_fk
      foreign key (organization_id, company_id)
      references public.companies (organization_id, id)
      on delete set null (company_id);
  end if;
end;
$mig$;

create index if not exists crm_tasks_org_company
  on public.crm_tasks (organization_id, company_id)
  where company_id is not null;

create index if not exists demandas_org_company
  on public.demandas (organization_id, company_id)
  where company_id is not null;

comment on column public.crm_tasks.company_id is
  'Empresa cliente do ticket (migration 9340). FK composta com a organização; null = sem empresa. Herdada da demanda/contato na criação quando ausente; editável pelo seletor. Apagar a empresa anula o ponteiro e preserva a tarefa.';
comment on column public.demandas.company_id is
  'Empresa cliente do atendimento (migration 9340). FK composta com a organização; null = sem empresa. Herdada do contato (cadeia people) quando a demanda nasce de conversa; editável. Apagar a empresa anula o ponteiro e preserva o registro.';

notify pgrst, 'reload schema';
