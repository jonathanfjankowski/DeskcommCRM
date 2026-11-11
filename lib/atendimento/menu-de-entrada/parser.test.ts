import { describe, expect, it } from "vitest";

import { parseOpcaoDoMenu } from "./parser";

const opcoes = [
  { sector_id: "aaaaaaaa-0000-4000-8000-000000000001", rotulo: "Suporte", ordem: 0 },
  { sector_id: "bbbbbbbb-0000-4000-8000-000000000002", rotulo: "Financeiro", ordem: 1 },
  { sector_id: "cccccccc-0000-4000-8000-000000000003", rotulo: "Jurídico", ordem: 2 },
];

/**
 * O número é a POSIÇÃO ordenada (1-based) — não o valor cru de `ordem` —,
 * então reordenar no banco sem renumerar não muda o que o cliente vê.
 * O rótulo casa normalizado: sem acento, sem caixa, aparado.
 */
describe("parseOpcaoDoMenu", () => {
  it("casa o número pela posição ordenada", () => {
    expect(parseOpcaoDoMenu("1", opcoes)).toEqual({
      sector_id: "aaaaaaaa-0000-4000-8000-000000000001",
      rotulo: "Suporte",
    });
    expect(parseOpcaoDoMenu(" 2 ", opcoes)?.sector_id).toBe("bbbbbbbb-0000-4000-8000-000000000002");
    expect(parseOpcaoDoMenu("3", opcoes)?.sector_id).toBe("cccccccc-0000-4000-8000-000000000003");
  });

  it("casa o rótulo sem caixa, sem acento e aparado", () => {
    expect(parseOpcaoDoMenu("suporte", opcoes)?.sector_id).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(parseOpcaoDoMenu("FINANCEIRO", opcoes)?.sector_id).toBe("bbbbbbbb-0000-4000-8000-000000000002");
    expect(parseOpcaoDoMenu("  juridico  ", opcoes)?.sector_id).toBe("cccccccc-0000-4000-8000-000000000003");
  });

  it("fora do range, texto solto e vazio devolvem null", () => {
    expect(parseOpcaoDoMenu("4", opcoes)).toBeNull();
    expect(parseOpcaoDoMenu("0", opcoes)).toBeNull();
    expect(parseOpcaoDoMenu("oi", opcoes)).toBeNull();
    expect(parseOpcaoDoMenu("", opcoes)).toBeNull();
    expect(parseOpcaoDoMenu("quero falar com atendente", opcoes)).toBeNull();
  });

  it("null entra como null (mídia/áudio não tem texto)", () => {
    expect(parseOpcaoDoMenu(null, opcoes)).toBeNull();
  });

  it("ordem embaralhada no banco: o número é a posição ordenada", () => {
    const bagunca = [opcoes[2]!, opcoes[0]!, opcoes[1]!];
    expect(parseOpcaoDoMenu("1", bagunca)?.sector_id).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(parseOpcaoDoMenu("3", bagunca)?.sector_id).toBe("cccccccc-0000-4000-8000-000000000003");
  });
});
