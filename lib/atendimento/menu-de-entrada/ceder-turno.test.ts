import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { deveCederTurnoAoMenu } from "./ceder-turno";

/**
 * O gate do dreno (spec 2026-11-11 §3.5): enquanto o menu possui a conversa,
 * o turno de IA não é nem enfileirado. Padrão do irmão
 * `deveCederTurnoAoRetorno`: fail-ABERTO para o fluxo normal — erro de leitura
 * devolve `false` (a IA segue o caminho de sempre) nunca cala quem depende
 * dela; quem QUER silêncio total liga o modo humano.
 *
 * A pergunta é uma só, NUMA consulta: canal com menu ativo E (estado vivo nesta
 * service_revision OU conversa que o menu ainda vai começar — sem dono, sem
 * fila, em aberto, não-grupo, contato não bloqueado). O `startable` espelha o
 * do handler; as duas metades divergirem é o turno IA+menu na mesma mensagem.
 */
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
type PoolComQueryMock = Pick<Pool, "query"> & { query: ReturnType<typeof vi.fn<QueryFn>> };

function poolDe(linhas: Array<Record<string, unknown>> | "lança"): PoolComQueryMock {
  const query = vi.fn<QueryFn>(async () => {
    if (linhas === "lança") throw new Error("banco fora do ar");
    return { rows: linhas };
  });
  // Pool.query tem sobrecargas demais para o mock caber direto; o cast é só da
  // fronteira do teste — a função chamada é exatamente a que a implementação usa.
  return { query } as unknown as PoolComQueryMock;
}

const PEDIDO = { organizationId: "org-1", conversationId: "conv-1" };

describe("deveCederTurnoAoMenu", () => {
  it("menu possui a conversa (a consulta devolve linha): cede", async () => {
    const pool = poolDe([{ cede: 1 }]);
    expect(await deveCederTurnoAoMenu(pool, PEDIDO)).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const chamada = pool.query.mock.calls[0];
    expect(chamada).toBeDefined();
    expect(String(chamada?.[0])).toContain("menu_de_entrada");
    expect(String(chamada?.[0])).toContain("bot_silenced_until"); // a posse silenciada também vale
    expect(chamada?.[1]).toEqual(["org-1", "conv-1"]);
  });

  it("sem posse (consulta vazia): não cede", async () => {
    expect(await deveCederTurnoAoMenu(poolDe([]), PEDIDO)).toBe(false);
  });

  it("erro de leitura é FAIL-ABERTO para o fluxo normal: não cede, loga", async () => {
    expect(await deveCederTurnoAoMenu(poolDe("lança"), PEDIDO)).toBe(false);
  });
});
