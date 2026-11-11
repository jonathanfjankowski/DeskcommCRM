/**
 * EMPRESA DA TAREFA — a régua da organização e a herança (spec §6).
 *
 * Igual à demanda (`lib/tarefas/demanda.ts`) e ao responsável: a chave
 * estrangeira de `crm_tasks.company_id` é COMPOSTA com `organization_id`, mas
 * quem cria a tarefa pela API manda `company_id` sozinho — sem a conferência,
 * um id de empresa de outra organização casaria com a organização da sessão
 * pela coluna `organization_id` da própria tarefa. A régua mora aqui.
 *
 * A herança é LEITURA DE CONVENIÊNCIA: nasce do que a conversa já sabe
 * (demanda → empresa; sem demanda, contato → cadeia `people`). Falha de
 * leitura não derruba a criação da tarefa — devolve `null` e a tarefa nasce
 * sem empresa, como nascia antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/menu-de-entrada/empresa-por-cnpj", () => ({
  empresaDoContato: vi.fn(async () => null),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { empresaDoContato } from "@/lib/atendimento/menu-de-entrada/empresa-por-cnpj";

import { conferirEmpresa, empresaHerdada } from "./empresa";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "55555555-5555-4555-8555-555555555555";
const DEMANDA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

/**
 * Dublê do PostgREST por tabela: cada leitura devolve a linha programada e
 * ANOTA os filtros `eq` aplicados — é neles que mora a régua de organização.
 */
function bancoFake(linhas: Record<string, Record<string, unknown> | null | Error>) {
  const filtros: Array<[string, string, unknown]> = [];
  const banco = {
    from: (tabela: string) => {
      const le: Array<[string, unknown]> = [];
      const elo = {
        select: () => elo,
        eq: (col: string, val: unknown) => {
          le.push([col, val]);
          return elo;
        },
        maybeSingle: async () => {
          filtros.push(...le.map(([col, val]) => [tabela, col, val] as [string, string, unknown]));
          const linha = linhas[tabela];
          if (linha instanceof Error) return { data: null, error: linha };
          return { data: linha ?? null, error: null };
        },
      };
      return elo;
    },
  };
  return { banco: banco as unknown as SupabaseClient, filtros };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("conferirEmpresa", () => {
  it("aceita a empresa da organização, filtrando pela organização no SQL", async () => {
    const { banco, filtros } = bancoFake({ companies: { id: EMPRESA } });
    expect(await conferirEmpresa(banco, ORG, EMPRESA)).toBe(true);
    expect(filtros).toContainEqual(["companies", "organization_id", ORG]);
    expect(filtros).toContainEqual(["companies", "id", EMPRESA]);
  });

  it("recusa a empresa que não é da organização (null volta do banco)", async () => {
    const { banco } = bancoFake({ companies: null });
    expect(await conferirEmpresa(banco, ORG, EMPRESA)).toBe(false);
  });

  it("sem resposta do banco a conferência falha FECHADA", async () => {
    const { banco } = bancoFake({ companies: new Error("banco fora do ar") });
    expect(await conferirEmpresa(banco, ORG, EMPRESA)).toBe(false);
  });
});

describe("empresaHerdada", () => {
  it("⭐ herda a empresa da demanda quando a tarefa nasce presa a ela", async () => {
    const { banco, filtros } = bancoFake({ demandas: { company_id: EMPRESA } });
    const heranca = await empresaHerdada(banco, {
      organizationId: ORG,
      demandaId: DEMANDA,
      contactId: CONTATO,
    });
    expect(heranca).toBe(EMPRESA);
    // a demanda é lida DENTRO da organização, nunca solta pelo id
    expect(filtros).toContainEqual(["demandas", "organization_id", ORG]);
    expect(filtros).toContainEqual(["demandas", "id", DEMANDA]);
    // a demanda achada com empresa DISPENSA a cadeia do contato
    expect(empresaDoContato).not.toHaveBeenCalled();
  });

  it("sem demanda, herda do contato pela cadeia `people`", async () => {
    vi.mocked(empresaDoContato).mockResolvedValueOnce({ id: EMPRESA, nome: "ACME", cnpj: null });
    const { banco } = bancoFake({});
    expect(
      await empresaHerdada(banco, { organizationId: ORG, contactId: CONTATO }),
    ).toBe(EMPRESA);
    expect(empresaDoContato).toHaveBeenCalledWith(banco, {
      organizationId: ORG,
      contactId: CONTATO,
    });
  });

  it("demanda sem empresa cai para o contato — a preferência é da demanda, a queda é do vazio", async () => {
    vi.mocked(empresaDoContato).mockResolvedValueOnce({ id: EMPRESA, nome: "ACME", cnpj: null });
    const { banco } = bancoFake({ demandas: { company_id: null } });
    expect(
      await empresaHerdada(banco, { organizationId: ORG, demandaId: DEMANDA, contactId: CONTATO }),
    ).toBe(EMPRESA);
  });

  it("nem demanda nem contato: null, sem consulta nenhuma", async () => {
    const { banco, filtros } = bancoFake({});
    expect(await empresaHerdada(banco, { organizationId: ORG })).toBeNull();
    expect(filtros).toEqual([]);
    expect(empresaDoContato).not.toHaveBeenCalled();
  });

  it("leitura que falha não derruba a criação da tarefa: herda null", async () => {
    const { banco } = bancoFake({ demandas: new Error("banco fora do ar") });
    expect(
      await empresaHerdada(banco, { organizationId: ORG, demandaId: DEMANDA }),
    ).toBeNull();
  });
});
