import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { linhas } = vi.hoisted(() => ({ linhas: { dados: null as null | Record<string, unknown[]> } }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => banco()) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/atendimento/setor-da-conversa", () => ({ definirSetorDaConversa: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/atendimento/menu-de-entrada/empresa-por-cnpj", () => ({
  empresaDoContato: vi.fn(async () => null),
  vincularEmpresaPorCnpj: vi.fn(async () => ({ ok: true, empresaId: "empresa-1", nome: "Acme", criada: false })),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "TechSuporte" })) }));
vi.mock("@/lib/atendimento/envio-de-sistema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/atendimento/envio-de-sistema")>()),
  enviarTextoDeSistema: vi.fn(async () => ({ resultado: "sent" as const })),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { moduloLigado } from "@/lib/instalacao/modulos";
import { definirSetorDaConversa } from "@/lib/atendimento/setor-da-conversa";
import { empresaDoContato, vincularEmpresaPorCnpj } from "@/lib/atendimento/menu-de-entrada/empresa-por-cnpj";
import { enviarTextoDeSistema } from "@/lib/atendimento/envio-de-sistema";

import { menuDeEntradaHandler } from "./handler";
import { CHAVE_DO_MENU, lerEstadoDoMenu, metadataComEstadoDoMenu, type EstadoDoMenu } from "./estado";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const MSG = "55555555-5555-4555-8555-555555555555";
const MENU = "66666666-6666-4666-8666-666666666666";
const SUPORTE = "77777777-7777-4777-8777-777777777777";
const FINANCEIRO = "88888888-8888-4888-8888-888888888888";
const GERAL = "99999999-9999-4999-8999-999999999999";

const OP_COES = [
  { organization_id: ORG, menu_id: MENU, sector_id: SUPORTE, rotulo: "Suporte", ordem: 0 },
  { organization_id: ORG, menu_id: MENU, sector_id: FINANCEIRO, rotulo: "Financeiro", ordem: 1 },
];

function configLinha(parcial: Record<string, unknown> = {}) {
  return { id: MENU, organization_id: ORG, channel_session_id: CANAL, ativo: true, pedir_cnpj: true, textos: {}, setor_padrao_id: null, ...parcial };
}

function conversaLinha(parcial: Record<string, unknown> = {}) {
  return {
    id: CONVERSA,
    organization_id: ORG,
    contact_id: CONTATO,
    status: "open",
    assigned_to_user_id: null,
    assignee_kind: null,
    sector_id: null,
    service_revision: 1,
    metadata: {},
    is_group: false,
    bot_silenced_until: null,
    ...parcial,
  };
}

function mensagemLinha(parcial: Record<string, unknown> = {}) {
  return { id: MSG, organization_id: ORG, type: "text", body: "oi", direction: "inbound", ...parcial };
}

const atualizacoesFeitas: Array<Record<string, unknown>> = [];

function banco(): SupabaseClient {
  return {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const rows = () => linhas.dados?.[tabela] ?? [];
      const resolve = () =>
        rows().find((l) => filtros.every(([col, val]) => (l as Record<string, unknown>)[col] === val)) ?? null;
      const c = {
        eq: (col: string, val: unknown) => {
          filtros.push([col, val]);
          return c;
        },
        order: () => c,
        maybeSingle: async () => ({ data: resolve(), error: null }),
        // terminal thenable = "todas as linhas" (o handler lê opções assim).
        then: (res: (v: { data: unknown[] }) => void) =>
          res({
            data: rows().filter((l) => filtros.every(([col, val]) => (l as Record<string, unknown>)[col] === val)),
          }),
      };
      return {
        select: () => c,
        update: (patch: Record<string, unknown>) => {
          atualizacoesFeitas.push({ tabela, patch });
          return { eq: () => ({ eq: async () => ({ error: null }), async: undefined }) };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function semeia(tabelas: Record<string, unknown[]>) {
  linhas.dados = tabelas;
}

function evento(texto = "oi"): EventRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: MSG,
    payload: { message_id: MSG, conversation_id: CONVERSA, contact_id: CONTATO, channel_session_id: CANAL, body_preview: texto },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as EventRow;
}

const baseOk = () =>
  semeia({
    menu_de_entrada: [configLinha()],
    menu_de_entrada_opcoes: OP_COES,
    conversations: [conversaLinha()],
    contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: false }],
    messages: [mensagemLinha()],
    attendant_sectors: [
      { id: SUPORTE, organization_id: ORG, name: "Suporte" },
      { id: GERAL, organization_id: ORG, name: "Geral" },
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  atualizacoesFeitas.length = 0;
  vi.mocked(moduloLigado).mockResolvedValue(true as never);
  vi.mocked(enviarTextoDeSistema).mockResolvedValue({ resultado: "sent" });
  vi.mocked(definirSetorDaConversa).mockResolvedValue({ ok: true, de: null, para: SUPORTE, mudou: true, redistribuiu: true } as never);
  vi.mocked(empresaDoContato).mockResolvedValue(null as never);
});

describe("menuDeEntradaHandler — posse", () => {
  it("sem config ativa: skipped, mudo", async () => {
    semeia({ menu_de_entrada: [], conversations: [conversaLinha()], contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: false }] });
    const r = await menuDeEntradaHandler.handle(evento());
    expect(r.status).toBe("skipped");
    expect(enviarTextoDeSistema).not.toHaveBeenCalled();
  });

  it("módulo setores desligado: skipped (quem decide fila não existe)", async () => {
    baseOk();
    vi.mocked(moduloLigado).mockResolvedValue(false as never);
    expect((await menuDeEntradaHandler.handle(evento())).status).toBe("skipped");
  });

  it("conversa de grupo ou contato bloqueado: skipped", async () => {
    baseOk();
    semeia({ ...linhas.dados!, conversations: [conversaLinha({ is_group: true })] });
    expect((await menuDeEntradaHandler.handle(evento())).status).toBe("skipped");
    baseOk();
    semeia({ ...linhas.dados!, contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: true }] });
    expect((await menuDeEntradaHandler.handle(evento())).status).toBe("skipped");
  });

  it("conversa COM dono humano: o menu não fala por cima de gente", async () => {
    baseOk();
    semeia({ ...linhas.dados!, conversations: [conversaLinha({ assigned_to_user_id: "99999999-9999-4999-8999-999999999999", status: "claimed" })] });
    expect((await menuDeEntradaHandler.handle(evento())).status).toBe("skipped");
  });
});

describe("menuDeEntradaHandler — fluxo completo", () => {
  it("primeira mensagem: manda boas-vindas com a marca e persiste etapa CNPJ", async () => {
    baseOk();
    const r = await menuDeEntradaHandler.handle(evento("oi"));
    expect(r.status).toBe("ok");
    const corpo = vi.mocked(enviarTextoDeSistema).mock.calls[0]![1];
    expect(corpo.body).toContain("TechSuporte");
    expect(corpo.body).toContain("CNPJ");
    const update = atualizacoesFeitas
      .filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))
      .at(-1)!.patch as Record<string, unknown>;
    const estado = (update.metadata as Record<string, unknown>)[CHAVE_DO_MENU] as EstadoDoMenu;
    expect(estado.etapa).toBe("cnpj");
    expect(estado.service_revision).toBe(1);
  });

  it("contato que já é de uma empresa: pula o CNPJ e apresenta o menu com o nome dela", async () => {
    baseOk();
    vi.mocked(empresaDoContato).mockResolvedValue({ id: "empresa-1", nome: "Acme", cnpj: null } as never);
    const r = await menuDeEntradaHandler.handle(evento("oi"));
    expect(r.status).toBe("ok");
    expect(vi.mocked(enviarTextoDeSistema).mock.calls[0]![1].body).toContain("Acme");
    const update = atualizacoesFeitas
      .filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))
      .at(-1)!.patch as Record<string, unknown>;
    expect((update.metadata as Record<string, unknown>)[CHAVE_DO_MENU]).toMatchObject({ etapa: "setor" });
  });

  it("CNPJ na etapa certa: vincula SEM CRUD e apresenta o menu", async () => {
    baseOk();
    const estadoAntigo: EstadoDoMenu = { service_revision: 1, etapa: "cnpj", tentativas_cnpj: 0, tentativas_setor: 0, empresa_id: null };
    semeia({
      ...linhas.dados!,
      conversations: [conversaLinha({ metadata: metadataComEstadoDoMenu({}, estadoAntigo) })],
      messages: [mensagemLinha({ body: "12.345.678/0001-95" })],
    });
    const r = await menuDeEntradaHandler.handle(evento("12.345.678/0001-95"));
    expect(r.status).toBe("ok");
    expect(vincularEmpresaPorCnpj).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, contactId: CONTATO }));
    const update = atualizacoesFeitas
      .filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))
      .at(-1)!.patch as Record<string, unknown>;
    expect((update.metadata as Record<string, unknown>)[CHAVE_DO_MENU]).toMatchObject({ etapa: "setor", empresa_id: "empresa-1" });
  });

  it("escolha válida: confirma, SILÊNCI A o bot, põe pending e roteia pelo escritor único", async () => {
    baseOk();
    const estadoSetor: EstadoDoMenu = { service_revision: 1, etapa: "setor", tentativas_cnpj: 0, tentativas_setor: 0, empresa_id: null };
    semeia({
      ...linhas.dados!,
      conversations: [conversaLinha({ metadata: metadataComEstadoDoMenu({ setor_origem: "manual" }, estadoSetor) })],
      messages: [mensagemLinha({ body: "1" })],
    });
    const r = await menuDeEntradaHandler.handle(evento("1"));
    expect(r.status).toBe("ok");
    expect(vi.mocked(enviarTextoDeSistema).mock.calls[0]![1].body).toContain("Suporte");
    expect(definirSetorDaConversa).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, conversationId: CONVERSA, sectorId: SUPORTE, origem: "automacao" }),
    );
    const update = atualizacoesFeitas
      .filter((a) => a.tabela === "conversations" && "status" in (a.patch as object))
      .at(-1)!.patch as Record<string, unknown>;
    expect(update).toMatchObject({ status: "pending", bot_silenced_until: "infinity" });
    expect(lerEstadoDoMenu(update.metadata, 1)).toBeNull();
  });

  it("segunda inválida cai no setor PADRÃO com aviso próprio", async () => {
    baseOk();
    semeia({ ...linhas.dados!, menu_de_entrada: [configLinha({ setor_padrao_id: GERAL })] });
    const estadoSetor: EstadoDoMenu = { service_revision: 1, etapa: "setor", tentativas_cnpj: 0, tentativas_setor: 1, empresa_id: null };
    semeia({
      ...linhas.dados!,
      conversations: [conversaLinha({ metadata: metadataComEstadoDoMenu({}, estadoSetor) })],
      messages: [mensagemLinha({ body: "oi oi" })],
    });
    const r = await menuDeEntradaHandler.handle(evento("quero falar com um humano de verdade"));
    expect(r.status).toBe("ok");
    expect(definirSetorDaConversa).toHaveBeenCalledWith(expect.objectContaining({ sectorId: GERAL }));
    expect(vi.mocked(enviarTextoDeSistema).mock.calls[0]![1].body).toContain("Geral");
  });

  it("áudio na etapa CNPJ conta como tentativa; a mensagem de áudio em si não trava ninguém", async () => {
    baseOk();
    const estadoCnpj: EstadoDoMenu = { service_revision: 1, etapa: "cnpj", tentativas_cnpj: 0, tentativas_setor: 0, empresa_id: null };
    semeia({
      ...linhas.dados!,
      conversations: [conversaLinha({ metadata: metadataComEstadoDoMenu({}, estadoCnpj) })],
      messages: [mensagemLinha({ type: "audio", body: null })],
    });
    const r = await menuDeEntradaHandler.handle(evento(""));
    expect(r.status).toBe("ok");
    const update = atualizacoesFeitas
      .filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))
      .at(-1)!.patch as Record<string, unknown>;
    expect((update.metadata as Record<string, unknown>)[CHAVE_DO_MENU]).toMatchObject({ tentativas_cnpj: 1 });
  });
});

describe("menuDeEntradaHandler — desfechos de envio", () => {
  it("adiado pela janela: retry no instante, estado NÃO é persistido (a posse silenciada sim)", async () => {
    baseOk();
    const ate = new Date("2026-11-12T08:00:00Z");
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "adiado", ate });
    const r = await menuDeEntradaHandler.handle(evento());
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(ate.toISOString());
    expect(atualizacoesFeitas.filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))).toHaveLength(0);
  });

  it("erro do canal: error — o retry resende com a MESMA chave e o INSERT reconcilia", async () => {
    baseOk();
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "erro" });
    const r = await menuDeEntradaHandler.handle(evento());
    expect(r.status).toBe("error");
    expect(atualizacoesFeitas.filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object))).toHaveLength(0);
  });

  it("bloqueado por restrição comercial: estado AVANÇA (ok) — insistir no mesmo texto não muda a regra", async () => {
    baseOk();
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "bloqueado" });
    const r = await menuDeEntradaHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(
      atualizacoesFeitas.filter((a) => a.tabela === "conversations" && "metadata" in (a.patch as object)),
    ).toHaveLength(1);
  });

  it("duas executações da MESMA mensagem mandam UMA mensagem: a chave é determinística pelo inbound", async () => {
    baseOk();
    await menuDeEntradaHandler.handle(evento("oi"));
    await menuDeEntradaHandler.handle(evento("oi"));
    const [a, b] = vi.mocked(enviarTextoDeSistema).mock.calls.map(([, i]) => i.chave);
    expect(a).toBe(b);
  });
});
