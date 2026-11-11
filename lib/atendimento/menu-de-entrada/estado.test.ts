import { describe, expect, it } from "vitest";

import {
  CHAVE_DO_MENU,
  lerEstadoDoMenu,
  metadataComEstadoDoMenu,
  type EstadoDoMenu,
} from "./estado";

/** O estado do menu mora em `conversations.metadata` — reader/writer por chave, padrão `ia-com-dono`. */
const estado: EstadoDoMenu = {
  service_revision: 3,
  etapa: "setor",
  tentativas_cnpj: 1,
  tentativas_setor: 0,
  empresa_id: null,
};

describe("lerEstadoDoMenu", () => {
  it("lê o estado da revision atual", () => {
    expect(lerEstadoDoMenu({ [CHAVE_DO_MENU]: estado }, 3)).toEqual(estado);
  });

  it("revision diferente (sessão nova) devolve null — menu pode recomeçar", () => {
    expect(lerEstadoDoMenu({ [CHAVE_DO_MENU]: estado }, 4)).toBeNull();
  });

  it("ausente, lixo ou etapa desconhecida devolve null, nunca lança", () => {
    expect(lerEstadoDoMenu(null, 3)).toBeNull();
    expect(lerEstadoDoMenu({}, 3)).toBeNull();
    expect(lerEstadoDoMenu({ [CHAVE_DO_MENU]: "não é objeto" }, 3)).toBeNull();
    expect(lerEstadoDoMenu({ [CHAVE_DO_MENU]: { ...estado, etapa: "bingo" } }, 3)).toBeNull();
  });
});

describe("metadataComEstadoDoMenu", () => {
  it("grava preservando as outras chaves do metadata", () => {
    const saida = metadataComEstadoDoMenu({ setor_origem: "manual" }, estado);
    expect(saida).toEqual({ setor_origem: "manual", [CHAVE_DO_MENU]: estado });
  });

  it("etapa 'concluido' REMOVE a chave (menu terminou; metadata enxuto)", () => {
    const saida = metadataComEstadoDoMenu(
      { [CHAVE_DO_MENU]: estado, ai_com_dono: true },
      { ...estado, etapa: "concluido" },
    );
    expect(saida).toEqual({ ai_com_dono: true });
  });

  it("metadata null/lixo: devolve objeto só com a chave nova", () => {
    expect(metadataComEstadoDoMenu(null, estado)[CHAVE_DO_MENU]).toEqual(estado);
    expect(metadataComEstadoDoMenu(42, estado)[CHAVE_DO_MENU]).toEqual(estado);
  });
});
