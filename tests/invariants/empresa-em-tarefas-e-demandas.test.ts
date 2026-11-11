import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Empresa em tarefas e demandas (migration 9340) — o que o BANCO segura:
 *
 *   - FK composta: empresa de OUTRA org recusada em crm_tasks e demandas;
 *   - apagar a empresa anula o ponteiro e PRESERVA o registro (set null de
 *     coluna única — organization_id não pode ser anulado junto);
 *   - índices parciais existem (o filtro por empresa é o caso de uso);
 *   - o vínculo é opcional: sem empresa, tudo funciona como antes.
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = "dddddddd-0000-4000-8000-000000009340";
const ORG_B = "dddddddd-0000-4000-8000-000000009341";
const CONTACT = "dddddddd-3333-4000-8000-000000009340";

async function criarEmpresa(organizationId: string, nome: string): Promise<string> {
  const r = await query("insert into companies(organization_id,trade_name) values($1,$2) returning id", [
    organizationId,
    nome,
  ]);
  return r.rows[0].id as string;
}

let empresaA = "";
let empresaB = "";

beforeAll(async () => {
  for (const [o, slug] of [
    [ORG, "empresa-9340-a"],
    [ORG_B, "empresa-9340-b"],
  ] as const) {
    await query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,$3,$4) on conflict(id) do nothing",
      [o, slug, slug, slug],
    );
  }
  await query("insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Empresa') on conflict(id) do nothing", [
    CONTACT,
    ORG,
  ]);
  empresaA = await criarEmpresa(ORG, "Cliente A");
  empresaB = await criarEmpresa(ORG_B, "Cliente B");
});

afterAll(async () => {
  await query("delete from organizations where id = any($1)", [[ORG, ORG_B]]);
  await pool.end();
});

beforeEach(async () => {
  await query("delete from crm_tasks where organization_id = any($1)", [[ORG, ORG_B]]);
  await query("delete from demandas where organization_id = any($1)", [[ORG, ORG_B]]);
});

describe("empresa em tarefas e demandas (9340)", () => {
  it("tarefa e demanda aceitam empresa da própria org (e seguem funcionando sem empresa)", async () => {
    const t = await query(
      "insert into crm_tasks(organization_id,title,company_id) values($1,'Ticket com empresa',$2) returning id, company_id",
      [ORG, empresaA],
    );
    expect(t.rows[0].company_id).toBe(empresaA);
    const d = await query(
      "insert into demandas(organization_id,contact_id,origem,dono_kind,company_id) values($1,$2,'manual','ia',$3) returning id, company_id",
      [ORG, CONTACT, empresaA],
    );
    expect(d.rows[0].company_id).toBe(empresaA);

    const semEmpresa = await query(
      "insert into crm_tasks(organization_id,title) values($1,'Ticket sem empresa') returning company_id",
      [ORG],
    );
    expect(semEmpresa.rows[0].company_id).toBeNull();
  });

  it("empresa de OUTRA organização é recusada pela FK composta (tarefa e demanda)", async () => {
    await expect(
      query("insert into crm_tasks(organization_id,title,company_id) values($1,'Invasor',$2)", [ORG, empresaB]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      query(
        "insert into demandas(organization_id,contact_id,origem,dono_kind,company_id) values($1,$2,'manual','ia',$3)",
        [ORG, CONTACT, empresaB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("apagar a empresa anula o ponteiro e PRESERVA tarefa e demanda (org intacta)", async () => {
    const descartavel = await criarEmpresa(ORG, "Descartável");
    const t = await query("insert into crm_tasks(organization_id,title,company_id) values($1,'Ticket',$2) returning id", [
      ORG,
      descartavel,
    ]);
    const d = await query(
      "insert into demandas(organization_id,contact_id,origem,dono_kind,company_id) values($1,$2,'manual','ia',$3) returning id",
      [ORG, CONTACT, descartavel],
    );

    await query("delete from companies where id=$1", [descartavel]);

    const rt = await query("select company_id, organization_id, title from crm_tasks where id=$1", [t.rows[0].id]);
    expect(rt.rows).toHaveLength(1);
    expect(rt.rows[0].company_id).toBeNull();
    expect(rt.rows[0].organization_id).toBe(ORG);
    expect(rt.rows[0].title).toBe("Ticket");
    const rd = await query("select company_id, organization_id from demandas where id=$1", [d.rows[0].id]);
    expect(rd.rows).toHaveLength(1);
    expect(rd.rows[0].company_id).toBeNull();
    expect(rd.rows[0].organization_id).toBe(ORG);
  });

  it("índices parciais por empresa existem nas duas tabelas", async () => {
    const r = await query(
      "select indexname from pg_indexes where schemaname='public' and indexname = any($1)",
      [["crm_tasks_org_company", "demandas_org_company"]],
    );
    expect(r.rows.map((x) => x.indexname).sort()).toEqual(["crm_tasks_org_company", "demandas_org_company"]);
  });
});
