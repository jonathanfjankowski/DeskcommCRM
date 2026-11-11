import { describe, expect, it } from "vitest";

import { atendimentoPatchSchema, mesclarSettingsAtendimento, SAUDACAO_PADRAO } from "./atendimento";
import { atendimentoDeclarado } from "./settings";

/**
 * A seção `organizations.settings.atendimento` (spec 2026-11-11 §3.7 e §4):
 * leitura defensiva que nunca lança (roda no hot path da IA e do turno),
 * patch estrito para a rota, e merge não-destrutivo em dois níveis —
 * irmão de `mesclarSettingsDeAtendimento`, que protege `settings.routing`.
 */

describe("atendimentoDeclarado (leitura nunca lança)", () => {
  it("settings vazio: desligado por padrão, template semeado", () => {
    const a = atendimentoDeclarado({});
    expect(a.somente_humano).toBe(false);
    expect(a.saudacao_na_assumida).toEqual({ ativo: false, template: SAUDACAO_PADRAO });
  });

  it("undefined, string e lixo viram defaults — nunca throw", () => {
    expect(atendimentoDeclarado(undefined).somente_humano).toBe(false);
    expect(atendimentoDeclarado("não sou objeto").somente_humano).toBe(false);
    expect(atendimentoDeclarado({ atendimento: 42 }).saudacao_na_assumida.ativo).toBe(false);
  });

  it("bloco parcial: só o que veio; o resto é default", () => {
    const a = atendimentoDeclarado({ atendimento: { somente_humano: true } });
    expect(a.somente_humano).toBe(true);
    expect(a.saudacao_na_assumida.template).toBe(SAUDACAO_PADRAO);
  });

  it("template editado sai como foi salvo (nada hardcoded no caminho de leitura)", () => {
    const a = atendimentoDeclarado({
      atendimento: { saudacao_na_assumida: { ativo: true, template: "Oi! Sou [nome], da [empresa]." } },
    });
    expect(a.saudacao_na_assumida).toEqual({ ativo: true, template: "Oi! Sou [nome], da [empresa]." });
  });
});

describe("atendimentoPatchSchema", () => {
  it("rejeita chave desconhecida", () => {
    expect(() => atendimentoPatchSchema.parse({ alguma_coisa: true })).toThrow();
  });

  it("rejeita template acima de 1000 caracteres", () => {
    expect(() =>
      atendimentoPatchSchema.parse({ saudacao_na_assumida: { template: "x".repeat(1001) } }),
    ).toThrow();
  });

  it("aceita patches parciais (um campo só)", () => {
    expect(atendimentoPatchSchema.parse({ somente_humano: true })).toEqual({ somente_humano: true });
    expect(atendimentoPatchSchema.parse({ saudacao_na_assumida: { ativo: true } })).toEqual({
      saudacao_na_assumida: { ativo: true },
    });
  });
});

describe("mesclarSettingsAtendimento", () => {
  it("preserva os irmãos de settings e os campos omitidos do bloco", () => {
    const atual = {
      routing: { mode: "round_robin" },
      atendimento: {
        somente_humano: true,
        saudacao_na_assumida: { ativo: true, template: "Oi, [nome]!" },
      },
    };
    const { settings, atendimento } = mesclarSettingsAtendimento(atual, { somente_humano: false });
    expect(settings.routing).toEqual({ mode: "round_robin" });
    expect(atendimento).toEqual({
      somente_humano: false,
      saudacao_na_assumida: { ativo: true, template: "Oi, [nome]!" },
    });
    expect(settings.atendimento).toEqual(atendimento);
  });

  it("merge a partir de org sem bloco: defaults + o que veio", () => {
    const { settings, atendimento } = mesclarSettingsAtendimento({}, {
      saudacao_na_assumida: { template: "Olá! Aqui é o [nome]." },
    });
    expect(atendimento).toEqual({
      somente_humano: false,
      saudacao_na_assumida: { ativo: false, template: "Olá! Aqui é o [nome]." },
    });
    expect((settings as Record<string, unknown>).atendimento).toEqual(atendimento);
  });
});
