/**
 * EMPRESA NA EDIÇÃO DA TAREFA (spec 2026-11-11 §6, Task 13).
 *
 * `PATCH /api/v1/tasks/[id]` ganha `company_id`: vincular (`<uuid>`), trocar e
 * desvincular (`null`). A régua é a MESMA da criação — a empresa precisa ser
 * da organização, e a organização vem da SESSÃO que carregou a tarefa, nunca
 * do corpo. Estilo de dublê: o do catálogo (ver `../route.test.ts`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ portaDaAplicacao: vi.fn(() => ({})) }));
vi.mock("@/lib/tarefas/demanda", () => ({ conferirDemanda: vi.fn(async () => "aceita") }));
vi.mock("@/lib/tarefas/responsavel", () => ({ conferirResponsavel: vi.fn(async () => "aceito") }));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const TAREFA = "88888888-8888-4888-8888-888888888888";
const EMPRESA = "55555555-5555-4555-8555-555555555555";

function bancoFake(empresaVisivel: boolean) {
  const filtros: Array<[string, string, unknown]> = [];
  const atualizadas: Array<Record<string, unknown>> = [];
  const elo = (tabela: string, linha?: Record<string, unknown> | null) => {
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
      return { data: linha === undefined ? null : linha, error: null };
    };
    e.single = async () => {
      registrar();
      return { data: { id: TAREFA, company_id: EMPRESA, status: "pending" }, error: null };
    };
    return e;
  };
  const cliente = {
    from: (tabela: string) => {
      if (tabela === "companies") return elo("companies", empresaVisivel ? { id: EMPRESA } : null);
      if (tabela === "crm_tasks") {
        const base = elo("crm_tasks");
        return {
          ...base,
          update: (patch: Record<string, unknown>) => {
            atualizadas.push(patch);
            return base;
          },
        };
      }
      return elo(tabela);
    },
  };
  return { cliente, filtros, atualizadas };
}

async function patch(corpo: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");
  return PATCH(
    new NextRequest(`http://localhost/api/v1/tasks/${TAREFA}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: TAREFA }) },
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

describe("PATCH /api/v1/tasks/[id] com company_id", () => {
  it("⭐ empresa de outra organização: 422 nomeando a empresa, nada gravado", async () => {
    const b = bancoFake(false);
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await patch({ company_id: EMPRESA });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/empresa/i);
    expect(b.atualizadas).toEqual([]);
    // a régua usa a organização da SESSÃO, nunca um campo do corpo
    expect(b.filtros).toContainEqual(["companies", "organization_id", ORG]);
  });

  it("⭐ empresa da organização entra no update, e a resposta traz o embed", async () => {
    const b = bancoFake(true);
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await patch({ company_id: EMPRESA });

    expect(res.status).toBe(200);
    expect(b.atualizadas[0]).toMatchObject({ company_id: EMPRESA });
  });

  it("`null` desvincula sem consulta de empresa", async () => {
    const b = bancoFake(true);
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await patch({ company_id: null });

    expect(res.status).toBe(200);
    expect(b.atualizadas[0]).toMatchObject({ company_id: null });
    expect(b.filtros.filter(([tabela]) => tabela === "companies")).toEqual([]);
  });
});
