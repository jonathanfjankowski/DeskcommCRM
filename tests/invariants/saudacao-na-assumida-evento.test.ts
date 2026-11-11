import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Saudação na assumida (migration 9341) — o que o BANCO segura:
 *
 *   - claim/transfer/routing/handoff a humano com dono real → evento
 *     `conversation.atendente_assumiu` pending, com o payload do handler;
 *   - release (to_user null) e motivo fora do vocabulário → NÃO emite;
 *   - atribuição que não corresponde ao dono real → NÃO emite (guarda do
 *     trigger irmão);
 *   - o evento é consumível (pending), não registro (done).
 *
 * O envio da mensagem é do handler (teste unit próprio); aqui é o fato.
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 3,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = "dddddddd-0000-4000-8000-000000009341";
const USER_A = "dddddddd-1111-4000-8000-000000009341";
const USER_B = "dddddddd-1111-4000-8000-000000009342";
const CONTACT = "dddddddd-3333-4000-8000-000000009341";
const CANAL = "dddddddd-2222-4000-8000-000000009341";
const CONV = "dddddddd-4444-4000-8000-000000009341";

async function atribuir(user: string | null, reason: string) {
  return query("select * from fn_conversation_assign($1,$2,$3,$4)", [ORG, CONV, user, reason]);
}

async function eventos() {
  const r = await query(
    "select payload, status, entity_kind, entity_id from event_log where organization_id=$1 and event_type='conversation.atendente_assumiu' order by created_at",
    [ORG],
  );
  return r.rows;
}

beforeAll(async () => {
  for (const [u, tag] of [
    [USER_A, "saudacao-a"],
    [USER_B, "saudacao-b"],
  ] as const) {
    await query("insert into auth.users(id,email) values($1,$2||'@invariant.test') on conflict(id) do nothing", [u, tag]);
  }
  await query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'saudacao-9341','Saudação 9341','Saudação 9341') on conflict(id) do nothing",
    [ORG],
  );
  for (const u of [USER_A, USER_B]) {
    await query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now()) on conflict do nothing",
      [u, ORG],
    );
  }
  await query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,'saudacao-9341',decode('00','hex')) on conflict(id) do nothing",
    [CANAL, ORG],
  );
  await query("insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Saudação') on conflict(id) do nothing", [
    CONTACT,
    ORG,
  ]);
  await query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open') on conflict(id) do nothing",
    [CONV, ORG, CONTACT, CANAL],
  );
});

afterAll(async () => {
  await query("delete from organizations where id=$1", [ORG]);
  await pool.end();
});

beforeEach(async () => {
  await query("delete from event_log where organization_id=$1", [ORG]);
  await query("delete from conversation_assignment_events where organization_id=$1", [ORG]);
  await query(
    "update conversations set assigned_to_user_id=null, assigned_to_user_name=null, assignee_kind=null, status='open' where id=$1",
    [CONV],
  );
});

describe("saudação na assumida (9341)", () => {
  it("claim emite evento pending com o payload do handler", async () => {
    await atribuir(USER_A, "claim");
    const ev = await eventos();
    expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe("pending");
    expect(ev[0].entity_kind).toBe("conversation");
    expect(ev[0].entity_id).toBe(CONV);
    expect(ev[0].payload.conversation_id).toBe(CONV);
    expect(ev[0].payload.to_user_id).toBe(USER_A);
    expect(ev[0].payload.reason).toBe("claim");
    expect(ev[0].payload.assignment_event_id).toBeTruthy();
  });

  it("transfer emite de novo (novo dono, nova saudação)", async () => {
    await atribuir(USER_A, "claim");
    await atribuir(USER_B, "transfer");
    const ev = await eventos();
    expect(ev).toHaveLength(2);
    expect(ev[1].payload.to_user_id).toBe(USER_B);
    expect(ev[1].payload.reason).toBe("transfer");
  });

  it("routing (distribuição automática) emite", async () => {
    await atribuir(USER_A, "routing");
    const ev = await eventos();
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.reason).toBe("routing");
  });

  it("release NÃO emite (devolver não é assumir)", async () => {
    await atribuir(USER_A, "claim");
    await atribuir(null, "release");
    const ev = await eventos();
    expect(ev).toHaveLength(1);
  });

  it("atribuição que não corresponde ao dono real NÃO emite", async () => {
    await atribuir(USER_A, "claim");
    await query("delete from event_log where organization_id=$1", [ORG]);
    // Fato órfão: to_user é USER_B, mas o dono real continua USER_A.
    await query(
      "insert into conversation_assignment_events(organization_id,conversation_id,from_user_id,to_user_id,reason) values($1,$2,$3,$4,'transfer')",
      [ORG, CONV, USER_A, USER_B],
    );
    expect(await eventos()).toHaveLength(0);
  });
});
