import { describe, expect, it } from "vitest";

import { menuConfigSchema, TEXTOS_PADRAO_DO_MENU } from "./schema";

/**
 * Schema do menu de entrada (spec 2026-11-11 §4) — os textos vivem em config,
 * não no comportamento: o parse de config vazia semeia os 8 defaults, e o
 * operador pode editar qualquer um. O teto de 8 opções e o rótulo não-vazio
 * são recusados no parse (a escrita é da rota de config, que valida antes).
 */
describe("menuConfigSchema (menu de entrada)", () => {
  it("config vazia aplica defaults: desligado, pede CNPJ, 8 textos semeados", () => {
    const c = menuConfigSchema.parse({});
    expect(c.ativo).toBe(false);
    expect(c.pedir_cnpj).toBe(true);
    expect(c.setor_padrao_id).toBeNull();
    expect(c.opcoes).toEqual([]);
    expect(c.textos).toEqual(TEXTOS_PADRAO_DO_MENU);
    expect(Object.keys(c.textos)).toHaveLength(8);
  });

  it("textos parcial completa as chaves faltantes com o default", () => {
    const c = menuConfigSchema.parse({ textos: { menu_setores: "Escolha:\n[opcoes]" } });
    expect(c.textos.menu_setores).toBe("Escolha:\n[opcoes]");
    expect(c.textos.boas_vindas_cnpj).toBe(TEXTOS_PADRAO_DO_MENU.boas_vindas_cnpj);
    expect(c.textos.confirmacao_fila).toBe(TEXTOS_PADRAO_DO_MENU.confirmacao_fila);
  });

  it("rejeita 9 opções (teto 8)", () => {
    const opcoes = Array.from({ length: 9 }, (_, i) => ({
      sector_id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
      rotulo: `Setor ${i}`,
      ordem: i,
    }));
    expect(() => menuConfigSchema.parse({ opcoes })).toThrow();
  });

  it("rejeita rótulo vazio (só espaço também)", () => {
    expect(() =>
      menuConfigSchema.parse({
        opcoes: [{ sector_id: "dddddddd-0000-4000-8000-000000000001", rotulo: "  ", ordem: 0 }],
      }),
    ).toThrow();
  });

  it("opção válida passa com sector_id uuid, rótulo e ordem", () => {
    const c = menuConfigSchema.parse({
      opcoes: [{ sector_id: "dddddddd-0000-4000-8000-000000000001", rotulo: "Suporte", ordem: 0 }],
    });
    expect(c.opcoes[0]?.rotulo).toBe("Suporte");
    expect(c.opcoes[0]?.ordem).toBe(0);
  });

  it("setor_padrao_id aceita uuid e null; lixo vira null (leitura defensiva)", () => {
    expect(menuConfigSchema.parse({ setor_padrao_id: "dddddddd-0000-4000-8000-000000000002" }).setor_padrao_id).toBe(
      "dddddddd-0000-4000-8000-000000000002",
    );
    expect(menuConfigSchema.parse({ setor_padrao_id: "lixo" }).setor_padrao_id).toBeNull();
  });
});
