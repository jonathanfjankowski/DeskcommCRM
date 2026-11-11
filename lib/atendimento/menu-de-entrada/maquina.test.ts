import { describe, expect, it } from "vitest";

import { menuConfigSchema, type MenuConfig } from "./schema";
import type { EstadoDoMenu } from "./estado";
import { decidirPassoDoMenu } from "./maquina";

/**
 * A máquina do menu — PURO: recebe estado + config + texto e devolve o passo.
 * CNPJ válido clássico de teste (dígitos conferem): 12.345.678/0001-95.
 */
const CNPJO_VALIDO = "12.345.678/0001-95";

function config(parcial: Partial<MenuConfig> = {}): MenuConfig {
  return menuConfigSchema.parse({
    ativo: true,
    opcoes: [
      { sector_id: "aaaaaaaa-0000-4000-8000-000000000001", rotulo: "Suporte", ordem: 0 },
      { sector_id: "bbbbbbbb-0000-4000-8000-000000000002", rotulo: "Financeiro", ordem: 1 },
    ],
    ...parcial,
  });
}

function estadoDe(parcial: Partial<EstadoDoMenu> = {}): EstadoDoMenu {
  return {
    service_revision: 1,
    etapa: "cnpj",
    tentativas_cnpj: 0,
    tentativas_setor: 0,
    empresa_id: null,
    ...parcial,
  };
}

describe("decidirPassoDoMenu — entrada", () => {
  it("primeira mensagem com pedir_cnpj: boas-vindas pedindo o CNPJ", () => {
    const passo = decidirPassoDoMenu({
      estado: null,
      config: config(),
      texto: "oi",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("boas_vindas");
    expect(passo.texto).toContain("CNPJ");
    expect(passo.proximoEstado).toEqual(estadoDe({ etapa: "cnpj" }));
  });

  it("primeira mensagem com pedir_cnpj desligado: vai direto ao menu", () => {
    const passo = decidirPassoDoMenu({
      estado: null,
      config: config({ pedir_cnpj: false }),
      texto: "oi",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("menu");
    expect(passo.texto).toContain("1 - Suporte");
    expect(passo.proximoEstado?.etapa).toBe("setor");
  });

  it("contato que já tem empresa não é interrogado: saudação com o nome dela + menu", () => {
    const passo = decidirPassoDoMenu({
      estado: null,
      config: config(),
      texto: "oi",
      empresaConhecida: { id: "e1", nome: "Acme Ltda" },
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("menu");
    expect(passo.texto).toContain("Acme Ltda");
    expect(passo.empresaId).toBe("e1");
  });

  it("config ativo sem opções: nada (menu vazio não roda — fail-open para o fluxo normal)", () => {
    const passo = decidirPassoDoMenu({
      estado: null,
      config: config({ opcoes: [] }),
      texto: "oi",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("nada");
    expect(passo.proximoEstado).toBeNull();
  });
});

describe("decidirPassoDoMenu — etapa CNPJ", () => {
  it("CNPJ válido novo: segue ao menu (texto padrão, sem 'de volta')", () => {
    const passo = decidirPassoDoMenu({
      estado: estadoDe(),
      config: config(),
      texto: CNPJO_VALIDO,
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("menu");
    expect(passo.proximoEstado?.etapa).toBe("setor");
    expect(passo.texto).toContain("1 - Suporte\n2 - Financeiro");
  });

  it("CNPJ válido JÁ conhecido: 'que bom ter você de volta' com o nome + empresaId", () => {
    const passo = decidirPassoDoMenu({
      estado: estadoDe(),
      config: config(),
      texto: "12345678000195",
      empresaConhecida: { id: "e9", nome: "Cliente Antigo" },
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("menu");
    expect(passo.empresaId).toBe("e9");
    expect(passo.texto).toContain("Cliente Antigo");
  });

  it("inválido tenta de novo até 2 vezes; a 3ª segue sem empresa", () => {
    const c = config();
    const base = { estado: estadoDe(), config: c, texto: "42", empresaConhecida: null, serviceRevision: 1 };
    const p1 = decidirPassoDoMenu(base);
    expect(p1.acao).toBe("pedido_cnpj");
    expect(p1.proximoEstado?.tentativas_cnpj).toBe(1);

    const p2 = decidirPassoDoMenu({ ...base, estado: estadoDe({ tentativas_cnpj: 1 }) });
    expect(p2.acao).toBe("pedido_cnpj");
    expect(p2.proximoEstado?.tentativas_cnpj).toBe(2);

    const p3 = decidirPassoDoMenu({ ...base, estado: estadoDe({ tentativas_cnpj: 2 }) });
    expect(p3.acao).toBe("seguir_sem_cnpj");
    expect(p3.proximoEstado?.etapa).toBe("setor");
    expect(p3.texto).toContain("1 - Suporte");
  });

  it("áudio/mídia (texto null) na etapa CNPJ conta como tentativa inválida", () => {
    const passo = decidirPassoDoMenu({
      estado: estadoDe(),
      config: config(),
      texto: null,
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("pedido_cnpj");
  });
});

describe("decidirPassoDoMenu — etapa setor", () => {
  const noSetor = estadoDe({ etapa: "setor", tentativas_cnpj: 0 });

  it("número válido roteia para o setor, confirma com o nome e conclui", () => {
    const passo = decidirPassoDoMenu({
      estado: noSetor,
      config: config(),
      texto: "2",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("rotear");
    expect(passo.setorId).toBe("bbbbbbbb-0000-4000-8000-000000000002");
    expect(passo.texto).toContain("Financeiro");
    expect(passo.proximoEstado?.etapa).toBe("concluido");
  });

  it("rótulo válido também roteia", () => {
    const passo = decidirPassoDoMenu({
      estado: noSetor,
      config: config(),
      texto: "SUPORTE",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("rotear");
    expect(passo.setorId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("inválido 1x repete o menu; 2x cai no setor padrão configurado com aviso próprio", () => {
    const c = config({ setor_padrao_id: "cccccccc-0000-4000-8000-000000000003" });
    const p1 = decidirPassoDoMenu({
      estado: noSetor,
      config: c,
      texto: "oi",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(p1.acao).toBe("opcao_invalida");
    expect(p1.proximoEstado?.tentativas_setor).toBe(1);
    expect(p1.texto).toContain("1 - Suporte");

    const p2 = decidirPassoDoMenu({
      estado: { ...noSetor, tentativas_setor: 1 },
      config: c,
      texto: "quero falar com alguém",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(p2.acao).toBe("setor_padrao");
    expect(p2.setorId).toBe("cccccccc-0000-4000-8000-000000000003");
    expect(p2.proximoEstado?.etapa).toBe("concluido");
  });

  it("sem setor padrão configurado: a segunda inválida vai para a PRIMEIRA opção do menu", () => {
    const passo = decidirPassoDoMenu({
      estado: { ...noSetor, tentativas_setor: 1 },
      config: config(),
      texto: "?",
      empresaConhecida: null,
      serviceRevision: 1,
    });
    expect(passo.acao).toBe("rotear");
    expect(passo.setorId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });
});
