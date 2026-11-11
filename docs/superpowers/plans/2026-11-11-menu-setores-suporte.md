# Atendimento de Suporte (menu de setores, empresa por CNPJ, registro) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mesa de suporte no WhatsApp: menu determinístico CNPJ→setor→fila humana (sem IA), saudação automática na assumida, registro título+conteúdo+desfecho ao fechar, empresa vinculada a tarefas/atendimentos, preset de tela "suporte" e som de entrada na fila.

**Architecture:** Estende o que existe: setores/filas/routing (`lib/routing/`), ponto único de atribuição (`fn_conversation_assign` → `conversation_assignment_events`), demandas/sessões de serviço (`fn_demanda_encerrar`, `fn_service_status`), empresas B2B (`lib/crm-b2b/`), interface por org (`lib/navigation/interface.ts`), envio canônico (`sendMessageHandler` + janela/pacing/`sendWithLedger`). Peças novas: porteiro do menu (handler no dispatcher + gate no drain, padrão `deveCederTurnoAoRetorno`), trigger+handler da saudação, coluna de registro na demanda, FKs de empresa, preset `suporte`, hook de som.

**Tech Stack:** Next.js 16 App Router, React 19, TS 6 estrito, Supabase Postgres (RLS), Zod 4, Vitest 4, Playwright, event_log + workers.

**Spec:** `docs/superpowers/specs/2026-11-11-atendimento-suporte-menu-setores-design.md`

## Global Constraints

- PT-BR em código/símbolos; kebab-case em arquivos; alias `@/`; JSON da API snake_case; `ok()`/`fail()` de `lib/api/wrappers.ts`; nunca `throw` cru na borda.
- Toda tabela tenant-aware: `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`. Service role filtra org manualmente, org de fonte confiável (nunca do body).
- Schema em TRIPLA: migration `<timestamp>_<NNNN>_<slug>.sql` com `-- manifest: <o quê e por quê>` + apêndice idempotente no `supabase/baseline.sql` (blocos `-- ---- <coisa> (migration NNNN) ----`). NNNN/timestamp provisórios começando em 9332; validar com `pnpm checar:colisao-de-migration` e renumerar (NNNN+timestamp juntos) se colidir. Nunca editar migration aplicada.
- Função nova em `public`: `revoke execute ... from public, anon` E `grant` só a quem precisa (duas origens). Trigger NUNCA faz HTTP — emite linha em `event_log`.
- Mutantes `app/api/v1`: `requireSupportWrite()` antes do efeito + `requireRole()` + Zod em todo input + `audit()` fire-and-forget.
- Mensagem ao cliente SEMPRE pela cadeia canônica: `sendMessageHandler` + janela (`decidirAdiamentoPorJanela`) + pacing (`criarPacingDoCanal`) + `sendWithLedger` (idempotência). Sem bypass, sem `console.log` (logger estruturado).
- Nada de marca do produto em texto ao usuário; `[empresa]` resolve do banco (`lib/branding/`).
- Todo `t("…")` novo de UI: entrada `"texto pt": { es: "…" }` em `lib/i18n/dicionario.ts` (gate `i18n-espanhol-cobre-a-tela`).
- Tela nova: porta no `NAV_CATALOG` (`lib/navigation/catalogo.ts`, grupo `organizacao` exige `section`). Seções dentro de página existente não precisam.
- `typecheck` nesta máquina: `NODE_OPTIONS=--max-old-space-size=4096` (6.6GB RAM; CI usa 8192).
- TDD: teste falhando primeiro, ver falhar, implementar, ver passar, commit por task. `pnpm test:unit` SEM caminho. Sabotar o conserto antes de declarar pronto (skill contribuir passo 5).
- Commits: conventional commits PT-BR; identidade `jonathanflorianojankowski@gmail.com`; push só na branch do fork (`origin`), nunca `main`.

## Review Focus

1. **Cliente preso no menu** (CNPJ nunca válido / resposta sempre inválida / áudio): a máquina DEVE terminar em fila humana após os limites de tentativa — teste com 3+ entradas inválidas consecutivas e com payload sem texto.
2. **Corrida de inbound** (duas mensagens quase simultâneas / retry do dispatcher): estado do menu + `sendWithLedger` não podem duplicar mensagem nem pular etapa — teste de idempotência por (conversa, etapa, mensagem).
3. **Saudação duplicada ou indevida** (transferência em cadeia, release, atribuição à IA, conversa fechada): trigger filtra motivo/destino; handler idempotente por `assignment_event_id` — testes para cada caso.
4. **Fechamento com demanda stale** (dois atendentes, ou demanda já encerrada): `expected_revision`/PT409 → 409 sem fechar a conversa; sem demanda atual → fecha como hoje — testes de ordem e conflito.
5. **Vazamento LGPD do registro** (anonimização/export): `resumo_encerramento` redigido no anonimizar e presente no export — invariante com banco real.

---

### Task 1: Schema — tabelas do menu de entrada

**Files:**
- Create: `supabase/migrations/<ts>_9332_menu_de_entrada.sql`
- Modify: `supabase/baseline.sql` (apêndice)
- Create: `lib/atendimento/menu-de-entrada/schema.ts`
- Test: `lib/atendimento/menu-de-entrada/schema.test.ts`, `tests/invariants/menu-de-entrada-rls.test.ts`

**Interfaces:**
- Produces: tabelas `menu_de_entrada` (`id uuid pk default gen_random_uuid()`, `organization_id`, `channel_session_id uuid not null references channel_sessions(id) on delete cascade`, `ativo boolean not null default false`, `pedir_cnpj boolean not null default true`, `textos jsonb not null default '{}'`, `setor_padrao_id uuid null references attendant_sectors(id) on delete set null`, `created_at/updated_at`, `unique (organization_id, channel_session_id)`) e `menu_de_entrada_opcoes` (`id`, `organization_id`, `menu_id uuid not null references menu_de_entrada(id) on delete cascade`, `sector_id uuid not null references attendant_sectors(id) on delete cascade`, `rotulo text not null`, `ordem int not null`, `unique (menu_id, ordem)`, `unique (menu_id, sector_id)`). RLS `tenant_isolation_menu_de_entrada_all` / `tenant_isolation_menu_de_entrada_opcoes_all` via `fn_user_org_ids()` (copiar padrão exato de `attendant_sectors` no baseline). Índice `(organization_id, channel_session_id)` já coberto pelo unique.
- Produces: `menuTextosSchema` (Zod, 8 chaves da spec §4, `z.string().max(2000)` cada, `.catch` no objeto com defaults semeados), `menuConfigSchema` (`ativo`, `pedir_cnpj`, `textos`, `setor_padrao_id uuid nullable`, `opcoes: array.max(8)` de `{sector_id uuid, rotulo string 1..60, ordem int 0..7}`), `TEXTOS_PADRAO_DO_MENU` (constante de seed — dados, não comportamento), type `MenuConfig`.

- [ ] Step 1: teste falhando — `schema.test.ts`: parse de config vazia aplica defaults (8 textos semeados, `ativo:false`, `pedir_cnpj:true`); rejeita 9 opções; rejeita rótulo vazio; `textos` parcial completa chaves faltantes.
- [ ] Step 2: rodar `pnpm vitest run lib/atendimento/menu-de-entrada/schema.test.ts` → FAIL (módulo não existe).
- [ ] Step 3: implementar `schema.ts` (Zod puro, sem I/O).
- [ ] Step 4: rodar → PASS.
- [ ] Step 5: migration + apêndice baseline (idempotente: `create table if not exists`, policies `drop policy if exists` + create, `revoke`/`grant` conforme padrão das tabelas de setor; sem função nova). `-- manifest: menu de entrada determinístico por número (config + opções com FK para setores), para triagem de suporte sem IA`.
- [ ] Step 6: invariante `menu-de-entrada-rls.test.ts` (padrão dos existentes em `tests/invariants/`): org A não vê config/opções da org B; insert cross-org barrado; delete de setor cascateia opção; delete de channel_session cascateia config. Rodar `pnpm test:db tests/invariants/menu-de-entrada-rls.test.ts` → PASS (Docker ok).
- [ ] Step 7: `pnpm checar:colisao-de-migration` → livre (senão renumerar NNNN+timestamp).
- [ ] Step 8: commit `feat(atendimento): schema do menu de entrada por número (triagem sem IA)`.

### Task 2: Schema — registro de atendimento na demanda + LGPD

**Files:**
- Create: `supabase/migrations/<ts>_9333_registro_de_atendimento.sql`
- Modify: `supabase/baseline.sql` (apêndice)
- Modify: `lib/lgpd/export-collector.ts` (`DemandaRow` ~L575 + select ~L2381)
- Test: `tests/invariants/registro-de-atendimento-lgpd.test.ts`

**Interfaces:**
- Produces: coluna `demandas.resumo_encerramento text null`; `fn_demanda_encerrar(p_org uuid, p_demanda uuid, p_expected bigint, p_desfecho text, p_actor uuid, p_titulo text default null, p_resumo text default null)` — `create or replace` a partir da ÚLTIMA definição do baseline (rfind!), acrescentando: `assunto = coalesce(p_titulo, assunto)`, `resumo_encerramento = p_resumo`, payload da atividade `demand_closed` ganha `'titulo', coalesce(p_titulo, d.assunto)`. Compatível: chamadores de 5 args continuam funcionando. `revoke`/`grant` repetidos (duas origens).
- Produces: trigger de anonimização no padrão `fn_redigir_tarefas_do_contato_anonimizado`: `fn_redigir_demandas_do_contato_anonimizado()` AFTER UPDATE OF `is_anonymized` ON `contacts` WHEN (new.is_anonymized and not old.is_anonymized) → `update demandas set resumo_encerramento = null where organization_id = new.organization_id and contact_id = new.id` (assunto já é redigido pela cascata existente). `revoke execute from public, anon, authenticated` + grant a quem o padrão da casa usa (copiar da fn de tarefas). Trigger `drop trigger if exists` + create.
- Produces: export do titular inclui `resumo_encerramento` (select + `DemandaRow`).

- [ ] Step 1: invariante falhando — cria org+contato+demanda com `resumo_encerramento` e `assunto`; anonimiza o contato (cascata real); asserts: `resumo_encerramento is null`, `assunto is null`, `desfecho/fechada_em` preservados (fato operacional); export-coletor (chamada real se o padrão dos testes permitir, senão assert do select via SQL) contém o campo. Rodar → FAIL (coluna não existe).
- [ ] Step 2: migration + apêndice (coluna `add column if not exists`; RPC `create or replace` copiada da última definição + deltas; trigger idempotente).
- [ ] Step 3: atualizar `export-collector.ts` (select + tipo).
- [ ] Step 4: `pnpm test:db tests/invariants/registro-de-atendimento-lgpd.test.ts` → PASS.
- [ ] Step 5: teste de compatibilidade da RPC no mesmo invariante: chamada com 5 args (sem título/resumo) encerra normal, `assunto` preservado.
- [ ] Step 6: `pnpm checar:colisao-de-migration`; commit `feat(atendimento): registro de atendimento (título+conteúdo) ao encerrar demanda, com LGPD`.

### Task 3: Schema — empresa em tarefas e demandas

**Files:**
- Create: `supabase/migrations/<ts>_9334_empresa_em_tarefas_e_demandas.sql`
- Modify: `supabase/baseline.sql` (apêndice)
- Test: `tests/invariants/empresa-em-tarefas-e-demandas.test.ts`

**Interfaces:**
- Produces: `crm_tasks.company_id uuid null references companies(id) on delete set null` + `demandas.company_id uuid null references companies(id) on delete set null`; índices `(organization_id, company_id)` em ambas. RLS existente cobre (colunas novas, sem policy nova).

- [ ] Step 1: invariante falhando — insert tarefa/demanda com `company_id` de OUTRA org deve falhar (FK não garante org; o teste verifica que a coluna existe e que o handler-level check virá na Task 13 — aqui: FK válida seta, delete da empresa → `set null`, índice existe). Rodar → FAIL.
- [ ] Step 2: migration + apêndice idempotente.
- [ ] Step 3: `pnpm test:db tests/invariants/empresa-em-tarefas-e-demandas.test.ts` → PASS; checker de colisão; commit `feat(crm): empresa cliente vinculável a tarefa e demanda (FK direta)`.

### Task 4: Schema — trigger da saudação na assumida

**Files:**
- Create: `supabase/migrations/<ts>_9335_saudacao_na_assumida.sql`
- Modify: `supabase/baseline.sql` (apêndice)
- Test: `tests/invariants/saudacao-na-assumida-evento.test.ts`

**Interfaces:**
- Produces: `fn_emit_saudacao_na_assumida()` returns trigger, SECURITY DEFINER, `set search_path=public`: AFTER INSERT ON `conversation_assignment_events` FOR EACH ROW WHEN (`new.to_user_id is not null and new.reason in ('claim','transfer','routing','handoff')`) → insert direto em `event_log` (`organization_id`, `event_type='conversation.atendente_assumiu'`, `entity_kind='conversation'`, `entity_id=new.conversation_id`, `payload=jsonb_build_object('conversation_id',new.conversation_id,'assignment_event_id',new.id,'to_user_id',new.to_user_id,'reason',new.reason)`, `status='pending'`) — copiar o padrão de insert de `fn_interromper_turnos_ao_assumir` (última definição). `revoke execute from public, anon, authenticated` (trigger não precisa de grant de execução a roles; copiar padrão da fn irmã). Trigger `trg_saudacao_na_assumida` idempotente.
- Consumes: `fn_conversation_assign` já insere assignment events para todos os motivos (CONFIRMADO); `fn_channel_routing_claim` termina em `fn_conversation_assign(reason 'routing')` (CONFIRMADO) — cobre roteamento automático.

- [ ] Step 1: invariante falhando — via SQL: `fn_conversation_assign` com reason claim → existe event_log `conversation.atendente_assumiu` com payload certo; release (to_user null) → não existe; reason `member_revoked` → não existe. Rodar → FAIL.
- [ ] Step 2: migration + apêndice.
- [ ] Step 3: `pnpm test:db tests/invariants/saudacao-na-assumida-evento.test.ts` → PASS; checker; commit `feat(atendimento): evento de assumida humana no ponto único de atribuição`.

### Task 5: Settings `atendimento` (só humano + saudação) + gate de elegibilidade

**Files:**
- Modify: `lib/schemas/settings.ts` (seção nova no padrão `ouvidoriaSchema`/reader L1158–1181)
- Modify: `lib/ai/elegibilidade/gate.ts`, `lib/ai/elegibilidade/consulta-pg.ts`, `lib/ai/elegibilidade/consulta-supabase.ts` (estado+motivo)
- Create: `app/api/v1/settings/atendimento/route.ts`
- Create: `lib/schemas/atendimento.ts` (schema do PATCH + merge não-destrutivo, padrão `mesclarSettingsDeAtendimento` de `lib/schemas/routing.ts:202`)
- Test: `lib/schemas/atendimento.test.ts`, `lib/ai/elegibilidade/gate.test.ts` (estender), `app/api/v1/settings/atendimento/route.test.ts`

**Interfaces:**
- Produces: `ATENDIMENTO_CHAVE = "atendimento"`; `atendimentoSettingsSchema = z.object({ somente_humano: z.boolean().catch(false), saudacao_na_assumida: z.object({ ativo: z.boolean().catch(false), template: z.string().max(1000).catch("") }).catch({ativo:false, template:""}) }).catch({...})`; reader `atendimentoDeclarado(settings: unknown): AtendimentoSettings` (never-throw, padrão `ouvidoriaDeclarada`); `SAUDACAO_PADRAO = "Olá, meu nome é [nome], como posso ajudar?"` (seed de UI, não comportamento).
- Produces: motivo novo `org_somente_humano` em `decidirElegibilidade` (checado logo após `org_nao_operante`/`canal_desativado`); campo `somenteHumano: boolean` em `EstadoDeElegibilidade`, populado em `montarEstadoDeElegibilidade` a partir de `raw.orgSettings` via `atendimentoDeclarado`. Os dois transports já selecionam `o.settings` (CONFIRMADO) — só propagar.
- Produces: `PATCH /api/v1/settings/atendimento` — `requireSupportWrite` → `requireRole("manager")` → Zod `{somente_humano?: boolean, saudacao_na_assumida?: {ativo?: boolean, template?: string}}` → admin client, merge de 2 níveis preservando irmãos → `audit({action:"settings.atendimento_changed"})` (registrar ação em `lib/audit/actions.ts`) → `ok()`.

- [ ] Step 1: testes falhando — schema: settings vazio → defaults; parcial preserva irmãos; gate: `somenteHumano:true` → `{permite:false, motivo:"org_somente_humano"}` mesmo com resto favorável; `false` → não interfere; rota: 403 viewer, merge preserva `routing`, audit chamado.
- [ ] Step 2: rodar → FAIL.
- [ ] Step 3: implementar (schema → gate → rota).
- [ ] Step 4: rodar → PASS + `pnpm vitest run lib/ai/elegibilidade` (suíte do gate inteira verde).
- [ ] Step 5: commit `feat(atendimento): modo só humano por org e template de saudação da assumida`.

### Task 6: Menu — núcleo puro (estado, parser, render, máquina)

**Files:**
- Create: `lib/atendimento/menu-de-entrada/estado.ts` (reader/writer metadata, padrão `lib/ai/elegibilidade/ia-com-dono.ts`)
- Create: `lib/atendimento/menu-de-entrada/parser.ts`
- Create: `lib/atendimento/menu-de-entrada/render.ts`
- Create: `lib/atendimento/menu-de-entrada/maquina.ts`
- Test: `estado.test.ts`, `parser.test.ts`, `render.test.ts`, `maquina.test.ts` (co-localizados)

**Interfaces:**
- Produces: `CHAVE_DO_MENU = "menu_de_entrada"`; `EstadoDoMenu = { service_revision: number; etapa: "cnpj" | "setor" | "concluido"; tentativas_cnpj: number; tentativas_setor: number; empresa_id: string | null }`; `lerEstadoDoMenu(metadata: unknown, serviceRevision: number): EstadoDoMenu | null` (null se ausente OU revision diferente — sessão nova); `metadataComEstadoDoMenu(metadata, estado)` (preserva outras chaves; `etapa:"concluido"` remove a chave).
- Produces: `parseOpcaoDoMenu(texto: string, opcoes: {sector_id, rotulo, ordem}[]): {sector_id} | null` — casa número da ordem (1-based) OU rótulo normalizado (NFD sem acento, lowercase, trim; "1", "1-", "suporte", "SUPORTE" casam; "4", "oi", "" não).
- Produces: `renderTemplate(template: string, vars: {empresa?, empresa_cliente?, nome?, setor?, opcoes?}): string` — substitui `[empresa]`, `[empresa_cliente]`, `[nome]`, `[setor]`, `[opcoes]` (lista `N - Rótulo` na ordem); placeholder sem valor → remove o token (nunca envia "[nome]" cru).
- Produces: `decidirPassoDoMenu(input: { estado: EstadoDoMenu | null; config: MenuConfig; texto: string | null; empresaConhecida: { id, nome } | null; serviceRevision: number }): PassoDoMenu` — PURO. `PassoDoMenu = { acao: "boas_vindas" | "pedido_cnpj" | "menu" | "seguir_sem_cnpj" | "opcao_invalida" | "rotear" | "setor_padrao" | "nada"; texto: string; proximoEstado: EstadoDoMenu | null; setorId?: string; empresaId?: string }`. Regras (spec §3): estado null + pedir_cnpj → boas_vindas (etapa cnpj, tentativas 0); texto CNPJ válido → menu (etapa setor) + empresaId; inválido com tentativas<2 → pedido_cnpj (incrementa); tentativas>=2 → seguir_sem_cnpj (etapa setor); etapa setor + opção válida → rotear (setorId, estado concluido); inválida tentativas_setor<1 → opcao_invalida (incrementa); >=1 → setor_padrao (setorId=config.setor_padrao_id, concluido); `setor_padrao_id` null → rotear para primeira opção; texto null (áudio/mídia) conta como inválido em ambas as etapas; config sem opções → nada (fail-open).
- Consumes: `normalizeCnpj` de `lib/crm-b2b/normalize.ts` (CONFIRMADO, valida DV).

- [ ] Step 1: testes falhando cobrindo CADA regra acima + Review Focus 1 (3 inválidas seguidas terminam em fila; áudio sem texto termina em fila) e render sem valor.
- [ ] Step 2: rodar → FAIL.
- [ ] Step 3: implementar os 4 módulos (puros, sem I/O).
- [ ] Step 4: rodar → PASS.
- [ ] Step 5: commit `feat(atendimento): núcleo puro do menu de entrada (estado, parser, render, máquina)`.

### Task 7: Menu — empresa por CNPJ (find-or-create + cadeia people + enrich)

**Files:**
- Create: `lib/atendimento/menu-de-entrada/empresa-por-cnpj.ts`
- Test: `lib/atendimento/menu-de-entrada/empresa-por-cnpj.test.ts` (mock supabase no padrão de `companies-handler-cnpj.test.ts`) + `tests/invariants/empresa-por-cnpj-org.test.ts`

**Interfaces:**
- Produces: `vincularEmpresaPorCnpj(admin: SupabaseClient, input: { organizationId: string; contactId: string; cnpj: string; actorUserId?: string | null }): Promise<{ ok: true; empresaId: string; nome: string; criada: boolean } | { ok: false; motivo: "cnpj_invalido" | "contato_de_outra_org" | "erro" }>` — normalizeCnpj → busca `companies` por `(org, normalized_cnpj)`; não achou → insert (`cnpj: formatCnpj`, `normalized_cnpj`, `enrichment_status:"pending"`, `created_by: actorUserId ?? null`, 23505 → re-busca); cadeia: contato (filtra org!) → `person_id` null → cria `people` (`full_name` do contato, `normalized_name`) + update contato; `company_people.upsert({organization_id, company_id, person_id}, {onConflict:"company_id,person_id", ignoreDuplicates:true})`; `void enrichCompanyFromBrasilApi(admin, {organizationId, companyId, cnpj})` fire-and-forget (padrão createCompanyHandler). Nome = `trade_name ?? legal_name ?? formatCnpj`.
- Consumes: `normalizeCnpj`, `formatCnpj`, `normalizePersonName` (crm-b2b/normalize), `enrichCompanyFromBrasilApi` (crm-b2b/enrich) — CONFIRMADOS.

- [ ] Step 1: testes falhando — CNPJ inválido → motivo; empresa existente reusada (sem insert); empresa nova criada + person + company_people + enrich chamado; contato de outra org → recusado; contato já com person_id → não cria person duplicado.
- [ ] Step 2: rodar → FAIL. Step 3: implementar. Step 4: rodar → PASS.
- [ ] Step 5: invariante com banco real: vínculo não vaza cross-org (contato org A + empresa org B → recusa); rodar `pnpm test:db` do arquivo → PASS.
- [ ] Step 6: commit `feat(atendimento): vínculo empresa↔contato por CNPJ sem CRUD (cadeia people + BrasilAPI)`.

### Task 8: Menu — runtime (handler dispatcher + gate do drain + envio canônico)

**Files:**
- Create: `lib/atendimento/menu-de-entrada/envio.ts` (envio canônico com janela/pacing/ledger)
- Create: `lib/atendimento/menu-de-entrada/handler.ts`
- Create: `lib/atendimento/menu-de-entrada/ceder-turno.ts`
- Modify: `lib/event-log/register-handlers.ts` (registrar ANTES do aiResponseHandler, ~L58)
- Modify: `lib/agent-engine/edge/crm/drain.ts` (gate após `deveCederTurnoAoRetorno`, ~L418)
- Test: `handler.test.ts`, `envio.test.ts`, `ceder-turno.test.ts` (co-localizados)

**Interfaces:**
- Produces: `enviarTextoDoMenu(admin, input: { organizationId, conversationId, contactId, channelSessionId, body, chaveIdempotencia: string, metadata: Record<string,unknown> }): Promise<"sent" | "queued" | "adiado" | "bloqueado" | "erro">` — copia a ordem de `enviarTextoFixoPendente` (CONFIRMADO): `decidirAdiamentoPorJanela` → `criarPacingDoCanal`/`ritmoDoCanal.decide` → `sendWithLedger(supabaseSendLedger(admin), {tenantId, leadId:contactId, jobId:chaveIdempotencia (uuid), seq:1, body}, (key,messageId) => sendMessageHandler(admin, {organization_id, actor:{type:"webhook_source", id:"menu-de-entrada"}, internalMessageId:messageId, requestId:key}, {conversation_id, type:"text", body, metadata:{...metadata, idempotency_key:key}}))` → `registraEnvio`. `chaveIdempotencia` = uuid determinístico derivado de (conversationId, service_revision, etapa, inbound_message_id) — via `crypto.randomUUID` não serve (não-determinístico): usar hash sha256 hex → uuid v4-like (padrão de derivação existente no repo, procurar `createHash("sha256")` em lib/; senão uuid v5 com namespace fixo). Adiamento por janela/pacing → `"adiado"` (handler devolve retry).
- Produces: `menuDeEntradaHandler: EventHandler` — key `"menu-de-entrada.v1"`, events `["message.received"]`, `naOrgParada:"pula"`. handle(row): carrega config por `channel_session_id` (join conversation) + módulo `setores` ligado (`moduloLigado`); sem config/ativo → skipped. Carrega conversa (status, assignee, sector, service_revision, metadata, is_group) + contato (is_blocked) + texto do inbound (`textoDoPayloadInbound(row.payload)`, fallback linha de messages). Pula: grupo, bloqueado, `assignee_kind='user'` com dono, status fora de open/pending (salvo estado ativo da mesma revision). Estado = `lerEstadoDoMenu`; elegível para iniciar = sem dono && status open/pending && (estado null || revision nova). `decidirPassoDoMenu` → se acao rotear/setor_padrao: `vincularEmpresaPorCnpj` quando empresaId (etapa cnpj válida) ANTES, `definirSetorDaConversa(admin, {origem:"automacao", ...})` (assinatura exata em `lib/atendimento/setor-da-conversa.ts` — ler no local), status→pending + `bot_silenced_until='infinity'` (update via admin, org filtrada) + emitir `conversation.routing_requested` se o escritor já não emite (ler `definirSetorDaConversa` — CONFIRMAR no local; não duplicar evento). Envia texto via `enviarTextoDoMenu`; `"adiado"` → `{status:"retry", retry_at}`; sucesso → grava `metadataComEstadoDoMenu` (update conversations.metadata preservando o resto — ler-modificar-escrever na mesma linha que o handler acabou de ler; corrida: update condicional `.eq("service_revision", lida)` e re-leitura se 0 linhas). Review Focus 2.
- Produces: `deveCederTurnoAoMenu(pool: Pick<pg.Pool,"query">, pedido: { organizationId, conversationId }): Promise<boolean>` — fail-open (try/catch → false); true quando config ativa para o canal da conversa E (estado do menu ativo na revision atual OU conversa elegível para iniciar: sem dono, sem setor, status open/pending, não grupo). Chamado no drain logo após `deveCederTurnoAoRetorno` → `return 'processado'` com log.info (padrão exato do slot).
- Consumes: Tasks 1, 6, 7; `sendMessageHandler`, `sendWithLedger`, `decidirAdiamentoPorJanela`, `criarPacingDoCanal`, `definirSetorDaConversa`, `moduloLigado`, `textoDoPayloadInbound`.

- [ ] Step 1: testes falhando — handler: sem config → skipped; grupo/bloqueado → skipped; primeira mensagem → envia boas-vindas + grava estado etapa cnpj; CNPJ válido → vincula + envia menu; "1" → setor+pending+silenced+estado concluido; inválido 2× → setor padrão; áudio (texto null) → conta inválido; janela adia → retry sem gravar estado; re-execução same inbound → ledger não duplica (mock sendWithLedger already_sent). Gate: config ativa+estado → true; sem config → false; erro de banco → false (fail-open).
- [ ] Step 2: rodar → FAIL. Step 3: implementar envio → handler → gate → registros. Step 4: rodar → PASS + `pnpm vitest run lib/event-log lib/agent-engine/edge/crm/drain` (existentes verdes).
- [ ] Step 5: commit `feat(atendimento): porteiro determinístico do menu (dispatcher + drain), fila humana sem IA`.

### Task 9: Saudação — handler do evento de assumida

**Files:**
- Create: `lib/atendimento/saudacao-na-assumida.ts`
- Modify: `lib/event-log/register-handlers.ts`
- Test: `lib/atendimento/saudacao-na-assumida.test.ts`

**Interfaces:**
- Produces: `saudacaoNaAssumidaHandler: EventHandler` — key `"saudacao-assumida.v1"`, events `["conversation.atendente_assumiu"]`, `naOrgParada:"pula"`. handle: payload `{conversation_id, assignment_event_id, to_user_id, reason}`; carrega org settings (`atendimentoDeclarado`) — `saudacao_na_assumida.ativo` false → skipped; conversa (org filtrada): status closed/archived → skipped; `assigned_to_user_id !== to_user_id` (assumida desfeita) → skipped; `assigned_to_user_name` null → fallback `nomesDosAtendentes` (padrão com-nome-do-atendente) → ainda null → skipped com log.warn; render `renderTemplate(template, {nome, empresa: marcaDaOrganizacao(...)})` (branding de `lib/branding/instalacao.ts` — ler assinatura no local); envio via `enviarTextoDoMenu`-like com `chaveIdempotencia = assignment_event_id`, `seq:1`, actor `{type:"webhook_source", id:"saudacao-assumida"}`, metadata `{saudacao_assumida:true, assignment_event_id}`. Reusa o helper de envio da Task 8 (generalizar nome: `enviarTextoDeSistema` em `lib/atendimento/envio-de-sistema.ts` — mover na Task 9 e ajustar imports da Task 8).
- Consumes: Tasks 4, 5, 8 (envio), `renderTemplate` (Task 6).

- [ ] Step 1: testes falhando — desligado → skipped; conversa fechada → skipped; dono mudou → skipped; nome presente → envia com [nome] renderizado; idempotência: mesmo assignment_event_id reprocessado → ledger already_sent, sem segundo envio; template vazio → skipped.
- [ ] Step 2: rodar → FAIL. Step 3: implementar (extrair envio comum primeiro, testes da Task 8 seguem verdes). Step 4: rodar → PASS.
- [ ] Step 5: commit `feat(atendimento): saudação automática quando um atendente assume (todos os caminhos)`.

### Task 10: Close com registro (API)

**Files:**
- Modify: `app/api/v1/conversations/[id]/close/route.ts`
- Test: `app/api/v1/conversations/[id]/close/route.test.ts` (estender existente; se não existir, criar no padrão dos route.test vizinhos)

**Interfaces:**
- Consumes: `fn_demanda_encerrar` 7-arg (Task 2), `fn_service_status` (inalterada).
- Produces: body ganha `registro: z.object({ titulo: z.string().trim().min(1).max(200), conteudo: z.string().max(5000).optional(), desfecho: z.enum([...vocabulário existente...]).default("resolvida") }).optional()`. Fluxo: guards existentes → se `registro` && conversa tem `current_demanda_id`: ler demanda (org filtrada, `revision`) → `fn_demanda_encerrar(p_org, p_demanda, p_expected=revision, p_desfecho, p_actor=user.id, p_titulo=titulo, p_resumo=conteudo ?? null)`; PT409/40001 → `fail("conflict", ..., 409)` SEM fechar; P0002 → segue sem registro (demanda sumiu) → close normal. Depois `fn_service_status` closed (ordem: encerrar ANTES de fechar — o close escreve proximo_passo de lembrete se demanda aberta). `devolver_ao_automatico` existente intacto (ordem: devolve → encerra demanda → fecha). audit metadata ganha `{registro: true, desfecho}` quando houve. Sem registro ou sem demanda → comportamento atual byte-compatível.

- [ ] Step 1: testes falhando — com registro: rpc encerrar chamado com título/conteúdo ANTES do fn_service_status (ordem por mock calls); conflito PT409 → 409 e fn_service_status NÃO chamado; sem current_demanda_id → só close; sem registro → payload atual inalterado; devolver_ao_automatico + registro → ordem devolve→encerra→fecha.
- [ ] Step 2: rodar → FAIL. Step 3: implementar. Step 4: rodar → PASS + suíte do diretório close.
- [ ] Step 5: commit `feat(inbox): fechamento de conversa registra título, conteúdo e desfecho na demanda`.

### Task 11: UI — diálogo de fechamento com registro

**Files:**
- Modify: `components/inbox/ConversationHeader.tsx` (dialog ~L911–997)
- Modify: `hooks/inbox/useCloseConversation.ts` (`CloseArgs` + corpo)
- Modify: `lib/i18n/dicionario.ts` (es de cada t() novo)
- Test: `components/inbox/ConversationHeader.registro.test.tsx` (padrão dos testes de componente existentes; gate `inbox-barra-enxuta-3003` segue verde)

**Interfaces:**
- Consumes: API Task 10; `conversation.current_demanda_id`, `service_revision`; dados da demanda para pré-preencher título: do `CRMSidePanel`? Não — o header busca via `apiClient.get("/api/v1/demandas/" + current_demanda_id)` ao abrir o diálogo (rota GET existente — CONFIRMAR que existe GET; se não, pré-preencher vazio e deixar título obrigatório).
- Produces: `CloseArgs.registro?: { titulo: string; conteudo?: string; desfecho?: string }`. Dialog: quando `current_demanda_id` presente → seção `data-testid="registro-ao-fechar"` com Input título (obrigatório, maxLength 200), Textarea conteúdo (opcional, maxLength 5000), Select desfecho (opções do vocabulário com rótulos PT: resolvida→"Resolvida", nao_procede→"Não procede", encerrada_pelo_cliente→"Encerrada pelo cliente", perdida→"Perdida", convertida→"Convertida", expirada_sem_resposta→"Expirada sem resposta"; default resolvida). Botão Fechar desabilitado com título vazio (quando seção visível). Sem demanda → diálogo atual intacto.

- [ ] Step 1: teste falhando — com current_demanda_id: campos renderizam, Fechar habilita só com título, mutate recebe registro; sem demanda: nada de registro, payload antigo.
- [ ] Step 2: rodar → FAIL. Step 3: implementar + es no dicionário. Step 4: rodar → PASS + `pnpm vitest run components/inbox` verde.
- [ ] Step 5: commit `feat(inbox): diálogo de fechamento captura o registro do atendimento`.

### Task 12: Empresa no inbox — exibição + vínculo manual por CNPJ

**Files:**
- Modify: handler de `app/api/v1/contacts/[id]/crm-summary` (localizar via grep `crm-summary`) — adicionar `empresa: {id, nome, cnpj} | null` (cadeia person→company_people→companies, `is_primary` preferido; org filtrada)
- Create: `app/api/v1/contacts/[id]/company-by-cnpj/route.ts` (POST)
- Modify: `components/inbox/CRMSidePanel.tsx` (módulo `contato`, ~L1074–1123)
- Create: `components/inbox/DialogoVincularEmpresa.tsx` (padrão `DialogoMoverParaFila`)
- Modify: `lib/i18n/dicionario.ts`
- Test: route.test.ts + teste de componente do diálogo

**Interfaces:**
- Consumes: `vincularEmpresaPorCnpj` (Task 7).
- Produces: POST body `{cnpj: string}` → guards (`requireSupportWrite`, `requireRole("agent")`, Zod) → contato da org (session client) → `vincularEmpresaPorCnpj` → `audit({action:"contacts.company_linked_by_cnpj"})` (registrar em actions.ts) → `ok({empresa})`; motivos → `fail` 422/404. Diálogo: input CNPJ + erro inline + sucesso → `recarregar()` do painel. Card contato: linha "Empresa: <nome>" (ou botão "Vincular empresa por CNPJ" quando null e role agent+).

- [ ] Step 1: testes falhando (rota: 403 viewer, 422 cnpj inválido, sucesso audita; componente: abre, envia, mostra erro). Step 2: FAIL. Step 3: implementar + es. Step 4: PASS.
- [ ] Step 5: commit `feat(inbox): empresa cliente visível na conversa e vínculo por CNPJ em um campo`.

### Task 13: Tarefas — company_id (API + seletor + filtro)

**Files:**
- Modify: `app/api/v1/tasks/route.ts` (criacaoSchema + listaSchema + insert + auto-fill), `app/api/v1/tasks/[id]/route.ts` (PATCH company_id)
- Create: `lib/tarefas/empresa.ts` (`conferirEmpresa` no padrão `lib/tarefas/demanda.ts`; `empresaHerdada` de demanda/contato)
- Create: `components/tasks/SeletorDeEmpresa.tsx` (combobox busca debounce `GET /api/v1/companies?search=`, módulo B2B aware — esconde se desligado; padrão de busca de `app/app/companies/_client.tsx`)
- Modify: `app/app/tasks/_components/FormularioDeTarefa.tsx` (prop `companyId` + seletor após Responsável), `TarefasClient.tsx` (filtro empresa via prop `empresas` do server page, padrão `funis`), `hooks/tasks/useTasks.ts` (`FiltrosDeTarefa.company_id`), `app/app/tasks/page.tsx` (carrega empresas p/ filtro)
- Modify: `lib/i18n/dicionario.ts`
- Test: `lib/tarefas/empresa.test.ts`, route.test (estender), teste do seletor

**Interfaces:**
- Consumes: coluna Task 3; `GET /api/v1/companies?search=&limit=` (existente, módulo-gated).
- Produces: POST/GET/PATCH aceitam `company_id uuid nullable`; POST valida org da empresa (`conferirEmpresa`, 422 se de fora); auto-fill: `company_id` ausente && `demanda_id` presente → herda `demandas.company_id`; senão `contact_id` → cadeia person (reusar consulta da Task 12 em helper). GET filtro `company_id` → `.eq`. Lista de tarefas retorna `company_id` + embed `company:companies(id, trade_name, legal_name)` (nome exibido no card/lista).

- [ ] Step 1: testes falhando (schema, cross-org 422, auto-fill demanda/contato, filtro). Step 2: FAIL. Step 3: implementar + es. Step 4: PASS + `pnpm vitest run app/api/v1/tasks lib/tarefas components/tasks`.
- [ ] Step 5: commit `feat(tarefas): empresa cliente na tarefa — seletor, filtro e herança automática`.

### Task 14: Ficha da empresa — atendimentos + tarefas + seletor na demanda

**Files:**
- Modify: `lib/crm-b2b/companies-handler.ts` (`getCompanyHandler` += `demandas` (company_id, limit 50, order aberta_em desc, campos: id, assunto, estado, desfecho, aberta_em, fechada_em, resumo_encerramento, dono_user_id) + `tarefas` (company_id, limit 50))
- Modify: `app/app/companies/[id]/_client.tsx` (cards "Atendimentos" e "Tarefas" no grid, full-width como Telefones)
- Modify: `app/api/v1/demandas/[id]/route.ts` (patchSchema ganha ramo `{company_id: uuid nullable}` — valida org via conferirEmpresa; audit `demanda.company_changed`)
- Modify: `components/inbox/CRMSidePanel.tsx` (módulo demandas: seletor de empresa compacto por demanda, reusa SeletorDeEmpresa)
- Modify: `lib/i18n/dicionario.ts`
- Test: companies-handler.test (estender), route.test demandas, componente

**Interfaces:**
- Consumes: Tasks 3, 13 (`SeletorDeEmpresa`, `conferirEmpresa`).
- Produces: GET company retorna `{company, people, contacts, demandas, tarefas}`; card Atendimentos lista título (assunto ?? "Sem título"), desfecho traduzido, data, link p/ contato; card Tarefas lista título+status, link p/ /app/tasks. PATCH demanda company_id → ok(demanda).

- [ ] Step 1: testes falhando. Step 2: FAIL. Step 3: implementar + es. Step 4: PASS.
- [ ] Step 5: commit `feat(empresas): histórico de atendimentos e tarefas na ficha do cliente`.

### Task 15: Preset `suporte` + telas de configuração

**Files:**
- Modify: `lib/navigation/interface.ts` (enum + `SUPORTE` + branches em `destinosDaInterface`/`combinarInterfaces` ~L176,235,250–316), `components/team/InterfaceEditor.tsx` (option), `lib/i18n/dicionario.ts`
- Create: `app/api/v1/settings/menu-de-entrada/route.ts` (GET por org lista configs+opções por número; PUT `{channel_session_id, ativo, pedir_cnpj, textos, setor_padrao_id, opcoes}` upsert transacional — delete+insert opções na mesma transação via rpc? NÃO: sem função nova, fazer upsert config + delete opções ausentes + upsert restantes com admin, validando setores da org ANTES (422 nomeando os de fora, padrão uuid[] aceito); `requireRole manager` + módulo setores gate + audit `settings.menu_de_entrada_changed`)
- Create: `app/app/settings/atendimento/menu-de-entrada/page.tsx` + `_client.tsx` (seletor de número, toggles, 8 textareas, editor de opções com setor/rotulo/ordem, setor padrão; padrão `_channels-form.tsx` + `SectorsClient.tsx`)
- Modify: `lib/navigation/catalogo.ts` (porta `/app/settings/atendimento/menu-de-entrada`, grupo organizacao, section "Sua empresa", minRole manager), `app/app/settings/atendimento/page.tsx` (cards saudação + só humano + link "Menu de entrada")
- Create: `app/app/settings/atendimento/_saudacao-form.tsx`, `_somente-humano-form.tsx` (PATCH Task 5, padrão `_form.tsx`)
- Test: `lib/navigation/interface.test.ts` (estender), route.test menu config, componentes

**Interfaces:**
- Produces: preset `"suporte"` → `SUPORTE = ["/app/inbox","/app/tasks","/app/contacts","/app/companies","/app/connections","/app/settings/atendimento"]` (+ essenciais automáticas; portas de módulo off somem pelo filtro existente — CONFIRMAR comportamento com `modulos` em `destinosDaInterface`). `combinarInterfaces`: preset sobrevive quando nenhum lado escolheu destinos à mão (estender a lógica `soPreset` para incluir suporte).
- Produces: API menu config (acima). UI semeia `TEXTOS_PADRAO_DO_MENU` ao ligar pela primeira vez (textos vazios → defaults no formulário, editáveis).

- [ ] Step 1: testes falhando — interface: preset suporte resolve destinos certos, interseção org∩membro, essenciais nunca somem, module-off filtra companies; rota: 403 viewer, 404 módulo off, PUT valida setores cross-org (422), upsert preserva outras configs; UI: option renderiza.
- [ ] Step 2: FAIL. Step 3: implementar + es + porta no catálogo. Step 4: PASS + `pnpm vitest run tests/unit/navegacao-completude.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts lib/navigation`.
- [ ] Step 5: commit `feat(interface): preset suporte e configuração do menu, saudação e modo só humano pela tela`.

### Task 16: Som de entrada na fila

**Files:**
- Modify: `hooks/inbox/recargaDasConversas.ts` (invalidar também `["conversation-counts"]`)
- Create: `hooks/inbox/useSomDaFila.ts`
- Create: `components/inbox/BotaoSomDaFila.tsx`
- Modify: `components/inbox/InboxLayout.tsx` (header da lista ~L962–987, ao lado de BotaoIniciarConversa)
- Modify: `lib/i18n/dicionario.ts`
- Test: `hooks/inbox/useSomDaFila.test.ts`, componente

**Interfaces:**
- Consumes: `useConversationCounts` (canônica, polling 30s + invalidações), `playSound("attention")`, `resumeAudio()` (`lib/notifications/sounds.ts`).
- Produces: `useSomDaFila(orgId, ligado: boolean)` — ref último valor; quando `fila` AUMENTA vs ref → `playSound("attention")` com intervalo mínimo 2s entre toques (ref timestamp); diminui/igual → nada; primeiro mount → só registra baseline (não toca ao abrir a tela); `ligado` false → nada. Persistência: `localStorage["som-da-fila"] = "1"/"0"` (por navegador). Botão: toggle com `aria-pressed`, título PT/es, clique liga → `resumeAudio()` (unlock autoplay) + toast curto; estado inicial do localStorage.
- Review Focus: rajada de entradas → 1 som (intervalo mínimo); abrir o app com fila existente → silêncio.

- [ ] Step 1: testes falhando (mock playSound): aumento toca; abertura com fila>0 não toca; queda não toca; rajada <2s toca 1; desligado não toca; realtime invalida counts (teste da recarga).
- [ ] Step 2: FAIL. Step 3: implementar + es. Step 4: PASS + `pnpm vitest run hooks/inbox components/inbox`.
- [ ] Step 5: commit `feat(inbox): som de notificação quando um cliente entra na fila`.

### Task 17: Jornada e2e + prova visual + release + mapa

**Files:**
- Create: `tests/e2e/atendimento-suporte-menu.spec.ts`
- Modify: `.github/workflows/e2e.yml` (spec em `SPECS_PARTE_N` — gate `e2e-cobertura-completa` cobra)
- Create: `evidence/atendimento-suporte/` (screenshots/trace)
- Create: `.changes/menu-setores-suporte.md` (`impacto: capacidade_nova`, `secao: adicionado`, título na voz do operador, crédito @jonathanfjankowski)
- Modify: `docs/architecture/` (mapa JSON da peça nova com ≥2 arestas — padrão dos existentes, sem re-render archify)
- Modify: `docs/testing/user-journey-map.md` (casos da jornada)

**Interfaces:**
- Consumes: tudo anterior. Jornada e2e (padrão das specs existentes que simulam inbound — ler `tests/e2e/inbox-*.spec.ts` para o helper de webhook/DB): liga módulo setores + cria setor + menu config via API/UI → inbound "oi" → afirma bolha de boas-vindas/CNPJ → inbound CNPJ → menu → inbound "1" → conversa na fila do setor (status pending, sector_id) → claim pela UI → saudação com nome do atendente → fechar com registro → demanda encerrada com título/conteúdo → ficha da empresa mostra atendimento. Som: teste unit já cobre; e2e stub de AudioContext no padrão `sons-dos-avisos.spec.ts` se incluído.
- Prova visual DoD 12: ambiente fresco (baseline + bootstrap-owner, `next build && next start`, envs opcionais ausentes) dirigindo a tela como leigo: configurar menu pela UI, preset suporte, jornada completa, screenshots em `evidence/`. Receita: `.agents/skills/deskcomm-contribuir/references/receita-e2e-local.md`.

- [ ] Step 1: escrever spec e2e; rodar local contra ambiente fresco → vermelho/verde conforme implementação; ajustar.
- [ ] Step 2: prova visual completa com evidência versionada.
- [ ] Step 3: fragmento + `pnpm release:conferir`; mapa + journey map.
- [ ] Step 4: gates finais: `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`, `pnpm test:unit` (rodapé é autoridade), `pnpm test:db`, `pnpm build`, `bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh`.
- [ ] Step 5: sabotagem (skill contribuir passo 5): reverter linha-chave (ex.: filtro do trigger da saudação), prever contagem vermelha, rodar, conferir, restaurar.
- [ ] Step 6: Living System Checklist respondido com artefatos concretos (spec §11) no corpo do PR; commit final; push da branch pro fork; PR com "O que NÃO medi" honesto.

---

## Self-review (feito na escrita)

- Cobertura da spec: §3 jornada → Tasks 6–9; §4 mensagens → Tasks 1,6,15; §5 registro → 2,10,11,14; §6 empresa → 3,7,12,13,14; §7 preset → 15; §8 som → 16; §10 corte → 17 + constraints por task. Fora de escopo respeitado (sem tela de listagem, sem push, sem IA pós-menu).
- Consistência de nomes: `vincularEmpresaPorCnpj`, `decidirPassoDoMenu`, `renderTemplate`, `lerEstadoDoMenu`, `enviarTextoDoMenu`→generalizado `enviarTextoDeSistema` (Task 9 move; Task 8 importa do path final — ajustar no momento), `atendimentoDeclarado`, `SUPORTE`, `menuDeEntradaHandler`, `saudacaoNaAssumidaHandler`, `deveCederTurnoAoMenu`.
- Review Focus 1–5 têm testes nomeados nas Tasks 6, 8, 9, 10, 2 respectivamente.
- Riscos declarados: assinatura exata de `definirSetorDaConversa` e emissão de routing (Task 8 Step 3 CONFIRMA no local); GET demanda por id para pré-preencher título (Task 11 confirma); derivação de uuid determinístico para o ledger (Task 8 procura padrão existente).
