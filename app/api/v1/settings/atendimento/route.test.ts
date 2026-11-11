import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAUDACAO_PADRAO } from "@/lib/schemas/atendimento";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "33333333-3333-4333-8333-333333333333";

let gravado: Record<string, unknown> | null = null;
let filtroDoCas: string | null = null;

function banco({ settings, erroNaLeitura = false, outroGravou = false }: {
  settings: Record<string, unknown> | null;
  erroNaLeitura?: boolean;
  outroGravou?: boolean;
}) {
  const escrita = {
    eq: () => escrita,
    is: () => escrita,
    filter: (_c: string, _o: string, valor: string) => {
      filtroDoCas = valor;
      return escrita;
    },
    select: () => escrita,
    maybeSingle: async () =>
      outroGravou ? { data: null, error: null } : { data: { id: ORG_ID }, error: null },
  };
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            erroNaLeitura
              ? { data: null, error: { message: "fora do ar" } }
              : { data: { settings }, error: null },
        }),
      }),
      update: (linha: { settings: Record<string, unknown> }) => {
        gravado = linha.settings;
        return escrita;
      },
    }),
  };
}

async function patch(corpo: unknown): Promise<Response> {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest("http://localhost/api/v1/settings/atendimento", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function get(): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest("http://localhost/api/v1/settings/atendimento"));
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
  filtroDoCas = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("GET /api/v1/settings/atendimento", () => {
  it("sem bloco gravado devolve os defaults (a tela mostra o que vai valer)", async () => {
    vi.mocked(createClient).mockResolvedValue(banco({ settings: { routing: {} } }) as never);
    const r = await get();
    expect(r.status).toBe(200);
    const corpo = await r.json();
    expect(corpo.data).toEqual({
      somente_humano: false,
      saudacao_na_assumida: { ativo: false, template: SAUDACAO_PADRAO },
    });
  });
});

describe("PATCH /api/v1/settings/atendimento", () => {
  it("liga o modo humano sem encostar nos irmãos, e audita", async () => {
    const settings = { routing: { mode: "round_robin" }, branding: { nome: "X" } };
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings }) as never);

    const r = await patch({ somente_humano: true });
    expect(r.status).toBe(200);
    expect(gravado).toEqual({
      routing: { mode: "round_robin" },
      branding: { nome: "X" },
      atendimento: {
        somente_humano: true,
        saudacao_na_assumida: { ativo: false, template: SAUDACAO_PADRAO },
      },
    });
    expect(filtroDoCas).toBe(JSON.stringify(settings));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.atendimento_changed", organizationId: ORG_ID }),
    );
  });

  it("patch parcial do bloco preserva o que já valia dentro dele", async () => {
    const settings = {
      atendimento: {
        somente_humano: true,
        saudacao_na_assumida: { ativo: true, template: "Oi, [nome]!" },
      },
    };
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings }) as never);

    expect((await patch({ saudacao_na_assumida: { template: "Olá, sou [nome]." } })).status).toBe(200);
    expect(gravado).toEqual({
      atendimento: {
        somente_humano: true,
        saudacao_na_assumida: { ativo: true, template: "Olá, sou [nome]." },
      },
    });
  });

  it("input inválido: 422 (validation_error da casa), sem escrever, sem auditar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: {} }) as never);
    const r = await patch({ saudacao_na_assumida: { template: "x".repeat(1001) } });
    expect(r.status).toBe(422);
    expect(gravado).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("escrita concorrente vira 409, sem auditar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: {}, outroGravou: true }) as never);
    expect((await patch({ somente_humano: true })).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("leitura que falhou não grava: settings vazio apagaria a configuração", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: null, erroNaLeitura: true }) as never);
    expect((await patch({ somente_humano: true })).status).toBe(500);
    expect(gravado).toBeNull();
  });

  it("sem permissão (requireRole nega): repõe a resposta do guard", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await patch({ somente_humano: true })).status).toBe(403);
  });
});
