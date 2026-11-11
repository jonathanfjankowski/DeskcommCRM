import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: { patch: vi.fn(async () => ({})) },
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiClient } from "@/lib/api/client";
import { SaudacaoNaAssumida } from "./_saudacao";

const inicial = { ativo: true, template: "Olá, meu nome é [nome], como posso ajudar?" };

describe("cartão de saudação na assumida", () => {
  beforeEach(() => {
    vi.mocked(apiClient.patch).mockClear();
    refresh.mockClear();
  });

  it("mostra prévia trocando [nome] por um nome de exemplo e [empresa] pelo nome da organização", () => {
    render(<SaudacaoNaAssumida inicial={inicial} nomeOrganizacao="Acme Ltda" podeMudar idioma="pt-BR" />);
    const previa = screen.getByTestId("previa-saudacao");
    expect(previa.textContent).toContain("Olá, meu nome é");
    expect(previa.textContent).not.toContain("[nome]");
    expect(previa.textContent).not.toContain("[empresa]");

    fireEvent.change(screen.getByLabelText("Modelo da saudação"), {
      target: { value: "Bem-vindo à [empresa], aqui é a [nome]." },
    });
    expect(screen.getByTestId("previa-saudacao").textContent).toContain(
      "Bem-vindo à Acme Ltda, aqui é a Maria.",
    );
  });

  it("salvar manda o bloco saudacao_na_assumida pela rota de atendimento e recarrega", async () => {
    render(<SaudacaoNaAssumida inicial={inicial} nomeOrganizacao="Acme Ltda" podeMudar idioma="pt-BR" />);
    fireEvent.change(screen.getByLabelText("Modelo da saudação"), {
      target: { value: "Oi! Sou [nome]." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar saudação" }));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/settings/atendimento", {
        saudacao_na_assumida: { ativo: true, template: "Oi! Sou [nome]." },
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("desligar a saudação grava ativo falso mantendo o modelo", async () => {
    render(<SaudacaoNaAssumida inicial={inicial} nomeOrganizacao="Acme Ltda" podeMudar idioma="pt-BR" />);
    fireEvent.click(screen.getByRole("switch", { name: "Mandar saudação quando alguém assume" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar saudação" }));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/settings/atendimento", {
        saudacao_na_assumida: { ativo: false, template: inicial.template },
      }),
    );
  });
});
