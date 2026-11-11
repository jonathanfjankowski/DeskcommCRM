import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { seedGov, GOV_ORG as org, GOV_AGENT_A as ana, GOV_MANAGER as manager, GOV_SESSION } from "./gov-helpers";

/**
 * Menu de entrada (migration 9338) — o que o BANCO segura, sem depender das rotas:
 *
 *   - `authenticated` só LÊ (nem o manager escreve direto pela REST — a escrita
 *     é da rota de settings, manager+, auditada);
 *   - leitura isolada por organização, com controle positivo;
 *   - FKs compostas: setor e canal de OUTRA org recusados;
 *   - um menu por número; setor duplicado no mesmo menu recusado;
 *   - apagar setor apaga a opção; apagar canal apaga o menu; apagar o setor
 *     PADRÃO anula só setor_padrao_id (a config sobrevive).
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000932";
const OUTRO_USER = "dddddddd-1111-4000-8000-000000000932";

async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

async function criarCanal(organizationId: string): Promise<string> {
  const r = await query(
    "insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,gen_random_uuid()::text,'WORKING',decode('00','hex')) returning id",
    [organizationId],
  );
  return r.rows[0].id as string;
}

async function criarSetor(organizationId: string, name: string): Promise<string> {
  const r = await query("insert into attendant_sectors(organization_id,name) values($1,$2) returning id", [
    organizationId,
    name,
  ]);
  return r.rows[0].id as string;
}

async function criarMenu(organizationId: string, canal: string, setorPadrao: string | null = null): Promise<string> {
  const r = await query(
    "insert into menu_de_entrada(organization_id,channel_session_id,ativo,pedir_cnpj,setor_padrao_id) values($1,$2,true,true,$3) returning id",
    [organizationId, canal, setorPadrao],
  );
  return r.rows[0].id as string;
}

async function criarOpcao(organizationId: string, menu: string, setor: string, rotulo: string, ordem: number) {
  const r = await query(
    "insert into menu_de_entrada_opcoes(organization_id,menu_id,sector_id,rotulo,ordem) values($1,$2,$3,$4,$5) returning id",
    [organizationId, menu, setor, rotulo, ordem],
  );
  return r.rows[0].id as string;
}

let canalOutra = "";
let setorA1 = "";
let setorA2 = "";
let setorB1 = "";

beforeAll(async () => {
  seedGov();
  await query("insert into auth.users(id,email) values($1,'menu-outra@invariant.test') on conflict(id) do nothing", [
    OUTRO_USER,
  ]);
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'menu-outra-9338','Menu Outra','Menu Outra') on conflict(id) do nothing",
    [OUTRA_ORG],
  );
  await query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now()) on conflict do nothing",
    [OUTRO_USER, OUTRA_ORG],
  );
  canalOutra = await criarCanal(OUTRA_ORG);
  setorA1 = await criarSetor(org, "Suporte 9338");
  setorA2 = await criarSetor(org, "Financeiro 9338");
  setorB1 = await criarSetor(OUTRA_ORG, "Comercial 9338");
});

afterAll(async () => {
  await query("delete from menu_de_entrada where organization_id = any($1)", [[org, OUTRA_ORG]]);
  await query("delete from channel_sessions where organization_id = $1", [OUTRA_ORG]);
  await query("delete from attendant_sectors where organization_id = any($1)", [[org, OUTRA_ORG]]);
  await pool.end();
});

beforeEach(async () => {
  await query("delete from menu_de_entrada where organization_id = any($1)", [[org, OUTRA_ORG]]);
});

describe("menu de entrada (9338)", () => {
  it("cada org lê só o próprio menu e opções (com controle positivo)", async () => {
    const menuA = await criarMenu(org, GOV_SESSION, setorA1);
    await criarOpcao(org, menuA, setorA1, "Suporte", 0);
    await criarOpcao(org, menuA, setorA2, "Financeiro", 1);
    const menuB = await criarMenu(OUTRA_ORG, canalOutra);
    await criarOpcao(OUTRA_ORG, menuB, setorB1, "Comercial", 0);

    const daAna = await asUser(ana, "select organization_id from menu_de_entrada");
    expect(daAna.rows.map((r) => r.organization_id)).toEqual([org]);
    const opcoesDaAna = await asUser(ana, "select count(*)::int n from menu_de_entrada_opcoes");
    expect(opcoesDaAna.rows[0].n).toBe(2);

    const daOutra = await asUser(OUTRO_USER, "select organization_id from menu_de_entrada");
    expect(daOutra.rows.map((r) => r.organization_id)).toEqual([OUTRA_ORG]);
    const opcoesDaOutra = await asUser(OUTRO_USER, "select count(*)::int n from menu_de_entrada_opcoes");
    expect(opcoesDaOutra.rows[0].n).toBe(1);
  });

  it("authenticated não escreve — nem o manager", async () => {
    const menuA = await criarMenu(org, GOV_SESSION);
    await expect(
      asUser(manager, "insert into menu_de_entrada(organization_id,channel_session_id) values($1,$2)", [
        org,
        GOV_SESSION,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(manager, "update menu_de_entrada set ativo=false where id=$1", [menuA]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(manager, "delete from menu_de_entrada where id=$1", [menuA])).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      asUser(manager, "insert into menu_de_entrada_opcoes(organization_id,menu_id,sector_id,rotulo,ordem) values($1,$2,$3,'X',0)", [
        org,
        menuA,
        setorA1,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("setor de OUTRA organização é recusado pela FK composta", async () => {
    const menuA = await criarMenu(org, GOV_SESSION);
    await expect(criarOpcao(org, menuA, setorB1, "Invasor", 0)).rejects.toMatchObject({ code: "23503" });
  });

  it("canal de OUTRA organização é recusado pela FK composta", async () => {
    await expect(criarMenu(org, canalOutra)).rejects.toMatchObject({ code: "23503" });
  });

  it("um menu por número; setor duplicado no menu recusado", async () => {
    const menuA = await criarMenu(org, GOV_SESSION);
    await expect(criarMenu(org, GOV_SESSION)).rejects.toMatchObject({ code: "23505" });
    await criarOpcao(org, menuA, setorA1, "Suporte", 0);
    await expect(criarOpcao(org, menuA, setorA1, "Suporte bis", 1)).rejects.toMatchObject({ code: "23505" });
  });

  it("apagar o setor apaga a opção; o menu segue com as restantes", async () => {
    const menuA = await criarMenu(org, GOV_SESSION);
    await criarOpcao(org, menuA, setorA1, "Suporte", 0);
    await criarOpcao(org, menuA, setorA2, "Financeiro", 1);
    const setorDescartavel = await criarSetor(org, "Descartável 9338");
    await criarOpcao(org, menuA, setorDescartavel, "Descartável", 2);

    await query("delete from attendant_sectors where id=$1", [setorDescartavel]);

    const restantes = await query("select rotulo from menu_de_entrada_opcoes where menu_id=$1 order by ordem", [menuA]);
    expect(restantes.rows.map((r) => r.rotulo)).toEqual(["Suporte", "Financeiro"]);
    const menu = await query("select id from menu_de_entrada where id=$1", [menuA]);
    expect(menu.rows).toHaveLength(1);
  });

  it("apagar o canal apaga o menu e as opções (cascade)", async () => {
    const canalDescartavel = await criarCanal(org);
    const menuA = await criarMenu(org, canalDescartavel);
    await criarOpcao(org, menuA, setorA1, "Suporte", 0);

    await query("delete from channel_sessions where id=$1", [canalDescartavel]);

    expect((await query("select id from menu_de_entrada where id=$1", [menuA])).rows).toHaveLength(0);
    expect((await query("select id from menu_de_entrada_opcoes where menu_id=$1", [menuA])).rows).toHaveLength(0);
  });

  it("apagar o setor PADRÃO anula só setor_padrao_id — a config sobrevive", async () => {
    const setorPadrao = await criarSetor(org, "Padrão 9338");
    const menuA = await criarMenu(org, GOV_SESSION, setorPadrao);

    await query("delete from attendant_sectors where id=$1", [setorPadrao]);

    const r = await query("select setor_padrao_id, ativo from menu_de_entrada where id=$1", [menuA]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].setor_padrao_id).toBeNull();
    expect(r.rows[0].ativo).toBe(true);
  });
});
