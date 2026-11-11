/**
 * SELETOR DE EMPRESA — a busca que sabe desaparecer (spec 2026-11-11 §6).
 *
 * O contrato que este arquivo prende:
 *   1._busca com debounce em `GET /api/v1/companies?search=&limit=20` — a
 *      mesma rota que a tela de Empresas já usa; nada de consultar `companies`
 *      por fora da API.
 *   2. O MÓDULO B2B DESLIGADO some com o campo, não com a tela: a rota devolve
 *      404 (`seModuloB2bDesligado`) e o componente renderiza NADA. Organizações
 *      sem `crm_b2b` não veem um seletor que nunca vai funcionar.
 *   3. Valor escolhido fora da página atual das resultados tem o NOME resolvido
 *      por `GET /api/v1/companies/{id}` — sem isso, editar uma tarefa com
 *      empresa herdada mostraria um campo vazio sobre um valor gravado.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), patch: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";

import { SeletorDeEmpresa } from "./SeletorDeEmpresa";

const EMPRESA = "55555555-5555-4555-8555-555555555555";

const LISTA = [
  { id: EMPRESA, trade_name: "ACME Ltda", legal_name: "ACME Comércio LTDA", cnpj: "12.345.678/0001-95" },
  { id: "66666666-6666-4666-8666-666666666666", trade_name: "Outra", legal_name: "Outra SA", cnpj: null },
];

beforeEach(() => {
  vi.clearAllMocks();
});

function listaOk() {
  vi.mocked(apiClient.get).mockResolvedValue({ data: LISTA } as never);
}

describe("SeletorDeEmpresa", () => {
  it("⭐ escolhe pelo resultado da busca e devolve o id", async () => {
    listaOk();
    const aoEscolher = vi.fn();
    render(<SeletorDeEmpresa value={null} onChange={aoEscolher} />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(vi.mocked(apiClient.get).mock.calls[0]![0]).toContain("/api/v1/companies?");
    expect(vi.mocked(apiClient.get).mock.calls[0]![0]).toContain("limit=20");

    await userEvent.type(screen.getByLabelText("Empresa"), "ACME");
    await waitFor(() =>
      expect(vi.mocked(apiClient.get).mock.calls.some(([u]) => String(u).includes("search=ACME"))).toBe(true),
    );

    await userEvent.click(await screen.findByRole("option", { name: "ACME Ltda" }));
    expect(aoEscolher).toHaveBeenCalledWith(EMPRESA);
  });

  it("⭐ módulo B2B desligado (404): o seletor NÃO renderiza nada", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      new ApiError(404, "not_found", undefined, "req", "não encontrado"),
    );
    const { container } = render(<SeletorDeEmpresa value={null} onChange={vi.fn()} />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByLabelText("Empresa")).toBeNull();
  });

  it("falha qualquer de leitura também esconde — o campo não pode prometer o que não responde", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new ApiError(500, "internal_error", undefined, "req"));
    const { container } = render(<SeletorDeEmpresa value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("⭐ valor herdado fora da lista ganha nome pela ficha da empresa", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/companies?")) return { data: [] } as never;
      return { data: { company: { id: EMPRESA, trade_name: "UFU Telecom", legal_name: null, cnpj: null } } } as never;
    });
    render(<SeletorDeEmpresa value={EMPRESA} onChange={vi.fn()} />);

    await waitFor(() =>
      expect(vi.mocked(apiClient.get).mock.calls.some(([u]) => String(u) === `/api/v1/companies/${EMPRESA}`)).toBe(true),
    );
    await waitFor(() => expect(screen.getByLabelText("Empresa")).toHaveValue("UFU Telecom"));
  });

  it("`Limpar` devolve null e o nome some com o valor (pais controlado)", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/companies?")) return { data: LISTA } as never;
      return { data: { company: LISTA[0] } } as never;
    });
    const aoEscolher = vi.fn();
    const { rerender } = render(<SeletorDeEmpresa value={EMPRESA} onChange={aoEscolher} />);

    const limpar = await screen.findByRole("button", { name: "Limpar" });
    await userEvent.click(limpar);
    expect(aoEscolher).toHaveBeenCalledWith(null);
    // o rótulo é DERIVADO do `value`: o pai controlado devolve null, o nome vai junto
    rerender(<SeletorDeEmpresa value={null} onChange={aoEscolher} />);
    expect(screen.getByLabelText("Empresa")).toHaveValue("");
  });

  it("desabilitado não deixa digitar", async () => {
    listaOk();
    render(<SeletorDeEmpresa value={null} onChange={vi.fn()} disabled />);
    await waitFor(() => expect(screen.getByLabelText("Empresa")).toBeDisabled());
  });
});
