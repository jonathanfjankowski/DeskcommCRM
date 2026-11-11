import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crm-b2b/enrich", () => ({
  enrichCompanyFromBrasilApi: vi.fn(async () => ({ status: "skipped" as const })),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { enrichCompanyFromBrasilApi } from "@/lib/crm-b2b/enrich";

import { empresaDoContato, vincularEmpresaPorCnpj } from "./empresa-por-cnpj";

/**
 * Vínculo empresa↔contato por CNPJ (spec §3.2/§3.3): a empresa NASCE do
 * documento, sem CRUD. normalize → busca por (org, normalized_cnpj) → cria se
 * falta → encadeia `people`/`company_people` (a cadeia B2B existente) → dispara
 * o enriquecimento BrasilAPI. Org SEMPRE de fonte confiável (input) e filtro
 * manual em toda query — service role bypassa RLS (doutrina).
 *
 * CNPJ válido clássico: 12.345.678/0001-95 (normalizado: 12345678000195).
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const EMPRESA_EXISTENTE = "55555555-5555-4555-8555-555555555555";
const NOVA_PESSOA = "66666666-6666-4666-8666-666666666666";
const NOVA_EMPRESA = "77777777-7777-4777-8777-777777777777";
const CNPJ = "12.345.678/0001-95";
const CNPJ_NORMALIZADO = "12345678000195";

interface Fakes {
  contacts?: Array<Record<string, unknown>>;
  companies?: Array<Record<string, unknown>>;
  companyPeople?: Array<Record<string, unknown>>;
  /**
   * A empresa só aparece na SEGUNDA busca: a primeira (antes do INSERT) não
   * acha, o INSERT estoura 23505 (corrida de outra aba salvando o mesmo CNPJ)
   * e a re-leitura resolve na linha que o outro venceu a gravar.
   */
  empresaSoAposConflito?: boolean;
}

function bancoFake(fakes: Fakes) {
  const gravadas = {
    companies: [] as Array<Record<string, unknown>>,
    people: [] as Array<Record<string, unknown>>,
    companyPeople: [] as Array<Record<string, unknown>>,
    contactUpdates: [] as Array<Record<string, unknown>>,
  };
  let olharesNaEmpresa = 0;

  const linhaDe = (tabela: string, filtros: Array<[string, unknown]>) => {
    let linhas: Array<Record<string, unknown>>;
    if (tabela === "contacts") linhas = fakes.contacts ?? [];
    else if (tabela === "companies") {
      olharesNaEmpresa += 1;
      linhas = fakes.empresaSoAposConflito && olharesNaEmpresa === 1 ? [] : fakes.companies ?? [];
    } else if (tabela === "company_people") linhas = fakes.companyPeople ?? [];
    else linhas = [];
    const achadas = linhas.filter((l) => filtros.every(([col, val]) => l[col] === val));
    return achadas[0] ?? null;
  };

  const banco = {
    from: (tabela: string) => {
      let filtros: Array<[string, unknown]> = [];
      const c = () => ({
        eq: (col: string, val: unknown) => {
          filtros = [...filtros, [col, val]];
          return c();
        },
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({ data: linhaDe(tabela, filtros), error: null }),
          }),
        }),
        maybeSingle: async () => ({ data: linhaDe(tabela, filtros), error: null }),
        single: async () => {
          const l = linhaDe(tabela, filtros);
          return l ? { data: l, error: null } : { data: null, error: { message: "nenhuma linha" } };
        },
      });
      return {
        select: () => c(),
        insert: (dados: Record<string, unknown>) => {
          if (tabela === "companies") {
            if (fakes.empresaSoAposConflito) {
              return {
                select: () => ({
                  single: async () => ({ data: null, error: { code: "23505", message: "duplicata" } }),
                }),
              };
            }
            const nova = { id: NOVA_EMPRESA, ...dados };
            fakes.companies = [...(fakes.companies ?? []), nova];
            gravadas.companies.push(dados);
            return { select: () => ({ single: async () => ({ data: nova, error: null }) }) };
          }
          if (tabela === "people") {
            gravadas.people.push(dados);
            return {
              select: () => ({ single: async () => ({ data: { id: NOVA_PESSOA, ...dados }, error: null }) }),
            };
          }
          throw new Error(`insert inesperado em ${tabela}`);
        },
        update: (dados: Record<string, unknown>) => {
          if (tabela === "contacts") gravadas.contactUpdates.push(dados);
          // update().eq().eq() termina sem terminal no nosso código: awaitable simples.
          return {
            eq: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        },
        upsert: (dados: Record<string, unknown>) => {
          gravadas.companyPeople.push(dados);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { banco: banco as unknown as SupabaseClient, gravadas };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vincularEmpresaPorCnpj", () => {
  it("CNPJ inválido: recusa antes de tocar no banco", async () => {
    const { banco, gravadas } = bancoFake({});
    const r = await vincularEmpresaPorCnpj(banco, { organizationId: ORG, contactId: CONTATO, cnpj: "123" });
    expect(r).toEqual({ ok: false, motivo: "cnpj_invalido" });
    expect(gravadas.companies).toEqual([]);
    expect(enrichCompanyFromBrasilApi).not.toHaveBeenCalled();
  });

  it("contato que não é DA ORG (fonte confiável) é recusado — nunca vincula", async () => {
    const { banco } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: OUTRA_ORG, display_name: "Ana", person_id: null }],
    });
    const r = await vincularEmpresaPorCnpj(banco, { organizationId: ORG, contactId: CONTATO, cnpj: CNPJ });
    expect(r).toEqual({ ok: false, motivo: "contato_inexistente" });
  });

  it("empresa existente: reusa, cria a pessoa, pontoa o contato e liga — sem empresa nova, sem enrich", async () => {
    const { banco, gravadas } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, display_name: "Ana Souza", person_id: null }],
      companies: [
        { id: EMPRESA_EXISTENTE, organization_id: ORG, normalized_cnpj: CNPJ_NORMALIZADO, trade_name: "Acme", legal_name: "Acme Ltda" },
      ],
    });
    const r = await vincularEmpresaPorCnpj(banco, { organizationId: ORG, contactId: CONTATO, cnpj: CNPJ });
    expect(r).toEqual({ ok: true, empresaId: EMPRESA_EXISTENTE, nome: "Acme", criada: false });
    expect(gravadas.companies).toEqual([]);
    expect(gravadas.people).toHaveLength(1);
    expect(gravadas.people[0]).toMatchObject({ organization_id: ORG, full_name: "Ana Souza" });
    expect(gravadas.contactUpdates).toEqual([{ person_id: NOVA_PESSOA }]);
    expect(gravadas.companyPeople[0]).toMatchObject({
      organization_id: ORG,
      company_id: EMPRESA_EXISTENTE,
      person_id: NOVA_PESSOA,
    });
    expect(enrichCompanyFromBrasilApi).not.toHaveBeenCalled();
  });

  it("empresa nova: nasce com normalized_cnpj e forma legível, enrich dispara, nome cai para o CNPJ formatado", async () => {
    const { banco, gravadas } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, display_name: "Carlos", person_id: NOVA_PESSOA }],
    });
    const r = await vincularEmpresaPorCnpj(banco, { organizationId: ORG, contactId: CONTATO, cnpj: CNPJ });
    expect(r).toEqual({ ok: true, empresaId: NOVA_EMPRESA, nome: "12.345.678/0001-95", criada: true });
    expect(gravadas.companies[0]).toMatchObject({
      organization_id: ORG,
      normalized_cnpj: CNPJ_NORMALIZADO,
      cnpj: "12.345.678/0001-95",
      enrichment_status: "pending",
    });
    expect(gravadas.people).toEqual([]); // contato já tinha person_id — nada de pessoa nova
    expect(gravadas.contactUpdates).toEqual([]); // e não se pointa de novo
    expect(enrichCompanyFromBrasilApi).toHaveBeenCalledTimes(1);
  });

  it("corrida (23505 no insert): a re-leitura resolve na empresa que o outro gravou — duplicata nunca é perda", async () => {
    const { banco } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, display_name: "Dana", person_id: NOVA_PESSOA }],
      companies: [
        { id: EMPRESA_EXISTENTE, organization_id: ORG, normalized_cnpj: CNPJ_NORMALIZADO, trade_name: null, legal_name: "Razão Social" },
      ],
      empresaSoAposConflito: true,
    });
    const r = await vincularEmpresaPorCnpj(banco, { organizationId: ORG, contactId: CONTATO, cnpj: CNPJ });
    expect(r).toEqual({ ok: true, empresaId: EMPRESA_EXISTENTE, nome: "Razão Social", criada: false });
    expect(enrichCompanyFromBrasilApi).not.toHaveBeenCalled(); // quem criou foi o outro
  });
});

describe("empresaDoContato", () => {
  it("contato sem pessoa: null (sem cadeia, sem empresa)", async () => {
    const { banco } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, person_id: null }],
    });
    expect(await empresaDoContato(banco, { organizationId: ORG, contactId: CONTATO })).toBeNull();
  });

  it("pessoa sem vínculo: null", async () => {
    const { banco } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, person_id: NOVA_PESSOA }],
    });
    expect(await empresaDoContato(banco, { organizationId: ORG, contactId: CONTATO })).toBeNull();
  });

  it("com vínculo: devolve id e nome (trade_name preferida à legal_name)", async () => {
    const { banco } = bancoFake({
      contacts: [{ id: CONTATO, organization_id: ORG, person_id: NOVA_PESSOA }],
      companies: [
        {
          id: EMPRESA_EXISTENTE,
          organization_id: ORG,
          normalized_cnpj: CNPJ_NORMALIZADO,
          trade_name: "Loja da Esquina",
          legal_name: "J. da Silva Ltda",
          cnpj: "11.222.333/0001-81",
        },
      ],
      companyPeople: [
        { organization_id: ORG, company_id: EMPRESA_EXISTENTE, person_id: NOVA_PESSOA, is_primary: true },
      ],
    });
    expect(await empresaDoContato(banco, { organizationId: ORG, contactId: CONTATO })).toEqual({
      id: EMPRESA_EXISTENTE,
      nome: "Loja da Esquina",
      cnpj: "11.222.333/0001-81",
    });
  });
});
