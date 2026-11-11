/**
 * SELETOR DE EMPRESA NA DEMANDA DO INBOX (spec 2026-11-11 §6, Task 14).
 *
 * Prende os fios, no estilo `tarefas-filtro-por-funil`: a linha da demanda
 * usa o SELETOR de verdade (o mesmo do formulário), envia o PATCH canônico
 * `{company_id}` para a rota da demanda e recarrega — e o valor inicial vem
 * da leitura, o que exige a coluna no `crm-summary`. Fio que não está escrito
 * é fio que não existe: sem estes regex, um dos elos pode sumir no refactoring
 * e a tela continua renderizando o resto.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

describe("demandas do inbox × vínculo de empresa", () => {
  const painel = readFileSync("components/inbox/CRMSidePanel.tsx", "utf8");
  const resumo = readFileSync("app/api/v1/contacts/[id]/crm-summary/route.ts", "utf8");

  it("a linha da demanda usa o SeletorDeEmpresa e PATCH a rota da demanda", () => {
    expect(painel).toMatch(/SeletorDeEmpresa/);
    expect(painel).toMatch(/apiClient\.patch\(`\/api\/v1\/demandas\/\$\{d\.id\}`, \{ company_id: companyId \}\)/);
    // valor inicial vem da própria linha; recarga depois do efeito
    expect(painel).toMatch(/value=\{d\.company_id \?\? null\}/);
    expect(painel).toContain("recarregar();");
    expect(painel).toMatch(/data-testid="demanda-seletor-empresa"/);
  });

  it("o seletor obedece os degraus que já governam a linha (agente+, fora do read-only)", () => {
    expect(painel).toMatch(/!readonly && podeCriarTarefa \? \(\n\s+<div className="mt-1.5" data-testid="demanda-seletor-empresa"/);
  });

  it("o `crm-summary` devolve company_id na demanda — sem a coluna o seletor nasce cego", () => {
    expect(resumo).toMatch(/company_id/);
  });
});
