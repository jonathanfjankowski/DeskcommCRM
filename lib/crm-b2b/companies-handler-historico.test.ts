/**
 * FICHA DA EMPRESA — atendimentos e tarefas (spec 2026-11-11 §6, Task 14).
 *
 * `getCompanyHandler` deixa de devolver só o cadastro: quem abre a ficha de
 * um cliente quer ver o HISTÓRICO — os atendimentos (demandas) e as tarefas
 * vinculadas àquela empresa. Duas leituras novas, ambas com `organization_id`
 * do contexto e `company_id` da ficha (service role bypassa RLS: o filtro é à
 * mão, doutrina), teto 50 por lista porque a ficha é painel, não banco.
 *
 * A leitura é TOLERANTE como as outras duas (`people`/`contacts`): falha em
 * histórico não derruba a ficha do cadastro que já foi achado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";

import { getCompanyHandler } from "./companies-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "22222222-2222-4222-8222-222222222222";

const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "u-1", role: "manager" },
  requestId: "req-test",
  idioma: "pt-BR",
};

const DEMANDAS = [
  {
    id: "d-1",
    assunto: "Impressora sem responder",
    resumo_encerramento: "Trocado o cabo; cliente confirmou.",
    estado: "encerrada",
    desfecho: "resolvida",
    aberta_em: "2026-11-01T10:00:00Z",
    fechada_em: "2026-11-01T12:00:00Z",
    company_id: EMPRESA,
    contact_id: "c-1",
  },
];

const TAREFAS = [
  {
    id: "t-1",
    title: "Ligar de volta na terça",
    status: "pending",
    priority: "medium",
    due_date: null,
    created_at: "2026-11-02T09:00:00Z",
  },
];

function bancoFake(opcoes: { erroNoHistorico?: boolean } = {}) {
  const filtros: Array<[string, string, unknown]> = [];
  const pedidos: Array<[string, string, unknown]> = [];

  const elo = (tabela: string) => {
    let le: Array<[string, unknown]> = [];
    const e: Record<string, unknown> = {};
    const registrar = () => {
      filtros.push(...le.map(([col, val]) => [tabela, col, val] as [string, string, unknown]));
      le = [];
    };
    e.select = () => e;
    for (const metodo of ["eq", "in", "is"]) {
      e[metodo] = (col: string, val: unknown) => {
        le.push([col, val]);
        return e;
      };
    }
    e.order = (col: string, opts: unknown) => {
      registrar();
      pedidos.push([tabela, "order", `${col}:${JSON.stringify(opts)}`]);
      return e;
    };
    e.limit = (n: number) => {
      pedidos.push([tabela, "limit", n]);
      return e;
    };
    e.maybeSingle = async () => {
      registrar();
      if (tabela === "companies") {
        return { data: { id: EMPRESA, trade_name: "UFU Telecom", legal_name: null }, error: null };
      }
      return { data: null, error: null };
    };
    e.then = (res: (v: unknown) => unknown) => {
      registrar();
      if (opcoes.erroNoHistorico && (tabela === "demandas" || tabela === "crm_tasks")) {
        return Promise.resolve({ data: null, error: { message: "banco fora do ar" } }).then(res);
      }
      if (tabela === "demandas") return Promise.resolve({ data: DEMANDAS, error: null }).then(res);
      if (tabela === "crm_tasks") return Promise.resolve({ data: TAREFAS, error: null }).then(res);
      return Promise.resolve({ data: [], error: null }).then(res);
    };
    return e;
  };

  const banco = { from: (tabela: string) => elo(tabela) } as unknown as SupabaseClient;
  return { banco, filtros, pedidos };
}

describe("getCompanyHandler — histórico na ficha", () => {
  it("⭐ devolve as demandas da empresa (título, registro, desfecho, datas, contato)", async () => {
    const { banco, filtros, pedidos } = bancoFake();
    const resultado = await getCompanyHandler(banco, CTX, EMPRESA);

    expect(resultado.demandas).toEqual(DEMANDAS);
    // as duas mãos do filtro: a organização do contexto E a empresa da ficha
    expect(filtros).toContainEqual(["demandas", "organization_id", ORG]);
    expect(filtros).toContainEqual(["demandas", "company_id", EMPRESA]);
    // da mais nova para a mais velha, com teto de painel
    expect(pedidos).toContainEqual(["demandas", "order", 'aberta_em:{"ascending":false}']);
    expect(pedidos).toContainEqual(["demandas", "limit", 50]);
  });

  it("⭐ devolve as tarefas da empresa, mais recentes primeiro", async () => {
    const { banco, filtros, pedidos } = bancoFake();
    const resultado = await getCompanyHandler(banco, CTX, EMPRESA);

    expect(resultado.tarefas).toEqual(TAREFAS);
    expect(filtros).toContainEqual(["crm_tasks", "organization_id", ORG]);
    expect(filtros).toContainEqual(["crm_tasks", "company_id", EMPRESA]);
    expect(pedidos).toContainEqual(["crm_tasks", "order", 'created_at:{"ascending":false}']);
    expect(pedidos).toContainEqual(["crm_tasks", "limit", 50]);
  });

  it("falha no histórico não derruba a ficha: cadastro continua, lista fica vazia", async () => {
    const { banco } = bancoFake({ erroNoHistorico: true });
    const resultado = await getCompanyHandler(banco, CTX, EMPRESA);
    expect(resultado.company).toBeTruthy();
    expect(resultado.demandas).toEqual([]);
    expect(resultado.tarefas).toEqual([]);
  });
});
