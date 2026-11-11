/**
 * VINCULAR EMPRESA NA DEMANDA PELA API (spec 2026-11-11 §6, Task 14).
 *
 * O `PATCH /api/v1/demandas/[id]` já tinha duas bocas (encerrar; próximo
 * passo). Ganha a terceira: `company_id` — vincular, trocar ou desvincular a
 * empresa cliente do atendimento. O que este arquivo prende:
 *   1. empresa de OUTRA organização é recusada com 422 nomeando a empresa;
 *   2. `null` desvincula sem consulta, `<uuid>` da organização grava;
 *   3. a mutação audita `demanda.company_changed` — vínculo de cliente é
 *      efeito que outra pessoa lê na ficha da empresa;
 *   4. os ramos velhos continuam inteiros: o union não pode engolir nem o
 *      `action: "encerrar"` nem o `proximo_passo` (colisão de union é defeito
 *      silencioso — quem mandasse registro de encerramento receberia 422).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const DEMANDA = "33333333-3333-4333-8333-333333333333";
const EMPRESA = "55555555-5555-4555-8555-555555555555";

function bancoFake(empresaVisivel: boolean) {
  const filtros: Array<[string, string, unknown]> = [];
  const atualizadas: Array<Record<string, unknown>> = [];
  const rpcs: Array<[string, Record<string, unknown>]> = [];

  const elo = (tabela: string) => {
    let le: Array<[string, unknown]> = [];
    const e: Record<string, unknown> = {};
    const registrar = () => {
      filtros.push(...le.map(([col, val]) => [tabela, col, val] as [string, string, unknown]));
      le = [];
    };
    e.select = () => e;
    e.eq = (col: string, val: unknown) => {
      le.push([col, val]);
      return e;
    };
    e.is = (col: string, val: unknown) => {
      le.push([col, val]);
      return e;
    };
    e.maybeSingle = async () => {
      registrar();
      if (tabela === "companies") return { data: empresaVisivel ? { id: EMPRESA } : null, error: null };
      if (tabela === "demandas") {
        return { data: { id: DEMANDA, company_id: null, estado: "aberta" }, error: null };
      }
      return { data: null, error: null };
    };
    return e;
  };

  const cliente = {
    from: (tabela: string) => {
      const base = elo(tabela);
      return {
        ...base,
        update: (patch: Record<string, unknown>) => {
          atualizadas.push(patch);
          return base;
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push([fn, args]);
      return { data: { id: DEMANDA }, error: null };
    },
  };
  return { cliente, filtros, atualizadas, rpcs };
}

async function patch(corpo: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/v1/demandas/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/v1/demandas/${DEMANDA}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: DEMANDA }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ANA, email: "ana@example.com", idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("PATCH /api/v1/demandas/[id] com company_id", () => {
  it("⭐ empresa de outra organização: 422 nomeando a empresa, nada gravado", async () => {
    const b = bancoFake(false);
    vi.mocked(createAdminClient).mockReturnValue(b.cliente as never);

    const res = await patch({ company_id: EMPRESA });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/empresa/i);
    expect(b.atualizadas).toEqual([]);
    // a régua usa a organização da sessão (fonte confiável), nunca o body
    expect(b.filtros).toContainEqual(["companies", "organization_id", ORG]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("⭐ empresa da organização: grava, audita `demanda.company_changed`", async () => {
    const b = bancoFake(true);
    vi.mocked(createAdminClient).mockReturnValue(b.cliente as never);

    const res = await patch({ company_id: EMPRESA });

    expect(res.status).toBe(200);
    expect(b.atualizadas[0]).toMatchObject({ company_id: EMPRESA });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "demanda.company_changed", organizationId: ORG, resourceId: DEMANDA }),
    );
  });

  it("`null` desvincula sem consulta de empresa, e ainda assim audita", async () => {
    const b = bancoFake(true);
    vi.mocked(createAdminClient).mockReturnValue(b.cliente as never);

    const res = await patch({ company_id: null });

    expect(res.status).toBe(200);
    expect(b.atualizadas[0]).toMatchObject({ company_id: null });
    expect(b.filtros.filter(([tabela]) => tabela === "companies")).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "demanda.company_changed" }));
  });

  it("os ramos velhos seguem inteiros: encerrar cai no RPC, passo cai no update", async () => {
    const b = bancoFake(true);
    vi.mocked(createAdminClient).mockReturnValue(b.cliente as never);

    const encerrar = await patch({
      action: "encerrar",
      expected_revision: 3,
      desfecho: "resolvida",
    });
    expect(encerrar.status).toBe(200);
    expect(b.rpcs[0]?.[0]).toBe("fn_demanda_encerrar");

    const passo = await patch({ proximo_passo: "Ligar na terça" });
    expect(passo.status).toBe(200);
    expect(b.atualizadas[0]).toMatchObject({ proximo_passo: "Ligar na terça" });
    expect(b.atualizadas[0]).not.toHaveProperty("company_id");
  });

  it("company_id que não é uuid vira 422 do Zod, não do banco", async () => {
    const b = bancoFake(true);
    vi.mocked(createAdminClient).mockReturnValue(b.cliente as never);
    expect((await patch({ company_id: "ufu" })).status).toBe(422);
  });
});
