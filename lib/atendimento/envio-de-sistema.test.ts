import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registraEnvio, decide } = vi.hoisted(() => ({
  registraEnvio: vi.fn(async () => undefined),
  decide: vi.fn(async () => ({ liberado: true as boolean })),
}));

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/followup/janela-de-disparo", () => ({ canalDaConversa: vi.fn(async () => "sessao-1") }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ knobsDoCanal: vi.fn(async () => ({ janela: true })) }));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: vi.fn(() => true),
  proximaAberturaDaJanela: vi.fn(() => new Date("2026-11-12T08:00:00Z")),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: vi.fn(async () => ({ decide, registraEnvio })),
}));
vi.mock("@/lib/escalacao/assunto-comercial", () => ({
  restricaoComercialBarra: vi.fn(async () => false),
  comercialExigeHumanoViaSupabase: vi.fn(async () => false),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { canalDaConversa } from "@/lib/followup/janela-de-disparo";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { restricaoComercialBarra } from "@/lib/escalacao/assunto-comercial";

import { chaveDoEnvio, enviarTextoDeSistema } from "./envio-de-sistema";

/**
 * O envio de SISTEMA (menu de entrada, saudação na assumida) — a porta única
 * `sendMessageHandler` sem o `send_ledger`: os caminhos de job_queue não se
 * aplicam (o ledger tem FK de job), e a idempotência nasce do
 * `internalMessageId` DETERMINÍSTICO — o handler reconcilia o 23505 e o retry
 * do dispatcher nunca manda a mensagem em dobro.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CHAVE = "44444444-4444-4444-8444-444444444444";

function entrada(parcial: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: CONTATO,
    body: "Com qual setor deseja falar?\n1 - Suporte",
    chave: CHAVE,
    atorRotulo: "menu-de-entrada",
    metadata: { menu_de_entrada: true },
    ...parcial,
  } as Parameters<typeof enviarTextoDeSistema>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  decide.mockResolvedValue({ liberado: true });
  janelaDeEnvioAberta.mockReturnValue(true);
  restricaoComercialBarra.mockResolvedValue(false as never);
  canalDaConversa.mockResolvedValue("sessao-1" as never);
  knobsDoCanal.mockResolvedValue({ janela: true } as never);
  vi.mocked(sendMessageHandler).mockImplementation(async (_db, _ctx, corpo) => ({
    id: CHAVE,
    status: "queued",
    external_id: null,
    ...(corpo as Record<string, unknown>),
  }));
});

describe("enviarTextoDeSistema", () => {
  it("manda pela porta única com ator de sistema e id determinística; contabiliza no ritmo", async () => {
    vi.mocked(sendMessageHandler).mockImplementation(async () => ({ id: "m1", status: "sent" }) as never);
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r).toEqual({ resultado: "sent" });
    const [db, ctx, corpo] = vi.mocked(sendMessageHandler).mock.calls[0]!;
    expect(db).toBeDefined();
    expect(ctx.organization_id).toBe(ORG);
    expect(ctx.actor).toMatchObject({ type: "webhook_source" });
    expect(ctx.internalMessageId).toBe(CHAVE);
    expect(corpo).toMatchObject({
      conversation_id: CONVERSA,
      type: "text",
      body: "Com qual setor deseja falar?\n1 - Suporte",
      metadata: { menu_de_entrada: true },
    });
    expect(registraEnvio).toHaveBeenCalledWith(ORG, "sessao-1", expect.any(Date));
  });

  it("canal não-WORKING deixa a mensagem em queued: sucesso marcado, sem contabilizar no ritmo", async () => {
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("queued");
    expect(registraEnvio).not.toHaveBeenCalled();
  });

  it("falha do canal (failed) é erro — o handler decide o retry, o sender informa", async () => {
    vi.mocked(sendMessageHandler).mockImplementation(async () => ({ id: "m1", status: "failed" }) as never);
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("erro");
  });

  it("janela de disparo do canal fechada: adia para a abertura, SEM enviar", async () => {
    janelaDeEnvioAberta.mockReturnValue(false);
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("adiado");
    expect(r.ate?.toISOString()).toBe("2026-11-12T08:00:00.000Z");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("restrição comercial barra o texto de operador também aqui: bloqueado, sem enviar", async () => {
    restricaoComercialBarra.mockResolvedValue(true as never);
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("bloqueado");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("ritmo anti-ban não liberado: adia com o instante do ritmo, sem enviar", async () => {
    const liberaEm = new Date("2026-11-11T18:00:30Z");
    decide.mockResolvedValue({ liberado: false, motivo: "espacamento", liberaEm });
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("adiado");
    expect(r.ate?.toISOString()).toBe(liberaEm.toISOString());
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("canal sem sessão (conversa órfã): não há janela nem ritmo a consultar — ainda envia", async () => {
    canalDaConversa.mockResolvedValue(null as never);
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("queued");
    expect(knobsDoCanal).not.toHaveBeenCalled();
    expect(registraEnvio).not.toHaveBeenCalled();
  });

  it("body vazio é erro — não se manda mensagem sem conteúdo", async () => {
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada({ body: "   " }));
    expect(r.resultado).toBe("erro");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("erro do handler vira erro próprio, nunca exceção na borda do chamador", async () => {
    vi.mocked(sendMessageHandler).mockRejectedValueOnce(new Error("canal fora do ar"));
    const r = await enviarTextoDeSistema({} as SupabaseClient, entrada());
    expect(r.resultado).toBe("erro");
  });
});

describe("chaveDoEnvio", () => {
  it("determinística: a mesma origem sempre deriva o mesmo uuid", () => {
    const a = chaveDoEnvio("conversa-1", "1", "cnpj", "msg-9");
    const b = chaveDoEnvio("conversa-1", "1", "cnpj", "msg-9");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("origens diferentes não colidem", () => {
    expect(chaveDoEnvio("conversa-1", "1", "cnpj", "msg-9")).not.toBe(
      chaveDoEnvio("conversa-1", "2", "cnpj", "msg-9"),
    );
  });
});
