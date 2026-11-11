/**
 * EMPRESA NA TAREFA PELA API (spec 2026-11-11 §6, Task 13).
 *
 * O que este arquivo prende, na ordem em que a rota faz:
 *   1. `company_id` de OUTRA organização é recusado com 422 nomeando a empresa
 *      — a FK composta não passa pela RLS sozinha, a régua é `conferirEmpresa`.
 *   2. Tarefa criada SEM `company_id` presa a uma demanda com empresa HERDA a
 *      empresa da demanda. `null` explícito é decisão de quem escolheu e NÃO
 *      é sobrescrito pela herança.
 *   3. GET `?company_id=` filtra na CONSULTA (a rota corta em 500 — filtrar na
 *      tela esconderia o que ficou depois do corte) e a lista devolve o
 *      `company_id` com o nome embutido para o card.
 *
 * Estilo de dublê: o do catálogo (`app/api/v1/settings/catalogo/route.test.ts`)
 * — cadeia falsa que anota filtros e capturas, nada de banco vivo.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";

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
const EMPRESA = "55555555-5555-4555-8555-555555555555";
const DEMANDA = "33333333-3333-4333-8333-333333333333";

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

interface Fakes {
  /** A linha de `companies` que a conferência vê (null = não é da organização). */
  empresa?: Record<string, unknown> | null;
  /** A linha de `demandas` que a herança vê. */
  demanda?: Record<string, unknown> | null;
  /** As linhas que o GET devolve. */
  lista?: Array<Record<string, unknown>>;
}

/**
 * Dublê da cadeia do PostgREST que ANOTA os filtros por tabela (é neles que
 * mora a régua de organização) e CAPTURA o insert. `select` anota as colunas
 * pedidas — é como se prende o embed `company:companies(...)` sem banco vivo.
 */
function bancoFake(fakes: Fakes) {
  const filtros: Array<[string, string, unknown]> = [];
  const selects: string[] = [];
  const inseridas: Array<Record<string, unknown>> = [];

  const elo = (tabela: string, linha: Record<string, unknown> | null, lista?: Array<Record<string, unknown>>) => {
    let le: Array<[string, unknown]> = [];
    const e: Record<string, unknown> = {};
    const registrar = () => {
      filtros.push(...le.map(([col, val]) => [tabela, col, val] as [string, string, unknown]));
      le = [];
    };
    for (const metodo of ["order", "limit", "in", "gte", "lte"]) e[metodo] = () => e;
    e.select = (colunas: string) => (selects.push(colunas), e);
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
      return { data: linha, error: null };
    };
    e.then = (res: (v: unknown) => unknown) => {
      registrar();
      return Promise.resolve({ data: lista ?? (linha ? [linha] : []), error: null }).then(res);
    };
    return e;
  };

  const cliente = {
    from: (tabela: string) => {
      if (tabela === "crm_tasks") {
        const leitura = elo("crm_tasks", null, fakes.lista ?? []);
        return {
          ...leitura,
          insert: (linha: Record<string, unknown>) => {
            inseridas.push(linha);
            const resposta = { id: "t-nova", created_at: new Date().toISOString(), ...linha };
            return {
              select: () => ({ single: async () => ({ data: resposta, error: null }) }),
            };
          },
        };
      }
      if (tabela === "companies") return elo("companies", fakes.empresa ?? null);
      if (tabela === "demandas") return elo("demandas", fakes.demanda ?? null);
      if (tabela === "contacts") return elo("contacts", null);
      if (tabela === "company_people") return elo("company_people", null);
      return elo(tabela, null);
    },
  };
  return { filtros, selects, inseridas, cliente };
}

async function post(corpo: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/v1/tasks/route");
  return POST(
    new NextRequest("http://localhost/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function listar(qs: string): Promise<Response> {
  const { GET } = await import("@/app/api/v1/tasks/route");
  return GET(new NextRequest(`http://localhost/api/v1/tasks${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(conferirDemanda).mockResolvedValue("aceita");
  vi.mocked(conferirResponsavel).mockResolvedValue("aceito");
  sessao();
});

describe("POST /api/v1/tasks com company_id", () => {
  it("⭐ recusa empresa de outra organização com 422 nomeando a empresa", async () => {
    const b = bancoFake({ empresa: null });
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await post({ title: "Ligar de volta", company_id: EMPRESA });

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/empresa/i);
    // nada foi gravado
    expect(b.inseridas).toEqual([]);
    // a conferência é pela organização da sessão, nunca do body
    expect(b.filtros).toContainEqual(["companies", "organization_id", ORG]);
    expect(b.filtros).toContainEqual(["companies", "id", EMPRESA]);
  });

  it("empresa da organização entra no insert", async () => {
    const b = bancoFake({ empresa: { id: EMPRESA } });
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await post({ title: "Ligar de volta", company_id: EMPRESA });

    expect(res.status).toBe(201);
    expect(b.inseridas[0]).toMatchObject({ company_id: EMPRESA, organization_id: ORG });
  });

  it("⭐ sem company_id, presa a uma demanda com empresa, a tarefa HERDA a empresa da demanda", async () => {
    const b = bancoFake({ demanda: { company_id: EMPRESA } });
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await post({ title: "Ligar de volta", demanda_id: DEMANDA });

    expect(res.status).toBe(201);
    expect(b.inseridas[0]).toMatchObject({ company_id: EMPRESA });
    // a herança lê a demanda DENTRO da organização
    expect(b.filtros).toContainEqual(["demandas", "organization_id", ORG]);
    expect(b.filtros).toContainEqual(["demandas", "id", DEMANDA]);
  });

  it("`null` explícito é decisão de quem escolheu: não é sobrescrito pela herança", async () => {
    const b = bancoFake({ demanda: { company_id: EMPRESA } });
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await post({ title: "Avulsa", demanda_id: DEMANDA, company_id: null });

    expect(res.status).toBe(201);
    expect(b.inseridas[0]).toMatchObject({ company_id: null });
  });

  it("sem empresa e sem herança, a tarefa nasce como nascia antes", async () => {
    const b = bancoFake({});
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await post({ title: "Sem vínculo" });

    expect(res.status).toBe(201);
    expect((b.inseridas[0] as Record<string, unknown>).company_id ?? null).toBeNull();
  });
});

describe("GET /api/v1/tasks?company_id=", () => {
  it("⭐ filtra na consulta e devolve o nome da empresa embutido", async () => {
    const b = bancoFake({});
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    const res = await listar(`?aberto=true&company_id=${EMPRESA}`);

    expect(res.status).toBe(200);
    expect(b.filtros).toContainEqual(["crm_tasks", "company_id", EMPRESA]);
    expect(b.selects[0]).toContain("company_id");
    expect(b.selects[0]).toContain("company:companies(");
    // o filtro é pela coluna da PRÓPRIA tarefa — o join não precisa ser obrigatório
    expect(b.selects[0]).not.toContain("company:companies!inner(");
  });

  it("sem o parâmetro, a lista continua a mesma e traz a empresa de cada tarefa", async () => {
    const b = bancoFake({});
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);

    await listar("?aberto=true");

    expect(b.filtros.filter(([, col]) => col === "company_id")).toEqual([]);
    expect(b.selects[0]).toContain("company:companies(id, trade_name, legal_name)");
  });

  it("valor que não é id é recusado (422), não vira 'todas as empresas' em silêncio", async () => {
    const b = bancoFake({});
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);
    expect((await listar("?company_id=acme")).status).toBe(422);
  });
});

describe("a auditoria da empresa", () => {
  it("criar com empresa auditou a criação, como toda mutação", async () => {
    const b = bancoFake({ empresa: { id: EMPRESA } });
    vi.mocked(createClient).mockResolvedValue(b.cliente as never);
    await post({ title: "Ligar de volta", company_id: EMPRESA });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "crm_task.created" }));
  });
});
