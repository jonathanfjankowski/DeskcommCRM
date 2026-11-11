import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: { patch: vi.fn(async () => ({})) },
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiClient } from "@/lib/api/client";
import { SomenteHumano } from "./_somente-humano";

describe("cartão 'só humano' na tela de atendimento", () => {
  beforeEach(() => {
    vi.mocked(apiClient.patch).mockClear();
    refresh.mockClear();
  });

  it("ligar a opção grava somente_humano pela rota de atendimento e recarrega a tela", async () => {
    render(<SomenteHumano valorInicial={false} podeMudar idioma="pt-BR" />);
    fireEvent.click(screen.getByRole("switch", { name: "Atendimento só por pessoas" }));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/settings/atendimento", {
        somente_humano: true,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole("switch", { name: "Atendimento só por pessoas" })).toBeChecked();
  });

  it("sem o direito de mudar, o cartão existe mas não deixa escrever", () => {
    render(<SomenteHumano valorInicial={false} podeMudar={false} idioma="pt-BR" />);
    expect(screen.getByRole("switch", { name: "Atendimento só por pessoas" })).toBeDisabled();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("erro da rota não anuncia salvo", async () => {
    vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error("A configuração mudou."));
    render(<SomenteHumano valorInicial={false} podeMudar idioma="pt-BR" />);
    fireEvent.click(screen.getByRole("switch", { name: "Atendimento só por pessoas" }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(screen.getByRole("switch", { name: "Atendimento só por pessoas" })).not.toBeChecked();
  });
});
