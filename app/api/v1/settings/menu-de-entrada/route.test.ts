import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { TEXTOS_PADRAO_DO_MENU } from "@/lib/atendimento/menu-de-entrada/schema";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/setores-modulo", () => ({ seSetoresDesligado: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CANAL_ID = "33333333-3333-4333-8333-333333333333";
const OUTRO_CANAL_ID = "33333333-9999-4333-8333-333333339999";
const MENU_ID = "44444444-4444-4444-8444-444444444444";
const S1 = "55555555-5555-4555-8555-555555555555";
const S2 = "66666666-6666-4666-8666-666666666666";

interface Cenario {
  canais?: unknown[];
  /** `true` = o número pedido no PUT existe na org. */
  canalDaOrg?: boolean;
  configs?: unknown[];
  opcoes?: unknown[];
  /** ids de `attendant_sectors` que PERTENCEM à org (o `.in` devolve só estes). */
  setoresDaOrg?: string[];
  erroNaLeitura?: boolean;
}

interface Chamada {
  tabela: string;
  operacao: string;
  linha?: unknown;
  onConflict?: string;
  filtros: string[];
  inValores?: unknown[];
}

/**
 * Fake do admin client no estilo da casa (`settings/catalogo/route.test.ts`):
 * registra TODA chamada (tabela, operação, linha, filtros) e devolve as listas
 * do cenário. `organization_id` filtrado à mão é o contrato do service role —
 * o fake deixa a asserção visível.
 */
function montarBanco(p: Cenario) {
  const chamadas: Chamada[] = [];
  const erro = p.erroNaLeitura ? { message: "fora do ar" } : null;
  const listas: Record<string, unknown[]> = {
    channel_sessions: p.canais ?? [],
    menu_de_entrada: p.configs ?? [],
    menu_de_entrada_opcoes: p.opcoes ?? [],
    attendant_sectors: (p.setoresDaOrg ?? []).map((id) => ({ id })),
  };
  const tabela = (nome: string) => {
    const filtros: string[] = [];
    let inValores: unknown[] | undefined;
    const ops: Record<string, unknown> = {};
    const terminal = () => {
      const lista = listas[nome] ?? [];
      return { data: erro ? null : lista, error: erro };
    };
    ops.select = () => ops;
    ops.eq = (col: string, valor: unknown) => {
      filtros.push(`${col}=${String(valor)}`);
      return ops;
    };
    ops.is = () => ops;
    ops.order = () => ops;
    ops.not = () => ops;
    ops.in = (_col: string, valores: unknown[]) => {
      inValores = valores;
      return ops;
    };
    ops.maybeSingle = async () => {
      if (nome === "channel_sessions") {
        return { data: p.canalDaOrg ? { id: CANAL_ID } : null, error: erro };
      }
      return { data: (listas[nome] as unknown[])[0] ?? null, error: erro };
    };
    ops.single = async () => ({ data: { id: MENU_ID }, error: null });
    ops.upsert = (linha: unknown, opts?: { onConflict?: string }) => {
      chamadas.push({
        tabela: nome,
        operacao: "upsert",
        linha,
        onConflict: opts?.onConflict,
        filtros,
        inValores,
      });
      return ops;
    };
    ops.delete = () => {
      // O array é por referência: no builder real os `.eq()` vêm DEPOIS do
      // `delete()`, e é no fim da cadeia que a asserção precisa ver os filtros.
      chamadas.push({ tabela: nome, operacao: "delete", filtros });
      return ops;
    };
    // As listas do GET são awaited direto no builder (thenable, como o cliente real).
    ops.then = (resolve: (v: unknown) => unknown) => resolve(terminal());
    return ops;
  };
  return { banco: { from: (nome: string) => tabela(nome) }, chamadas };
}

async function put(corpo: unknown): Promise<Response> {
  const { PUT } = await import("./route");
  return PUT(
    new NextRequest("http://localhost/api/v1/settings/menu-de-entrada", {
      method: "PUT",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function get(): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest("http://localhost/api/v1/settings/menu-de-entrada"));
}

const corpoValido = {
  channel_session_id: CANAL_ID,
  ativo: true,
  pedir_cnpj: false,
  textos: TEXTOS_PADRAO_DO_MENU,
  setor_padrao_id: S2,
  opcoes: [
    { sector_id: S1, rotulo: "Suporte técnico", ordem: 0 },
    { sector_id: S2, rotulo: "Financeiro", ordem: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(seSetoresDesligado).mockResolvedValue(null);
  void import("@/lib/impersonate/support").then(({ requireSupportWrite }) => {
    vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  });
});

describe("PUT /api/v1/settings/menu-de-entrada", () => {
  it("salva a config do número e as opções, com os conflitos certos, e audita", async () => {
    const { banco, chamadas } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1, S2] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await put(corpoValido);

    expect(r.status).toBe(200);
    const upsertConfig = chamadas.find((c) => c.tabela === "menu_de_entrada" && c.operacao === "upsert");
    expect(upsertConfig?.onConflict).toBe("organization_id,channel_session_id");
    expect(upsertConfig?.linha).toMatchObject({
      organization_id: ORG_ID,
      channel_session_id: CANAL_ID,
      ativo: true,
      pedir_cnpj: false,
      setor_padrao_id: S2,
    });
    const upsertOpcoes = chamadas.find(
      (c) => c.tabela === "menu_de_entrada_opcoes" && c.operacao === "upsert",
    );
    expect(upsertOpcoes?.onConflict).toBe("menu_id,sector_id");
    expect(upsertOpcoes?.linha).toEqual([
      { organization_id: ORG_ID, menu_id: MENU_ID, sector_id: S1, rotulo: "Suporte técnico", ordem: 0 },
      { organization_id: ORG_ID, menu_id: MENU_ID, sector_id: S2, rotulo: "Financeiro", ordem: 1 },
    ]);
    const deleteOpcoes = chamadas.find(
      (c) => c.tabela === "menu_de_entrada_opcoes" && c.operacao === "delete",
    );
    expect(deleteOpcoes?.filtros).toContain(`organization_id=${ORG_ID}`);
    expect(deleteOpcoes?.filtros).toContain(`menu_id=${MENU_ID}`);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.menu_de_entrada_changed",
        organizationId: ORG_ID,
      }),
    );
  });

  it("sem textos no corpo, os oitos defaults semeados entram na config (textos intactos = padrão)", async () => {
    const { banco, chamadas } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await put({ ...corpoValido, setor_padrao_id: null, textos: undefined, opcoes: [{ sector_id: S1, rotulo: "Suporte", ordem: 0 }] });

    expect(r.status).toBe(200);
    const upsertConfig = chamadas.find((c) => c.tabela === "menu_de_entrada" && c.operacao === "upsert");
    expect((upsertConfig?.linha as { textos: unknown }).textos).toEqual(TEXTOS_PADRAO_DO_MENU);
  });

  it("setor de fora da org vira 422 nomeando o id, e nada é escrito", async () => {
    const { banco, chamadas } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await put(corpoValido);

    expect(r.status).toBe(422);
    const corpo = (await r.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain(S2);
    expect(chamadas.filter((c) => c.operacao === "upsert" || c.operacao === "delete")).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("setor padrão de fora da org também vira 422", async () => {
    const { banco } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await put({
      channel_session_id: CANAL_ID,
      ativo: true,
      pedir_cnpj: true,
      setor_padrao_id: S2,
      opcoes: [{ sector_id: S1, rotulo: "Suporte", ordem: 0 }],
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain(S2);
  });

  it("número que não é da organização vira 422, sem escrita", async () => {
    const { banco, chamadas } = montarBanco({ canalDaOrg: false, setoresDaOrg: [S1] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await put({ ...corpoValido, channel_session_id: OUTRO_CANAL_ID });

    expect(r.status).toBe(422);
    expect(chamadas.filter((c) => c.operacao === "upsert")).toEqual([]);
  });

  it("módulo setores desligado: 404, a resposta de rota nunca instalada", async () => {
    const { banco, chamadas } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    vi.mocked(seSetoresDesligado).mockResolvedValue(
      new Response(null, { status: 404 }) as unknown as Awaited<ReturnType<typeof seSetoresDesligado>>,
    );

    expect((await put(corpoValido)).status).toBe(404);
    expect(chamadas.filter((c) => c.operacao === "upsert")).toEqual([]);
  });

  it("recusa o que o schema rejeita (9 opções é 422)", async () => {
    const { banco } = montarBanco({ canalDaOrg: true });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const opcoes = Array.from({ length: 9 }, (_, i) => ({
      sector_id: S1,
      rotulo: `Setor ${i}`,
      ordem: i % 8,
    }));
    expect(
      (await put({ channel_session_id: CANAL_ID, ativo: true, pedir_cnpj: true, opcoes })).status,
    ).toBe(422);
  });

  it("a escrita é manager+ e passa pela trava de suporte", async () => {
    const { banco } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1, S2] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    expect((await put(corpoValido)).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_menu_de_entrada" }));

    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    // viewer (ou qualquer papel abaixo de manager) passa pelo 403 do guard.
    expect((await put(corpoValido)).status).toBe(403);
  });

  it("suporte somente-leitura é barrado antes de qualquer efeito", async () => {
    const { requireSupportWrite } = await import("@/lib/impersonate/support");
    const { banco, chamadas } = montarBanco({ canalDaOrg: true, setoresDaOrg: [S1, S2] });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response(null, { status: 403 }) as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
    );

    expect((await put(corpoValido)).status).toBe(403);
    expect(chamadas.filter((c) => c.operacao === "upsert")).toEqual([]);
  });
});

describe("GET /api/v1/settings/menu-de-entrada", () => {
  it("devolve os números da org com as configs e suas opções na ordem", async () => {
    const { banco } = montarBanco({
      canais: [
        { id: CANAL_ID, display_name: "Número A", phone_number: "5511999998888" },
        { id: OUTRO_CANAL_ID, display_name: null, phone_number: null },
      ],
      configs: [
        { id: MENU_ID, channel_session_id: CANAL_ID, ativo: true, pedir_cnpj: true, textos: {}, setor_padrao_id: S2 },
      ],
      opcoes: [
        { menu_id: MENU_ID, sector_id: S1, rotulo: "Suporte técnico", ordem: 0 },
        { menu_id: MENU_ID, sector_id: S2, rotulo: "Financeiro", ordem: 1 },
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);

    const r = await get();
    expect(r.status).toBe(200);
    const json = (await r.json()) as {
      data: { canais: unknown[]; configs: { id: string; opcoes: { sector_id: string }[] }[] };
    };
    expect(json.data.canais).toHaveLength(2);
    expect(json.data.configs).toHaveLength(1);
    expect(json.data.configs[0]!.id).toBe(MENU_ID);
    expect(json.data.configs[0]!.opcoes.map((o) => o.sector_id)).toEqual([S1, S2]);
  });

  it("leitura que falhou é 500, não lista vazia fingindo sucesso", async () => {
    const { banco } = montarBanco({ erroNaLeitura: true });
    vi.mocked(createAdminClient).mockReturnValue(banco as never);
    expect((await get()).status).toBe(500);
  });

  it("a leitura é manager+ — viewer passa pelo 403 do guard", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await get()).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_menu_de_entrada" }));
  });
});
