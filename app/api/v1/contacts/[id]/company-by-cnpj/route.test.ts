import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { vincularEmpresaPorCnpj } from "@/lib/atendimento/menu-de-entrada/empresa-por-cnpj";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/menu-de-entrada/empresa-por-cnpj", () => ({
  vincularEmpresaPorCnpj: vi.fn(),
  empresaDoContato: vi.fn(async () => null),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";

/** A rota lê a ficha pelo client de sessão (RLS decide a visibilidade). */
function sessao(contatoVisivel: boolean) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: contatoVisivel ? { id: CONTATO } : null,
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
}

function chamar(corpo: unknown): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/company-by-cnpj`, {
      method: "POST",
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CONTATO }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
  vi.mocked(createClient).mockResolvedValue(sessao(true) as never);
  vi.mocked(vincularEmpresaPorCnpj).mockResolvedValue({
    ok: true,
    empresaId: "empresa-1",
    nome: "Acme",
    criada: false,
  } as never);
});

describe("POST /api/v1/contacts/[id]/company-by-cnpj", () => {
  it("vincula a ficha à empresa do CNPJ, audita e devolve a empresa", async () => {
    const res = await chamar({ cnpj: "12.345.678/0001-95" });
    expect(res.status).toBe(200);
    expect(vincularEmpresaPorCnpj).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        contactId: CONTATO,
        cnpj: "12.345.678/0001-95",
        actorUserId: "u1",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contacts.company_linked_by_cnpj", resourceId: CONTATO }),
    );
    const corpo = await res.json();
    expect(corpo.data.empresa).toEqual({ id: "empresa-1", nome: "Acme", criada: false });
  });

  it("CNPJ recusado pelo validador → 422 nomeando o problema, sem audit", async () => {
    vi.mocked(vincularEmpresaPorCnpj).mockResolvedValueOnce({ ok: false, motivo: "cnpj_invalido" } as never);
    // formato com tamanho válido (passa pelo Zod) e DV recusado pela regra.
    const res = await chamar({ cnpj: "12.345.678/0001-99" });
    expect(res.status).toBe(422);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ficha fora da visão da org → 404 antes de vincular", async () => {
    vi.mocked(createClient).mockResolvedValue(sessao(false) as never);
    const res = await chamar({ cnpj: "12.345.678/0001-95" });
    expect(res.status).toBe(404);
    expect(vincularEmpresaPorCnpj).not.toHaveBeenCalled();
  });

  it("corpo sem cnpj → 422 do Zod; JSON quebrado → 422", async () => {
    expect((await chamar({})).status).toBe(422);
    expect((await chamar("isso não é json{{{")).status).toBe(422);
    expect(vincularEmpresaPorCnpj).not.toHaveBeenCalled();
  });

  it("falha de banco no vínculo → 500, sem audit", async () => {
    vi.mocked(vincularEmpresaPorCnpj).mockResolvedValueOnce({ ok: false, motivo: "erro" } as never);
    const res = await chamar({ cnpj: "12.345.678/0001-95" });
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
