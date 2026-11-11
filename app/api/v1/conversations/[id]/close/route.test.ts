import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * FECHAR COM A ESCOLHA DE DEVOLVER AO AUTOMÁTICO (#3313, item 1).
 *
 * A trava de humano mora no CONTATO (`contacts.force_human`), não na conversa:
 * fechar a conversa não a soltava, e a próxima mensagem daquele cliente, dias
 * depois, era pulada pela IA sem ninguém perceber. A rota passa a aceitar a
 * escolha do diálogo de fechamento e, quando ela é "devolver", chama
 * `devolverAtendimentoAoAgente` — a MESMA função do botão da tela e do cron.
 *
 * ─── O QUE ESTE ARQUIVO PRENDE ──────────────────────────────────────────────
 *
 *   - sem a chave no corpo, a regra NÃO é chamada: fechar continua sendo só
 *     fechar (é o caso de toda conversa sem contato travado e de todo cliente
 *     antigo da API);
 *   - `false` (="Manter com a equipe") também não chama nada — a trava fica;
 *   - `true` (o padrão MARCADO) chama a regra com a conversa, a org e o ator
 *     humano certos, e a conversa encerra do mesmo jeito;
 *   - `contato_sempre_humano` (marca «sempre atendimento humano») NÃO vira erro
 *     na tela: a conversa fechou e o que muda é a resposta, que conta que a
 *     trava continua — sem log de erro, porque é recusa esperada;
 *   - falha de banco na devolução também não derruba o fechamento, mas fica no
 *     log (é defeito, não recusa).
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar a chamada da regra: os casos de `true` acusam (nada é chamado, e o
 *     corpo sai sem `devolucao`);
 *   - chamar a regra sempre, ignorando a chave: os casos de corpo sem chave e o
 *     de `false` acusam.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const ATENDENTE = "22222222-2222-4222-8222-222222222222";
const COLEGA = "33333333-3333-4333-8333-333333333333";

const CONVERSA_FECHADA = {
  id: CONVERSA,
  organization_id: ORG,
  status: "closed",
  service_revision: 7,
  // A main passou a exigir controle da conversa antes de qualquer escrita
  // (`exigirControleDaConversa`): sem dono, o `fn_can_view_conversation` abaixo
  // responde que este atendente pode encerrar.
  assigned_to_user_id: null,
};

function chamar(corpo: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/close`, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CONVERSA }) },
  );
}

type Resposta = { data: Record<string, unknown> & { devolucao?: { ok: boolean; motivo?: string } } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: CONVERSA_FECHADA, error: null }) }) }),
      }),
    }),
    // `exigirControleDaConversa` (main) chama `fn_can_view_conversation` para
    // conversa SEM dono humano; `true` = este atendente pode encerrar.
    rpc: async () => ({ data: true, error: null }),
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: async () => ({ data: CONVERSA_FECHADA, error: null }),
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
    ok: true,
    conversationId: CONVERSA,
    jaEstavaComOAgente: false,
    continuidade: { houveAtendimentoHumano: false, resumo: "", decisoes: [], notas: [] },
  } as unknown as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);
});

describe("close — fechar sem a escolha não devolve nada", () => {
  it("corpo sem a chave: fecha, não chama a regra e o corpo sai como sempre saiu", async () => {
    const res = await chamar({ expected_revision: 7 });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.id).toBe(CONVERSA);
    expect(devolverAtendimentoAoAgente, "quem não pediu não pode ganhar devolução").not.toHaveBeenCalled();
    expect(Object.keys(corpo.data)).not.toContain("devolucao");
  });

  it("corpo com corpo vazio (cliente antigo) também não devolve", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
  });

  it("'Manter com a equipe' (`false`): fecha e a trava continua — a regra não é chamada", async () => {
    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: false });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toBeUndefined();
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
  });
});

describe("close — 'Devolver ao automático ao fechar' (o padrão marcado)", () => {
  it("chama a MESMA regra do botão, com a conversa, a org e o ator humano", async () => {
    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: true });
    expect(devolverAtendimentoAoAgente).toHaveBeenCalledTimes(1);
    const [deps, input] = vi.mocked(devolverAtendimentoAoAgente).mock.calls[0]!;
    expect(deps.organizationId).toBe(ORG);
    expect(deps.actor).toEqual({ type: "user", id: ATENDENTE, role: "agent" });
    expect(input).toEqual({ conversationId: CONVERSA, expectedAssignee: null });
    // Nenhuma origem automática: quem devolveu foi a pessoa, no gesto de fechar.
    expect(input.origem).toBeUndefined();
  });

  it("contato 'sempre atendimento humano': a conversa fecha, a trava CONTINUA e não há log de erro", async () => {
    vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
      ok: false,
      erro: "contato_sempre_humano",
    } as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    // 200, e não 409: o fechamento ACONTECEU. O que a tela precisa saber é que a
    // IA não voltou — e é isso que viaja no corpo.
    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "contato_sempre_humano" });
    expect(logger.error, "recusa esperada não é defeito de banco").not.toHaveBeenCalled();
  });

  it("falha de banco na devolução não derruba o fechamento, mas fica no log", async () => {
    vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({
      ok: false,
      erro: "assignment_conflict",
      detalhe: "deadlock detected",
    } as Awaited<ReturnType<typeof devolverAtendimentoAoAgente>>);

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "assignment_conflict" });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("fechamento que falha (revisão obsoleta) NÃO devolve: 409 sem tocar na trava", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: async () => ({ data: null, error: { code: "PT409", message: "rev" } }),
    } as unknown as ReturnType<typeof createAdminClient>);

    const res = await chamar({ expected_revision: 6, devolver_ao_automatico: true });

    expect(res.status).toBe(409);
    expect(devolverAtendimentoAoAgente, "devolver uma conversa que não fechou desfaria o 409").not.toHaveBeenCalled();
  });
});

/**
 * A MESMA REGRA DE DONO DO BOTÃO "Devolver ao automático" (#3436).
 *
 * `reactivate-bot` só devolve conversa de outro atendente pela mão de um
 * `manager` ou acima, e passa o dono lido como `expectedAssignee`. Fechar com
 * "devolver" marcado é o mesmo gesto por outra porta: sem a regra aqui, o
 * agente que não pode clicar o botão conseguiria o mesmo efeito fechando.
 *
 * SABOTAGEM: tirar a guarda de dono da rota faz o primeiro caso acusar (a regra
 * é chamada e a devolução sai `ok: true`); tirar o `expectedAssignee` faz o
 * segundo acusar.
 */
describe("close — devolver ao fechar segue a regra de dono do botão", () => {
  function conversaDoColega(papel: "agent" | "manager") {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: ATENDENTE, idioma: "pt-BR" },
      org: { orgId: ORG, role: papel },
    } as Awaited<ReturnType<typeof requireRole>>);
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { ...CONVERSA_FECHADA, assigned_to_user_id: COLEGA },
                error: null,
              }),
            }),
          }),
        }),
      }),
      // Quem pode ver pode encerrar: o fechamento em si não é o que se recusa.
      rpc: async () => ({ data: true, error: null }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  }

  it("agente fechando conversa de colega com 'devolver': fecha, mas a trava NÃO é solta", async () => {
    conversaDoColega("agent");

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: false, motivo: "conversa_de_outro_atendente" });
    expect(devolverAtendimentoAoAgente, "agente não devolve conversa de colega").not.toHaveBeenCalled();
  });

  it("gerente fechando conversa de colega devolve, exigindo que o dono ainda seja o lido", async () => {
    conversaDoColega("manager");

    const res = await chamar({ expected_revision: 7, devolver_ao_automatico: true });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.devolucao).toEqual({ ok: true });
    const [, input] = vi.mocked(devolverAtendimentoAoAgente).mock.calls[0]!;
    expect(input).toEqual({ conversationId: CONVERSA, expectedAssignee: COLEGA });
  });
});

/**
 * REGISTRO DE ATENDIMENTO NO FECHAMENTO (spec 2026-11-11 §5) — o gesto de fechar
 * ganha título + conteúdo + desfecho, gravados na demanda atual por
 * `fn_demanda_encerrar`. A ordem é a filosofia desta rota, já testada para a
 * devolução: fechar é o gesto pedido e SEMANA; o registro, quando recusado
 * (demanda sumiu, encerrou concorrente, CAS), viaja no corpo e não derruba o
 * fechamento — a conversa fechada já escreveu em `proximo_passo` o lembrete de
 * "registrar o desfecho", que fica visível e cobrável.
 */
const DEMANDA = "55555555-5555-4555-8555-555555555555";

describe("close — registro de atendimento (9339)", () => {
  type RpcCall = { nome: string; args: Record<string, unknown> };
  let rpcs: RpcCall[];

  function mocksComDemanda(demandaRow: Record<string, unknown> | null, encerrarErro?: { code: string }) {
    rpcs = [];
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { ...CONVERSA_FECHADA, current_demanda_id: demandaRow?.id ?? DEMANDA },
                error: null,
              }),
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: true, error: null }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: demandaRow, error: null }) }),
          }),
        }),
      }),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        rpcs.push({ nome, args });
        if (nome === "fn_demanda_encerrar" && encerrarErro) return { data: null, error: encerrarErro };
        return { data: CONVERSA_FECHADA, error: null };
      },
    } as unknown as ReturnType<typeof createAdminClient>);
  }

  const registro = { titulo: "Impressora sem responder", conteudo: "Reiniciado spooler; testado e validado.", desfecho: "resolvida" };

  it("com registro e demanda aberta: fecha, ENCERRA a demanda com título e conteúdo, e o corpo traz registro ok", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 3, fechada_em: null });
    const res = await chamar({ expected_revision: 7, registro });
    const corpo = (await res.json()) as Resposta;

    expect(res.status).toBe(200);
    expect(corpo.data.registro).toEqual({ ok: true });
    const nomes = rpcs.map((r) => r.nome);
    expect(nomes).toContain("fn_demanda_encerrar");
    // a demanda só é encerrada DEPOIS do fechamento — fechar é o gesto que trava tudo
    expect(nomes.indexOf("fn_service_status")).toBeLessThan(nomes.indexOf("fn_demanda_encerrar"));
    const encerrar = rpcs.find((r) => r.nome === "fn_demanda_encerrar")!;
    expect(encerrar.args).toMatchObject({
      p_org: ORG,
      p_demanda: DEMANDA,
      p_expected: 3,
      p_desfecho: "resolvida",
      p_actor: ATENDENTE,
      p_titulo: registro.titulo,
      p_resumo: registro.conteudo,
    });
  });

  it("sem registro no corpo: nenhuma leitura de demanda, nenhum encerramento — resposta como sempre", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 3, fechada_em: null });
    const res = await chamar({ expected_revision: 7 });
    const corpo = (await res.json()) as Resposta;
    expect(res.status).toBe(200);
    expect(Object.keys(corpo.data)).not.toContain("registro");
    expect(rpcs.map((r) => r.nome)).not.toContain("fn_demanda_encerrar");
  });

  it("conversa sem demanda atual: recusa nomeada viaja no corpo e o fechamento acontece", async () => {
    mocksComDemanda(null);
    const res = await chamar({ expected_revision: 7, registro });
    const corpo = (await res.json()) as Resposta;
    expect(res.status).toBe(200);
    expect(corpo.data.registro).toEqual({ ok: false, motivo: "sem_demanda" });
    expect(rpcs.map((r) => r.nome)).not.toContain("fn_demanda_encerrar");
  });

  it("demanda já encerrada (outro gesto ganhou o corrida): motivo demanda_ja_encerrada, fecha do mesmo jeito", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 4, fechada_em: "2026-11-11T10:00:00Z" });
    const res = await chamar({ expected_revision: 7, registro });
    const corpo = (await res.json()) as Resposta;
    expect(res.status).toBe(200);
    expect(corpo.data.registro).toEqual({ ok: false, motivo: "demanda_ja_encerrada" });
  });

  it("CAS da demanda estourou (PT409): registro viaja recusado, fechamento segue — o lembrete do banco fica visível", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 3, fechada_em: null }, { code: "42P01" });
    rpcs = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: DEMANDA, revision: 3, fechada_em: null }, error: null }) }) }) }),
      }),
      rpc: async (nome: string) => {
        rpcs.push({ nome, args: {} });
        if (nome === "fn_demanda_encerrar") return { data: null, error: { code: "PT409", message: "demanda_stale" } };
        return { data: CONVERSA_FECHADA, error: null };
      },
    } as unknown as ReturnType<typeof createAdminClient>);
    const res = await chamar({ expected_revision: 7, registro });
    const corpo = (await res.json()) as Resposta;
    expect(res.status).toBe(200);
    expect(corpo.data.registro).toEqual({ ok: false, motivo: "demanda_mudou" });
  });

  it("título vazio ou ausente: 422 ANTES de qualquer escrita", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 3, fechada_em: null });
    const res = await chamar({ expected_revision: 7, registro: { titulo: "  ", desfecho: "resolvida" } });
    expect(res.status).toBe(422);
    expect(rpcs).toHaveLength(0);
    const res2 = await chamar({ expected_revision: 7, registro: { desfecho: "resolvida" } });
    expect(res2.status).toBe(422);
  });

  it("desfecho omitido no registro vale `resolvida` (o padrão da pergunta da tela)", async () => {
    mocksComDemanda({ id: DEMANDA, revision: 3, fechada_em: null });
    const res = await chamar({ expected_revision: 7, registro: { titulo: "Só o título" } });
    expect(res.status).toBe(200);
    const encerrar = rpcs.find((r) => r.nome === "fn_demanda_encerrar")!;
    expect(encerrar.args).toMatchObject({ p_desfecho: "resolvida", p_titulo: "Só o título", p_resumo: null });
  });
});
