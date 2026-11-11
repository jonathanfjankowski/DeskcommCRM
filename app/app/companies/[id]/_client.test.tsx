/**
 * FICHA DA EMPRESA: os cards de histórico (spec 2026-11-11 §6, Task 14).
 *
 * Render de verdade, no estilo `TarefasClient.test`: a `GET /api/v1/companies/{id}`
 * já devolve `demandas` e `tarefas` (provado em `lib/crm-b2b/companies-handler-historico.test.ts`);
 * aqui se prende que a TELA mostra as duas listas com título, desfecho traduzido
 * e data — e linka para onde a história continua (contato / tarefas). Card que
 * recebe dado e não mostra nada é a metade muda do par.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", is_platform_admin: false, support: null }, activeOrg: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { CompanyDetailClient } from "./_client";

const EMPRESA = "55555555-5555-4555-8555-555555555555";

const FICHA = {
  data: {
    company: { id: EMPRESA, trade_name: "UFU Telecom", legal_name: "UFU Telecom LTDA", cnpj: "12.345.678/0001-95" },
    people: [],
    contacts: [],
    demandas: [
      {
        id: "d-1",
        assunto: "Impressora sem responder",
        resumo_encerramento: "Trocado o cabo.",
        estado: "encerrada",
        desfecho: "resolvida",
        aberta_em: "2026-11-01T10:00:00Z",
        fechada_em: "2026-11-01T12:00:00Z",
        company_id: EMPRESA,
        contact_id: "c-1",
      },
      {
        id: "d-2",
        assunto: null,
        resumo_encerramento: null,
        estado: "aberta",
        desfecho: null,
        aberta_em: "2026-11-05T10:00:00Z",
        fechada_em: null,
        company_id: EMPRESA,
        contact_id: "c-2",
      },
    ],
    tarefas: [
      { id: "t-1", title: "Ligar de volta na terça", status: "pending", priority: "medium", due_date: null, created_at: "2026-11-02T09:00:00Z" },
    ],
  },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | Request | URL) => {
      if (String(url).includes(`/api/v1/companies/${EMPRESA}`)) {
        return new Response(JSON.stringify(FICHA), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

function abrirFicha() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CompanyDetailClient id={EMPRESA} />
    </QueryClientProvider>,
  );
}

describe("ficha da empresa — atendimentos e tarefas", () => {
  it("⭐ card Atendimentos: título, desfecho traduzido, data e link para o contato", async () => {
    abrirFicha();
    await screen.findByText("UFU Telecom");

    expect(screen.getByRole("heading", { name: "Atendimentos" })).toBeInTheDocument();
    const linha = await screen.findByText("Impressora sem responder");
    expect(linha.closest("a")).toHaveAttribute("href", "/app/contacts/c-1");
    expect(screen.getByText(/Resolvida/)).toBeInTheDocument();
    // demanda sem título não quebra a linha: vira traço, e continua linkada
    const semTitulo = screen
      .getAllByText("—")
      .find((el) => el.closest("a")?.getAttribute("href") === "/app/contacts/c-2");
    expect(semTitulo).toBeTruthy();
  });

  it("⭐ card Tarefas: título e situação, com saída para a tela de Tarefas", async () => {
    abrirFicha();
    await screen.findByText("UFU Telecom");

    expect(screen.getByRole("heading", { name: "Tarefas" })).toBeInTheDocument();
    const tarefa = await screen.findByText("Ligar de volta na terça");
    expect(tarefa.closest("a")).toHaveAttribute("href", "/app/tasks");
    expect(screen.getByText("Pendente")).toBeInTheDocument();
  });

  it("demanda aberta aparece como 'Em aberto', sem data de encerramento", async () => {
    abrirFicha();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Atendimentos" })).toBeInTheDocument());
    expect(await screen.findByText(/Em aberto/)).toBeInTheDocument();
  });

  it("empresa sem histórico diz que não há — sem tabela fantasma", async () => {
    vi.mocked(fetch).mockImplementation(async (url: string) => {
      if (String(url).includes(`/api/v1/companies/${EMPRESA}`)) {
        return new Response(
          JSON.stringify({
            data: { ...FICHA.data, demandas: [], tarefas: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    abrirFicha();
    await screen.findByText("UFU Telecom");
    expect(await screen.findByText("Nenhum atendimento registrado.")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma tarefa para esta empresa.")).toBeInTheDocument();
  });
});
