import { describe, expect, it } from "vitest";

import { renderTemplate, renderizarOpcoes } from "./render";

const opcoes = [
  { sector_id: "a", rotulo: "Suporte", ordem: 0 },
  { sector_id: "b", rotulo: "Financeiro", ordem: 1 },
];

describe("renderizarOpcoes", () => {
  it("numera pela posição ordenada", () => {
    expect(renderizarOpcoes(opcoes)).toBe("1 - Suporte\n2 - Financeiro");
  });
  it("trocar a ordem troca a numeração (o número nasce da ordenação)", () => {
    expect(
      renderizarOpcoes([
        { sector_id: "a", rotulo: "Suporte", ordem: 1 },
        { sector_id: "b", rotulo: "Financeiro", ordem: 0 },
      ]),
    ).toBe("1 - Financeiro\n2 - Suporte");
  });
});

describe("renderTemplate", () => {
  it("substitui todos os placeholders conhecidos", () => {
    const t = "Olá, [empresa]! [nome] atende. Setor: [setor]. Fale com:\n[opcoes]";
    expect(
      renderTemplate(t, {
        empresa: "TI Rápida",
        nome: "João",
        setor: "Suporte",
        opcoes,
      }),
    ).toBe("Olá, TI Rápida! João atende. Setor: Suporte. Fale com:\n1 - Suporte\n2 - Financeiro");
  });

  it("[empresa_cliente] resolve pelo nome da empresa do cliente", () => {
    expect(
      renderTemplate("Que bom ter você de volta, [empresa_cliente]!", { empresa_cliente: "Acme Ltda" }),
    ).toBe("Que bom ter você de volta, Acme Ltda!");
  });

  it("placeholder conhecido SEM valor é REMOVIDO — nunca sai '[nome]' cru para o cliente", () => {
    expect(renderTemplate("Olá, meu nome é [nome], como posso ajudar?", {})).toBe(
      "Olá, meu nome é , como posso ajudar?",
    );
    expect(renderTemplate("Bem-vindo à [empresa]!", {})).toBe("Bem-vindo à !");
  });

  it("token DESCONHECIDO fica como o operador escreveu (é texto dele, não placeholder do sistema)", () => {
    expect(renderTemplate("Use [cupom] para desconto", {})).toBe("Use [cupom] para desconto");
  });

  it("sem [opcoes] no template, a lista não é anexada (o texto é literal)", () => {
    expect(renderTemplate("Escolha um setor.", { opcoes })).toBe("Escolha um setor.");
  });
});
