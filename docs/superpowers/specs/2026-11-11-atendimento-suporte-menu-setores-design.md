# Atendimento de suporte: menu de setores, empresa por CNPJ e registro de atendimento — design

- **Data:** 2026-11-11
- **Status:** aprovado em conversa com o dono (jonathanfjankowski); implementação na branch `feat/menu-setores-suporte` (fork)
- **Contexto de uso:** empresa de TI usando o produto como **mesa de suporte** (não como CRM de vendas). WhatsApp como canal. IA desligada no fluxo de entrada.
- **Precedência:** este design segue `CLAUDE.md` > `docs/specs/`. Onde citar estado de código, marcar CONFIRMADO (medido) vs INFERIDO.

## 1. Problema

Quem instala para suporte precisa de: (a) triagem determinística por setor sem depender de IA; (b) saber qual empresa cliente está chamando, sem cadastro manual; (c) registrar o que foi conversado ao fechar o atendimento; (d) uma tela sem o CRM de vendas; (e) ser avisado quando um cliente entra na fila.

## 2. O que já existe (CONFIRMADO — explorado em 2026-11-11)

| Capacidade | Artefato |
|---|---|
| Setores, membros por setor, horário, cor | `attendant_sectors`, `attendant_sector_members` (módulo opcional `setores`) |
| Fila por setor + distribuição manual/round_robin/load | `lib/routing/` (`decide.ts`, `eligibles.ts`, `worker.ts`), cron `routing-worker`, `channel_routing_policies` |
| Setor da conversa com escritor único | `definirSetorDaConversa` (`lib/atendimento/setor-da-conversa.ts`), `conversations.sector_id`, `metadata.setor_origem` |
| Atribuição/transferência auditadas, ponto único | `fn_conversation_assign` (grava `assigned_to_user_name`), `conversation_assignment_events` |
| Demanda por sessão de serviço | `demandas`, `demanda_conversas`, `conversations.current_demanda_id/service_revision`, `fn_service_inbound/fn_service_status`, `fn_demanda_encerrar` (emite atividade `demand_closed`) |
| Empresas B2B com CNPJ único por org + BrasilAPI | `companies.normalized_cnpj`, `lib/crm-b2b/normalize.ts` (`normalizeCnpj`, alfanumérico), `enrich.ts` (`enrichCompanyFromBrasilApi`, chamada direta), cadeia `contacts.person_id → people → company_people → companies` |
| Menu visível por org/membro | `organizations.interface_settings`, presets `completa`/`simplificada`, `PORTAS_ESSENCIAIS`, `combinarInterfaces` |
| Notas internas, timeline, tarefas | `conversation_notes`, `crm_lead_activities` (`demand_closed` no vocabulário), `crm_tasks` (com `demanda_id`) |
| Som e contagem de fila | `lib/notifications/sounds.ts` (`playSound`, `resumeAudio`), `useConversationCounts` (definição canônica de fila no servidor, `comandosDaFila`), realtime do inbox |
| Gate de elegibilidade da IA | `lib/ai/elegibilidade/gate.ts` (motivos por contato/conversa/canal/org) |
| Detecção de menu de robô alheio (não é envio) | `ehMenuDeOpcoesNumeradas` em `human-handoff.ts` |

**Não existe (CONFIRMADO):** menu numerado determinístico que envia e interpreta; gatilho de saudação na assumida; captura de título/conteúdo no fechamento; `company_id` em `crm_tasks`/`demandas`; preset "suporte"; interruptor "só humano" por org; som de entrada na fila.

## 3. Jornada do cliente (comportamento aprovado)

```
Cliente: oi
Sistema: <boas-vindas + pedido de CNPJ>            [template configurável]
Cliente: 12.345.678/0001-90
Sistema: <saudação com nome da empresa> + <menu>   [templates configuráveis]
         1 - Suporte  2 - Financeiro  3 - Comercial [opções configuráveis]
Cliente: 1
Sistema: <confirmação de fila com nome do setor>   [template configurável]
         → conversa entra na fila do setor (status pending, sem dono)
         → routing-worker distribui (modo da org) ou atendente assume
Atendente assume →
Sistema: <saudação da assumida com [nome]>         [template configurável por org]
```

Regras:
1. **Disparo do menu:** primeira mensagem de conversa nova (sem setor, sem dono, status de fila). Conversa fechada + mensagem nova = nova sessão de serviço → menu de novo, **exceto** se a conversa ficou com o mesmo atendente (`settings.routing.conversation_stays_with_attendant`). Grupos (`is_group`) e contatos bloqueados (STOP) pulam o menu.
2. **Etapa CNPJ** (ligável por número): valida com `normalizeCnpj` (dígitos verificadores, formato alfanumérico incluso). CNPJ válido → find-or-create da empresa por `(org, normalized_cnpj)` + vínculo automático do contato pela cadeia `people`/`company_people` + enriquecimento BrasilAPI fire-and-forget. CNPJ já conhecido → saúda pelo nome (`trade_name`/`legal_name`).
3. **CNPJ inválido:** repete o pedido (até 2 tentativas); depois **segue para o menu sem empresa** com aviso configurável. O atendente pode vincular depois por ação "Vincular empresa por CNPJ" no inbox (um campo, não CRUD).
4. **Etapa setor:** resposta casa por número **ou** rótulo (normalizado, sem acento/caixa). Válida → `definirSetorDaConversa` (origem `automacao`) + confirmação + conversa na fila do setor, bot silenciado na conversa (`bot_silenced_until='infinity'` — fila humana). Inválida → repete o menu 1× com dica; segunda inválida → **setor padrão configurável** + aviso.
5. **Sem IA em nenhum passo do menu.** O porteiro roda antes do LLM (padrão do gate `deveCederTurnoAoRetorno` no drain + handler no dispatcher antes do `aiResponseHandler`). Falha de leitura da config → fail-open (fluxo normal segue; nada morre).
6. **Saudação da assumida:** dispara em TODA atribuição a humano (claim, transferência, roteamento automático, automação, MCP) via evento emitido no ponto único (`conversation_assignment_events` → `event_log` → handler → cadeia de envio normal com throttle/janela/guardrails). Não dispara para IA nem release. Idempotente por evento de atribuição.
7. **Modo só humano (org):** interruptor em Configurações › Atendimento, lido pelo gate de elegibilidade (motivo novo). Com ele ligado, a IA não responde nenhuma conversa da org. O menu funciona com ou sem ele.

## 4. Mensagens: nada hardcoded

Todos os textos ao cliente vivem em configuração no banco, editáveis pela tela. Ao ligar o menu, defaults são **semeados como dados** (o código renderiza config; não embute mensagem fixa no comportamento).

**Menu de entrada (por número / channel_session):**

| Chave | Default semeado |
|---|---|
| `boas_vindas_cnpj` | `Olá, seja bem-vindo à [empresa]! Para agilizar, informe o CNPJ da sua empresa.` |
| `cnpj_conhecido` | `Que bom ter você de volta, [empresa_cliente]! Com qual setor deseja falar?\n[opcoes]` |
| `pedido_cnpj` (repetição) | `Não reconheci esse CNPJ. Pode enviar de novo?` |
| `seguir_sem_cnpj` | `Sem problemas, vamos seguir. Com qual setor deseja falar?\n[opcoes]` |
| `menu_setores` | `Com qual setor deseja falar?\n[opcoes]` |
| `opcao_invalida` | `Não entendi. Responda com o número do setor:\n[opcoes]` |
| `confirmacao_fila` | `Pronto! Você está na fila do [setor]. Em instantes um atendente fala com você.` |
| `aviso_setor_padrao` | `Vou te encaminhar para o [setor]. Em instantes um atendente fala com você.` |

**Saudação da assumida (por org):** `Olá, meu nome é [nome], como posso ajudar?`

**Placeholders:** `[empresa]` (marca da org, resolvida do banco — white-label), `[empresa_cliente]` (nome fantasia/razão social), `[nome]` (atendente, de `assigned_to_user_name`), `[setor]` (nome do setor), `[opcoes]` (lista numerada gerada das opções configuradas, na ordem).

**Opções do menu:** cada opção = setor (FK para `attendant_sectors`) + rótulo editável + ordem; o número sai da ordem. CRUD de setores continua em Equipe › Setores (existente).

## 5. Registro de atendimento (título + conteúdo + desfecho)

- O diálogo "Fechar esta conversa?" ganha: **Título** (obrigatório, curto; reusa `demandas.assunto`, pré-preenchido), **Conteúdo** ("o que foi conversado"; coluna nova `demandas.resumo_encerramento`, opcional para não travar o fechamento), **Desfecho** (vocabulário existente de `demandas.desfecho`, default `resolvida`).
- Ao confirmar: encerra a demanda atual (`fn_demanda_encerrar` estendida com título/conteúdo, parâmetros novos com default — compatível com chamadores atuais) **antes** de fechar a conversa (`fn_service_status`), completando o próximo passo que o banco já escreve hoje ("Revisar atendimento e registrar o desfecho da demanda").
- Sem demanda atual ou sem registro preenchido → fecha como hoje (compatibilidade).
- Timeline: atividade `demand_closed` (já emitida pela RPC) passa a carregar o título no payload; o registro completo vive na demanda (source of truth — DIRC).
- Consulta: ficha da empresa (card "Atendimentos") e ficha/timeline do contato. Sem tela nova de listagem nesta versão.
- **LGPD:** `resumo_encerramento` entra na cascata de anonimização (`fn_lgpd_cascade_redact_contact`, bloco demandas) e no export do titular (`export-collector.ts`). O invariante de descoberta por regex de nomes PII não casa "resumo" — a cobertura é decisão consciente com teste próprio.

## 6. Empresa (cliente) em tarefas e atendimentos

- FK nova `company_id uuid null references companies(id) on delete set null` em **`crm_tasks`** e **`demandas`** + índices por org.
- Vínculo direto é a source of truth do "cliente deste ticket/atendimento" (a cadeia via `people` é ambígua — pessoa com várias empresas); preenchimento automático: tarefa criada a partir de conversa/demanda com empresa → herda; demanda aberta de conversa com contato vinculado → herda.
- Seletor de empresa (busca por nome/CNPJ) no formulário de tarefa e no detalhe da demanda; filtro por empresa na lista de tarefas.
- Ficha da empresa: cards "Atendimentos" (demandas com título/desfecho/data/atendente) e "Tarefas". A tela Empresas permanece **consultável** no modo suporte (empresas nascem do CNPJ; sem cadastro manual obrigatório).

## 7. Modo suporte na tela

- Preset novo **`suporte`** no editor de menu existente: Inbox, Tarefas, Contatos, Empresas, Conexões + portas essenciais + Configurações › Atendimento (manager+). Esconde funil/kanban/leads/IA/análise. **Apresentação, nunca autorização** (RLS/papéis seguem valendo — doutrina).
- Instalação de referência: módulos `setores` e `crm_b2b` ligados em `/admin/sistema`; preset `suporte`; modo só humano ligado; menu de entrada ligado no número com pedir-CNPJ.

## 8. Som de entrada na fila

- Botão liga/desliga no header da lista do Inbox, persistido por navegador. O clique chama `resumeAudio()` (autoplay).
- Detecção: aumento da **contagem canônica de fila** (`useConversationCounts`; definição no servidor, escopo de setor do atendente respeitado). O realtime do inbox passa a invalidar também as contagens (hoje só invalida conversas). Rajada → um som (debounce existente + intervalo mínimo entre toques).
- Som: `playSound("attention")` existente. Fila zerada ou toggle off → silêncio. **Limitação declarada:** só toca com o app aberto no navegador; sem push nesta versão.

## 9. Fora de escopo (YAGNI)

- IA respondendo após o menu (o fluxo aprovado é fila humana).
- Pesquisa de satisfação no fechamento (o evento `conversation.closed` já existe sem consumidor — #4023 é outro slice).
- Push notification / som com app fechado.
- Tela nova de listagem de atendimentos com filtros (histórico vive nas fichas).
- Menu por palavra-chave, múltiplos menus por número, horário especial do menu (o horário do setor já gateia a distribuição).
- CRUD manual de empresas como requisito (a tela B2B existente segue disponível, mas o fluxo não depende dela).

## 10. Corte transversal (doutrina)

- **Schema em tripla:** migrations versionadas (`-- manifest:` + NNNN/timestamp livres medidos por `pnpm checar:colisao-de-migration`) + apêndice idempotente no `baseline.sql`. RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` nas tabelas novas; service role filtra org manualmente; `revoke`/`grant` das duas origens em função nova.
- **API:** Zod em todo input; `requireRole` + `requireSupportWrite` em mutantes; `ok()`/`fail()`; audit em mutação; org de fonte confiável.
- **Envio:** toda mensagem ao cliente passa pela cadeia de envio normal (throttle/janela/guardrails) — sem bypass; trigger nunca faz HTTP (emite `event_log`).
- **Marca:** nenhum texto ao usuário nomeia o produto; `[empresa]` resolve do banco.
- **i18n:** todo `t("…")` novo com entrada `es` no dicionário (gate `i18n-espanhol-cobre-a-tela`).
- **Navegação:** tela nova com porta no `NAV_CATALOG` (menu de entrada como subpágina de Configurações › Atendimento).
- **Testes:** unit (parser, máquina de estados, render de templates, CNPJ, saudação, close com registro), invariantes (`pnpm test:db`: RLS das tabelas novas, LGPD alcança o resumo, vocabulário), e2e da jornada + prova visual em ambiente fresco (DoD 12). Sem IA no caminho → prova-em-par não se aplica.
- **Release:** fragmento `.changes/` `capacidade_nova`; Living System Checklist respondido; mapa em `docs/architecture/` atualizado.
- **Destino (extensões):** núcleo — com zero orgs ativando, a operação comum continua inteira (tudo opt-in por org/número).

## 11. Living System Checklist (resumo — responder com artefatos na implementação)

1. **Quem alimenta o menu:** `message.received` (dispatcher/drain). **Quem o menu alimenta:** `definirSetorDaConversa` → fila → routing-worker → assumida → saudação.
2. **Registro emitido:** atividades de timeline (`demand_closed` com título), `event_log` (menu, saudação), audit (config, close com registro, vínculo de empresa).
3. **Tela:** menu aparece na conversa (bolhas), fila no Inbox, registro na ficha empresa/contato, config em Configurações › Atendimento.
4. **Porta:** subpágina do menu no catálogo; demais via portas existentes.
5. **Anti-morte:** setor padrão + fila com `awaiting_since` + Central/Radar existentes; som de entrada na fila.
6. **Laço de retorno:** respostas inválidas viram setor padrão (configurável); abandono do menu fica visível na fila sem dono; métrica de menu (enviados/concluídos/inválidos) como sinal futuro — declarar o que não foi medido.
