import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { playSound } from "@/lib/notifications/sounds";

import { useSomDaFila, INTERVALO_MINIMO_MS } from "./useSomDaFila";

/**
 * O som de ENTRADA na fila (spec 2026-11-11 §8) — o que ele deve e não deve
 * fazer, sempre lido da contagem canônica (`fila`), nunca de um estado próprio:
 *
 *   - SUBIU a fila → toca `attention`;
 *   - primeira leitura (abrir a tela com fila formada) → silêncio: quem abriu
 *     o app depois não é chamado a correr;
 *   - DESCEU ou igual → silêncio;
 *   - rajada (dois aumentos na janela mínima) → UM toque;
 *   - desligado → acompanha a régua em silêncio e ligar no meio da fila não
 *     toca o que já estava lá.
 */

const contagem = vi.hoisted(() => ({ atual: undefined as { fila?: number; unassigned?: number } | undefined }));

vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: contagem.atual }),
}));
vi.mock("@/lib/notifications/sounds", () => ({ playSound: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  contagem.atual = undefined;
});

describe("useSomDaFila", () => {
  it("toca quando a fila sobe, fica mudo em igual/desce, e a primeira leitura só fixa a régua", () => {
    let agora = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => agora);
    contagem.atual = { fila: 3 };
    const { rerender } = renderHook(({ ligado }) => useSomDaFila("org-1", ligado), {
      initialProps: { ligado: true },
    });
    expect(playSound).not.toHaveBeenCalled();

    contagem.atual = { fila: 4 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("attention");

    contagem.atual = { fila: 4 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(1);

    contagem.atual = { fila: 2 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(1);

    agora += INTERVALO_MINIMO_MS + 10; // fora da janela de rajada: o novo cliente toca
    contagem.atual = { fila: 3 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("rajada dentro da janela mínima: UM toque; depois da janela, toca de novo", () => {
    let agora = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => agora);
    contagem.atual = { fila: 0 };
    const { rerender } = renderHook(({ ligado }) => useSomDaFila("org-1", ligado), {
      initialProps: { ligado: true },
    });

    contagem.atual = { fila: 1 };
    rerender({ ligado: true });
    contagem.atual = { fila: 2 };
    rerender({ ligado: true }); // rajada do mesmo inbound
    expect(playSound).toHaveBeenCalledTimes(1);

    agora += INTERVALO_MINIMO_MS + 10;
    contagem.atual = { fila: 3 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("desligado: silencioso; ligar no meio de uma fila formada NÃO toca o histórico", () => {
    contagem.atual = { fila: 5 };
    const { rerender } = renderHook(({ ligado }) => useSomDaFila("org-1", ligado), {
      initialProps: { ligado: false },
    });
    contagem.atual = { fila: 6 };
    rerender({ ligado: false });
    expect(playSound).not.toHaveBeenCalled();

    // vira a chave: a fila já subiu ANTES de ligar — régua atual, silêncio.
    rerender({ ligado: true });
    expect(playSound).not.toHaveBeenCalled();

    // só um NOVO cliente na fila acorda o sino.
    contagem.atual = { fila: 7 };
    rerender({ ligado: true });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("sem org (null): contagem indisponível, nada toca nem quebra", () => {
    contagem.atual = undefined;
    const { rerender } = renderHook(({ ligado }) => useSomDaFila(null, ligado), {
      initialProps: { ligado: true },
    });
    rerender({ ligado: true });
    expect(playSound).not.toHaveBeenCalled();
  });
});
