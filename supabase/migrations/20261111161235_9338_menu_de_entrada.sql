-- manifest: Menu de entrada determinístico por número (config + opções com FK composta para setores e canal): triagem CNPJ→setor→fila humana sem IA; authenticated só lê, escrita é da rota de settings (manager+)

-- 9338 — menu de entrada (spec 2026-11-11-atendimento-suporte-menu-setores-design.md).
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `menu_de_entrada`: a config POR NÚMERO (channel_session) — ativo,
--      pedir_cnpj, os 8 textos das mensagens (jsonb; schema Zod central em
--      lib/atendimento/menu-de-entrada/schema.ts — nada de texto fixo no
--      comportamento) e o setor padrão (destino quando o cliente não escolhe).
--      `unique (organization_id, channel_session_id)`: um menu por número.
--   2. `menu_de_entrada_opcoes`: as opções numeradas — setor (FK composta),
--      rótulo editável e ordem. O NÚMERO exibido ao cliente é a posição na
--      ordem (1-based), não o valor de `ordem`: reordenar não renumera à mão
--      e empates de ordem não quebram o render. Teto de 8 opções é da rota
--      (Zod); o banco segura as FKs e o setor duplicado.
--
-- ─── Por que FKs compostas ─────────────────────────────────────────────────
--
-- O setor e o canal do menu têm de ser da MESMA organização — o banco segura
-- (régua de attendant_sector_members, 0801). Apagar o setor apaga a opção
-- (cascade); apagar o canal apaga o menu; apagar o setor PADRÃO anula só
-- `setor_padrao_id` (lista de colunas PG15+, padrão 9062 — sem ela o SET NULL
-- tentaria anular organization_id junto).
--
-- Sem `unique (menu_id, ordem)`: trocar duas opções de ordem com unique não
-- deferrable quebraria o UPDATE no meio do swap. A ordem é validada na rota;
-- o render numera pela posição ordenada, então ordem duplicada no banco (só
-- escrevível por service role) é inofensiva.
--
-- ─── RLS ───────────────────────────────────────────────────────────────────
--
-- `authenticated` só LÊ (qualquer membro da org); a escrita é da rota
-- /api/v1/settings/menu-de-entrada (manager+, auditada) — mesmo padrão dos
-- setores (0801): quem configura o menu é quem gerencia, não a anon key.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- Tabelas novas, sem dado legado. `channel_sessions` ganha o unique composto
-- (organization_id, id) — redundante com a PK, é o par que a FK composta
-- referencia; precedente meta_templates (0729). Tudo idempotente, reaplicável
-- pelo update.sh. O recurso é OPCIONAL: sem linha de config, nada muda.

-- Suporte da FK composta para o canal.
do $mig$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'channel_sessions_organization_id_id_key'
       and conrelid = 'public.channel_sessions'::regclass
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_organization_id_id_key unique (organization_id, id);
  end if;
end;
$mig$;

create table if not exists public.menu_de_entrada (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  ativo              boolean not null default false,
  pedir_cnpj         boolean not null default true,
  textos             jsonb not null default '{}'::jsonb,
  setor_padrao_id    uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, channel_session_id),
  unique (organization_id, id),
  foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete cascade
);

-- FK do setor padrão em bloco guardado: `on delete set null (setor_padrao_id)`
-- é PG15+ e o `add constraint` não tem `if not exists`.
do $mig$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'menu_de_entrada_setor_padrao_fk'
       and conrelid = 'public.menu_de_entrada'::regclass
  ) then
    alter table public.menu_de_entrada
      add constraint menu_de_entrada_setor_padrao_fk
      foreign key (organization_id, setor_padrao_id)
      references public.attendant_sectors (organization_id, id)
      on delete set null (setor_padrao_id);
  end if;
end;
$mig$;

-- Sem FK direta para organizations: as compostas (menu, setor) já garantem a
-- organização e a cascata; FK direta a mais faz o PostgREST ver junção
-- ambígua e responder 300 PGRST201 em embed sem nome de FK (lição da 0801/0717).
create table if not exists public.menu_de_entrada_opcoes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  menu_id         uuid not null,
  sector_id       uuid not null,
  rotulo          text not null check (char_length(btrim(rotulo)) between 1 and 60),
  ordem           int not null check (ordem between 0 and 7),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (menu_id, sector_id),
  foreign key (organization_id, menu_id)
    references public.menu_de_entrada (organization_id, id) on delete cascade,
  foreign key (organization_id, sector_id)
    references public.attendant_sectors (organization_id, id) on delete cascade
);

create index if not exists menu_de_entrada_opcoes_menu_ordem
  on public.menu_de_entrada_opcoes (organization_id, menu_id, ordem);

alter table public.menu_de_entrada enable row level security;
alter table public.menu_de_entrada_opcoes enable row level security;

revoke all on public.menu_de_entrada, public.menu_de_entrada_opcoes
  from public, anon, authenticated, service_role;
grant select on public.menu_de_entrada, public.menu_de_entrada_opcoes to authenticated;
grant select, insert, update, delete
  on public.menu_de_entrada, public.menu_de_entrada_opcoes to service_role;

drop policy if exists tenant_isolation_menu_de_entrada_select on public.menu_de_entrada;
create policy tenant_isolation_menu_de_entrada_select on public.menu_de_entrada
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

drop policy if exists tenant_isolation_menu_de_entrada_opcoes_select on public.menu_de_entrada_opcoes;
create policy tenant_isolation_menu_de_entrada_opcoes_select on public.menu_de_entrada_opcoes
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

comment on table public.menu_de_entrada is
  'Menu de entrada determinístico por número (migration 9338). Um por channel_session; textos em jsonb com schema Zod em lib/atendimento/menu-de-entrada/schema.ts. Escrita só pela rota /api/v1/settings/menu-de-entrada (manager+). Sem linha, o fluxo de sempre.';
comment on table public.menu_de_entrada_opcoes is
  'Opções do menu de entrada (migration 9338): setor + rótulo + ordem. O número exibido é a posição ordenada (1-based), teto 8 na rota. Apagar o setor apaga a opção; o menu segue com as restantes.';

notify pgrst, 'reload schema';
