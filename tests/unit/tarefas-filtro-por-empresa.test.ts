/**
 * EMPRESA NA TELA DE TAREFAS E NA CRIAÇÃO (spec 2026-11-11 §6, Task 13).
 *
 * Prende os FIOS, no estilo `tarefas-filtro-por-funil`: filtro da tela →
 * parâmetro da rota, seletor do formulário → `company_id` do body, e a página
 * carregando as empresas pelo servidor (a rota de empresas é a régua, e o
 * filtro não pode depender dela estar ligada para o viewer abrir a tela).
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

function fazerSupabase() {
  const filtros: Array<[string, string, unknown]> = [];
  const selects: string[] = [];
  const elo: Record<string, unknown> = {};
  let le: Array<[string, unknown]> = [];
  for (const metodo of ["order", "limit", "in", "gte", "lte"]) elo[metodo] = () => elo;
  elo.select = (colunas: string) => (selects.push(colunas), elo);
  elo.eq = (coluna: string, valor: unknown) => {
    le.push([coluna, valor]);
    return elo;
  };
  elo.is = (coluna: string, valor: unknown) => {
    le.push([coluna, valor]);
    return elo;
  };
  elo.then = (res: (v: unknown) => unknown) => {
    filtros.push(...le.map(([col, val]) => ["crm_tasks", col, val] as [string, string, unknown]));
    le = [];
    return Promise.resolve({ data: [], error: null }).then(res);
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => elo } as never);
  return { filtros, selects };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
});

describe("a tela → a rota", () => {
  it("⭐ o filtro da tela manda company_id para a rota (o fio que some sem barulho)", async () => {
    const { filtros } = fazerSupabase();
    const { GET } = await import("@/app/api/v1/tasks/route");
    await GET(new NextRequest(`http://localhost/api/v1/tasks?aberto=true&company_id=${EMPRESA}`));
    expect(filtros).toContainEqual(["crm_tasks", "company_id", EMPRESA]);
  });

  it("os fios escritos: tela, hook e página", () => {
    const tela = readFileSync("app/app/tasks/_components/TarefasClient.tsx", "utf8");
    expect(tela).toMatch(/company_id: empresa === "todas" \? undefined : empresa/);
    expect(tela).toMatch(/aria-label=\{t\("Empresa"\)\}/);
    expect(tela).toMatch(/tarefas-filtro-empresa/);

    const hook = readFileSync("hooks/tasks/useTasks.ts", "utf8");
    expect(hook).toMatch(/params\.set\("company_id", filtros\.company_id\)/);

    const pagina = readFileSync("app/app/tasks/page.tsx", "utf8");
    expect(pagina).toMatch(/from\("companies"\)/);
    expect(pagina).toMatch(/\.eq\("organization_id", activeOrg\.orgId\)/);
    expect(pagina).toMatch(/empresas=\{/);

    const formulario = readFileSync("app/app/tasks/_components/FormularioDeTarefa.tsx", "utf8");
    expect(formulario).toMatch(/SeletorDeEmpresa/);
    expect(formulario).toMatch(/company_id: empresa \?\? null/);
  });

  it("o seletor vive como componente próprio, consultando a ROTA de empresas (não o banco)", () => {
    const seletor = readFileSync("components/tasks/SeletorDeEmpresa.tsx", "utf8");
    expect(seletor).toMatch(/apiClient\.get<{ data: unknown }>\(`\/api\/v1\/companies\?limit=20/);
    // módulo B2B desligado = campo some, não campo quebra: a rota responde 404.
    expect(seletor).toMatch(/setEscondido\(true\)/);
    expect(seletor).toMatch(/if \(escondido\) return null/);
  });
});
