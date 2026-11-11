import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "TechSuporte" })) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/atendimento/envio-de-sistema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/atendimento/envio-de-sistema")>()),
  enviarTextoDeSistema: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { marcaDaSaida } from "@/lib/branding/saida";
import { enviarTextoDeSistema } from "@/lib/atendimento/envio-de-sistema";

import { saudacaoNaAssumidaHandler } from "./saudacao-na-assumida";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const ATENDENTE = "55555555-5555-4555-8555-555555555555";
const EVENTO_ATRIBUICAO = "66666666-6666-4666-8666-666666666666";

function banco(rows: {
  settings?: Record<string, unknown> | null;
  conversa?: Record<string, unknown> | null;
}) {
  return {
    from: (tabela: string) => {
      const resolve = () => (tabela === "organizations" ? { settings: rows.settings ?? {} } : rows.conversa ?? null);
      const fim = () => ({ maybeSingle: async () => ({ data: resolve(), error: null }) });
      return {
        select: () => ({
          // .eq(col, val) — aceita encadear dois filtros; o valor não importa
          // para a resolução (uma linha por tabela neste dublê).
          eq: () => ({ ...fim(), eq: fim }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function evento(parcial: Record<string, unknown> = {}): EventRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "conversation.atendente_assumiu",
    entity_kind: "conversation",
    entity_id: CONVERSA,
    payload: {
      conversation_id: CONVERSA,
      assignment_event_id: EVENTO_ATRIBUICAO,
      to_user_id: ATENDENTE,
      reason: "claim",
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...parcial,
  } as EventRow;
}

const saudacaoAtiva = { atendimento: { somente_humano: false, saudacao_na_assumida: { ativo: true, template: "Olá, meu nome é [nome], como posso ajudar?" } } };
const conversaComDono = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  status: "claimed",
  assigned_to_user_id: ATENDENTE,
  assigned_to_user_name: "João",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enviarTextoDeSistema).mockResolvedValue({ resultado: "sent" });
  vi.mocked(nomesDosAtendentes).mockResolvedValue(new Map());
});

describe("saudacaoNaAssumidaHandler", () => {
  it("desligado: skipped, sem ler conversa nem enviar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: {} }));
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", consumer_key: "saudacao-assumida.v1" });
    expect(enviarTextoDeSistema).not.toHaveBeenCalled();
  });

  it("ativo com dono e nome: envia pela porta de sistema, idempotente pelo evento de atribuição", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva, conversa: conversaComDono }));
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(enviarTextoDeSistema).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(enviarTextoDeSistema).mock.calls[0]!;
    expect(input.body).toBe("Olá, meu nome é João, como posso ajudar?");
    expect(input.conversationId).toBe(CONVERSA);
    expect(input.contactId).toBe(CONTATO);
    expect(input.atorRotulo).toBe("saudacao-assumida");
    expect(input.metadata).toMatchObject({ saudacao_assumida: true, assignment_event_id: EVENTO_ATRIBUICAO });
  });

  it("retry do MESMO evento deriva a MESMA chave — a linha reconcilia, não sai em dobro", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva, conversa: conversaComDono }));
    await saudacaoNaAssumidaHandler.handle(evento());
    await saudacaoNaAssumidaHandler.handle(evento());
    const [a, b] = vi.mocked(enviarTextoDeSistema).mock.calls.map(([, i]) => i.chave);
    expect(a).toBe(b);
  });

  it("conversa fechada: skipped (assumida tardia não fala com cliente que já saiu)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({ settings: saudacaoAtiva, conversa: { ...conversaComDono, status: "closed" } }),
    );
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("skipped");
    expect(enviarTextoDeSistema).not.toHaveBeenCalled();
  });

  it("dono atual ≠ assumido no evento (passagem seguinte venceu): skipped", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({ settings: saudacaoAtiva, conversa: { ...conversaComDono, assigned_to_user_id: "99999999-9999-4999-8999-999999999999" } }),
    );
    expect((await saudacaoNaAssumidaHandler.handle(evento())).status).toBe("skipped");
  });

  it("nome desnormalizado ausente: fallback pelo lookup; sem resposta, skipped com aviso", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({ settings: saudacaoAtiva, conversa: { ...conversaComDono, assigned_to_user_name: null } }),
    );
    // fallback vazio → skipped
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("skipped");
    expect(enviarTextoDeSistema).not.toHaveBeenCalled();

    // fallback com nome → envia
    vi.mocked(nomesDosAtendentes).mockResolvedValue(new Map([[ATENDENTE, "Maria"]]));
    const r2 = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r2.status).toBe("ok");
    expect(vi.mocked(enviarTextoDeSistema).mock.calls[0]![1].body).toBe("Olá, meu nome é Maria, como posso ajudar?");
  });

  it("template vazio (salvo sem texto): skipped — nada hardcoded é enviado no lugar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        settings: { atendimento: { saudacao_na_assumida: { ativo: true, template: "  " } } },
        conversa: conversaComDono,
      }),
    );
    expect((await saudacaoNaAssumidaHandler.handle(evento())).status).toBe("skipped");
  });

  it("template do operador ganha a marca da SAÍDA no [empresa] (white-label: o banco vence o .env)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      banco({
        settings: {
          atendimento: {
            saudacao_na_assumida: { ativo: true, template: "[nome], da [empresa]. Como ajudo?" },
          },
        },
        conversa: conversaComDono,
      }),
    );
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(vi.mocked(enviarTextoDeSistema).mock.calls[0]![1].body).toBe("João, da TechSuporte. Como ajudo?");
  });

  it("adiado pela janela/ritmo: retry com o instante (a saudação não se perde, segura)", async () => {
    const ate = new Date("2026-11-12T08:00:00Z");
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva, conversa: conversaComDono }));
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "adiado", ate });
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(ate.toISOString());
  });

  it("bloqueado por restrição comercial: ok com detalhe — retry não insistiria no mesmo texto", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva, conversa: conversaComDono }));
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "bloqueado" });
    const r = await saudacaoNaAssumidaHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("bloqueado");
  });

  it("erro de envio: status error — o dispatcher tenta de novo, a chave segura a duplicata", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva, conversa: conversaComDono }));
    vi.mocked(enviarTextoDeSistema).mockResolvedValueOnce({ resultado: "erro" });
    expect((await saudacaoNaAssumidaHandler.handle(evento())).status).toBe("error");
  });

  it("payload torto (linha corrompida fora da RPC): skipped com aviso, nunca exceção", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: saudacaoAtiva }));
    const r = await saudacaoNaAssumidaHandler.handle(evento({ payload: {} }));
    expect(r.status).toBe("skipped");
  });
});
