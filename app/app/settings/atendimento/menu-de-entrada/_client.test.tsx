import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEXTOS_PADRAO_DO_MENU } from "@/lib/atendimento/menu-de-entrada/schema";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const SETORES = [
  { id: "s1", name: "Suporte" },
  { id: "s2", name: "Financeiro" },
];

const consulta = vi.fn();
const mutar = vi.fn(async (_input?: unknown) => ({ data: { menu_id: "m1" } }));

vi.mock("@/hooks/settings/useMenuDeEntrada", () => ({
  useMenuDeEntrada: () => consulta(),
  useSalvarMenuDeEntrada: () => ({ mutateAsync: (i: unknown) => mutar(i), isPending: false }),
}));
vi.mock("@/hooks/team/useSectors", () => ({
  useSectors: () => ({ data: { data: SETORES }, isLoading: false }),
}));

import { MenuDeEntradaClient } from "./_client";

const SEM_CONFIG = {
  data: {
    data: {
      canais: [{ id: "c1", display_name: "Número A", phone_number: null }],
      configs: [],
    },
  },
  isLoading: false,
  isError: false,
};

const COM_CONFIG = {
  data: {
    data: {
      canais: [
        { id: "c1", display_name: "Número A", phone_number: null },
        { id: "c2", display_name: "Número B", phone_number: "5511999998888" },
      ],
      configs: [
        {
          id: "m1",
          channel_session_id: "c1",
          ativo: true,
          pedir_cnpj: false,
          textos: { menu_setores: "Meu menu" },
          setor_padrao_id: "s2",
          updated_at: "2026-11-11T00:00:00Z",
          opcoes: [{ sector_id: "s2", rotulo: "Financeiro", ordem: 0 }],
        },
      ],
    },
  },
  isLoading: false,
  isError: false,
};

const corpo = () => mutar.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  mutar.mockClear();
  consulta.mockReset();
});

describe("tela de menu de entrada", () => {
  it("módulo setores desligado: a tela diz como ligar em vez de perguntar à API", () => {
    consulta.mockReturnValue(SEM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado={false} />);
    expect(screen.getByText(/Ligue o módulo Setores/)).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("número sem config semeia os oito textos padrão como valor editável", () => {
    consulta.mockReturnValue(SEM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado />);
    fireEvent.click(screen.getByRole("switch", { name: "Menu ligado neste número" }));
    expect(
      screen.getByDisplayValue(TEXTOS_PADRAO_DO_MENU.boas_vindas_cnpj),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(TEXTOS_PADRAO_DO_MENU.aviso_setor_padrao),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("textbox").length).toBeGreaterThanOrEqual(8);
  });

  it("config existente aparece do banco, não do seed", () => {
    consulta.mockReturnValue(COM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado />);
    expect(screen.getByDisplayValue("Meu menu")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Menu ligado neste número" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Pedir o CNPJ antes do menu" })).not.toBeChecked();
    expect(screen.getByLabelText("Setor padrão (opcional)")).toHaveValue("s2");
  });

  it("salvar renumera as opções na ordem da tela, completa o rótulo com o nome da fila e devolve o texto vazio ao padrão", async () => {
    consulta.mockReturnValue(SEM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado />);
    fireEvent.click(screen.getByRole("switch", { name: "Menu ligado neste número" }));

    fireEvent.click(screen.getByRole("button", { name: "Adicionar opção" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar opção" }));
    const linha1 = within(screen.getByTestId("linha-opcao-0"));
    const linha2 = within(screen.getByTestId("linha-opcao-1"));
    fireEvent.change(linha1.getByLabelText("Fila desta opção"), { target: { value: "s2" } });
    fireEvent.change(linha2.getByLabelText("Fila desta opção"), { target: { value: "s1" } });
    fireEvent.change(linha2.getByLabelText("Rótulo desta opção"), { target: { value: "Técnico" } });
    // sobe a segunda: a ordem exibida vira s1, s2
    fireEvent.click(linha2.getByRole("button", { name: "Subir" }));
    // texto esvaziado de propósito cai no padrão ao salvar
    fireEvent.change(screen.getByLabelText("Pedir CNPJ de novo"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Salvar menu" }));
    await waitFor(() => expect(mutar).toHaveBeenCalled());

    expect(corpo()).toMatchObject({
      channel_session_id: "c1",
      ativo: true,
      pedir_cnpj: true,
      setor_padrao_id: null,
      opcoes: [
        { sector_id: "s1", rotulo: "Técnico", ordem: 0 },
        { sector_id: "s2", rotulo: "Financeiro", ordem: 1 },
      ],
    });
    const textos = corpo().textos as Record<string, string>;
    expect(textos.pedido_cnpj).toBe(TEXTOS_PADRAO_DO_MENU.pedido_cnpj);
    expect(textos.menu_setores).toBe(TEXTOS_PADRAO_DO_MENU.menu_setores);
  });

  it("a mesma fila não entra duas vezes: a tela avisa e não salva", () => {
    consulta.mockReturnValue(SEM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado />);
    fireEvent.click(screen.getByRole("switch", { name: "Menu ligado neste número" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar opção" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar opção" }));
    fireEvent.change(within(screen.getByTestId("linha-opcao-1")).getByLabelText("Fila desta opção"), {
      target: { value: "s1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar menu" }));
    expect(mutar).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("o seletor de número troca o formulário entre os canais", () => {
    consulta.mockReturnValue(COM_CONFIG);
    render(<MenuDeEntradaClient setoresLigado />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(radios[1]!);
    // o Número B não tem config: o formulário recomeça do padrão desligado
    expect(screen.getByRole("switch", { name: "Menu ligado neste número" })).not.toBeChecked();
    expect(screen.getByDisplayValue(TEXTOS_PADRAO_DO_MENU.boas_vindas_cnpj)).toBeInTheDocument();
  });
});
