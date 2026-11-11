import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Registro de atendimento (migration 9339) — o que o BANCO segura:
 *
 *   - `fn_demanda_encerrar` aceita título + conteúdo (7 args) e grava em
 *     `assunto`/`resumo_encerramento`; a atividade `demand_closed` carrega o
 *     título;
 *   - compatibilidade: chamada de 5 args (sem registro) preserva o assunto e
 *     não escreve resumo;
 *   - conflito: encerrar duas vezes com a mesma revision → PT409;
 *   - LGPD: a cascata redige título E conteúdo, preservando o fato operacional
 *     (desfecho, datas, estado); o trigger de anonimização redige o conteúdo
 *     por QUALQUER caminho que anonimize o contato, não só a cascata.
 *
 * Org própria: a anonimização do teste não pode contaminar os contatos
 * compartilhados do seedGov (outros arquivos rodam no mesmo banco).
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = "dddddddd-0000-4000-8000-000000009339";
const USER = "dddddddd-1111-4000-8000-000000009339";
const CONTACT = "dddddddd-3333-4000-8000-000000009339";
const PIPELINE = "dddddddd-4444-4000-8000-000000009339";
const STAGE = "dddddddd-5555-4000-8000-000000009339";
const LEAD = "dddddddd-6666-4000-8000-000000009339";

async function criarDemanda(assunto: string | null, resumo: string | null) {
  const r = await query(
    `insert into demandas(organization_id,contact_id,lead_id,origem,assunto,estado,dono_kind,resumo_encerramento)
     values($1,$2,$3,'manual',$4,'aberta','ia',$5) returning id, revision`,
    [ORG, CONTACT, LEAD, assunto, resumo],
  );
  return r.rows[0] as { id: string; revision: number };
}

async function encerrar(id: string, revision: number, titulo?: string, conteudo?: string) {
  return query("select * from fn_demanda_encerrar($1,$2,$3,$4,$5,$6,$7)", [
    ORG,
    id,
    revision,
    "resolvida",
    USER,
    titulo ?? null,
    conteudo ?? null,
  ]);
}

beforeAll(async () => {
  await query("insert into auth.users(id,email) values($1,'registro-9339@invariant.test') on conflict(id) do nothing", [USER]);
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'registro-9339','Registro 9339','Registro 9339') on conflict(id) do nothing",
    [ORG],
  );
  await query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now()) on conflict do nothing",
    [USER, ORG],
  );
  await query("insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Registro') on conflict(id) do nothing", [
    CONTACT,
    ORG,
  ]);
  await query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Registro','registro-9339') on conflict(id) do nothing", [
    PIPELINE,
    ORG,
  ]);
  await query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo','novo',1000) on conflict(id) do nothing",
    [STAGE, ORG, PIPELINE],
  );
  await query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Lead Registro') on conflict(id) do nothing",
    [LEAD, ORG, PIPELINE, STAGE, CONTACT],
  );
});

afterAll(async () => {
  await query("delete from organizations where id=$1", [ORG]);
  await pool.end();
});

beforeEach(async () => {
  await query("delete from demandas where organization_id=$1", [ORG]);
  await query("delete from crm_lead_activities where organization_id=$1", [ORG]);
  await query("update contacts set is_anonymized=false, anonymized_at=null where id=$1", [CONTACT]);
});

describe("registro de atendimento (9339)", () => {
  it("encerrar com título e conteúdo grava na demanda e o título na timeline", async () => {
    const d = await criarDemanda("Assunto original", null);
    await encerrar(d.id, d.revision, "Erro de acesso resolvido", "Cliente relatou X; fizemos Y; validado com o cliente.");

    const r = await query("select assunto, resumo_encerramento, desfecho, estado, fechada_em from demandas where id=$1", [d.id]);
    expect(r.rows[0].assunto).toBe("Erro de acesso resolvido");
    expect(r.rows[0].resumo_encerramento).toBe("Cliente relatou X; fizemos Y; validado com o cliente.");
    expect(r.rows[0].desfecho).toBe("resolvida");
    expect(r.rows[0].estado).toBe("resolvida");
    expect(r.rows[0].fechada_em).not.toBeNull();

    const a = await query(
      "select payload from crm_lead_activities where organization_id=$1 and type='demand_closed' and source_id=$2",
      [ORG, d.id],
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].payload.titulo).toBe("Erro de acesso resolvido");
    expect(a.rows[0].payload.desfecho).toBe("resolvida");
  });

  it("compatibilidade: 5 args preserva o assunto e não escreve resumo", async () => {
    const d = await criarDemanda("Assunto original", null);
    await query("select * from fn_demanda_encerrar($1,$2,$3,$4,$5)", [ORG, d.id, d.revision, "nao_procede", USER]);

    const r = await query("select assunto, resumo_encerramento, desfecho from demandas where id=$1", [d.id]);
    expect(r.rows[0].assunto).toBe("Assunto original");
    expect(r.rows[0].resumo_encerramento).toBeNull();
    expect(r.rows[0].desfecho).toBe("nao_procede");
  });

  it("título null no registro preserva o assunto existente; conteúdo é gravado", async () => {
    const d = await criarDemanda("Assunto original", null);
    await encerrar(d.id, d.revision, undefined, "Só o conteúdo.");
    const r = await query("select assunto, resumo_encerramento from demandas where id=$1", [d.id]);
    expect(r.rows[0].assunto).toBe("Assunto original");
    expect(r.rows[0].resumo_encerramento).toBe("Só o conteúdo.");
  });

  it("conflito: encerrar duas vezes com a mesma revision → PT409", async () => {
    const d = await criarDemanda("Assunto", null);
    await encerrar(d.id, d.revision, "Título", "Conteúdo");
    await expect(encerrar(d.id, d.revision, "Outro", "Outro")).rejects.toMatchObject({ code: "PT409" });
  });

  it("LGPD: cascata redige título e conteúdo, preserva o fato operacional", async () => {
    const d = await criarDemanda("Segredo pessoal", "Conteúdo com dado pessoal");
    await encerrar(d.id, d.revision, "Título pessoal", "Conteúdo pessoal");

    await query("select fn_lgpd_cascade_redact_contact($1,$2,null)", [ORG, CONTACT]);

    const r = await query("select assunto, resumo_encerramento, desfecho, estado, fechada_em from demandas where id=$1", [d.id]);
    expect(r.rows[0].assunto).toBeNull();
    expect(r.rows[0].resumo_encerramento).toBeNull();
    expect(r.rows[0].desfecho).toBe("resolvida");
    expect(r.rows[0].estado).toBe("resolvida");
    expect(r.rows[0].fechada_em).not.toBeNull();
  });

  it("LGPD: trigger redige o conteúdo por qualquer caminho de anonimização (sem cascata)", async () => {
    const d = await criarDemanda("Assunto", "Conteúdo com dado pessoal");
    await query("update contacts set is_anonymized=true, anonymized_at=now() where id=$1", [CONTACT]);
    const r = await query("select resumo_encerramento from demandas where id=$1", [d.id]);
    expect(r.rows[0].resumo_encerramento).toBeNull();
  });
});
