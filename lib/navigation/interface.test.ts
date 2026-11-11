/**
 * Preset `suporte` (spec 2026-11-11 §7): a mesa de suporte enxerga Inbox,
 * Tarefas, Contatos, Empresas, Conexões e Configurações › Atendimento, mais as
 * essenciais — e nada de funil/kanban/agenda/IA/análise.
 *
 * É APRESENTAÇÃO, nunca autorização: o papel continua decidindo por cima
 * (`settings/atendimento` é manager+, e some para `agent`), as essenciais nunca
 * somem, e porta de módulo desligado não aparece pelo preset — o filtro de
 * `modulos` existente faz isso, como já faz para `simplificada`.
 */
import { describe, expect, it } from "vitest";

import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  combinarInterfaces,
  destinosDaInterface,
  homeDaInterface,
  INTERFACE_COMPLETA,
  interfaceTemDestino,
  lerInterface,
  PORTAS_ESSENCIAIS,
} from "@/lib/navigation/interface";

const SUPORTE_HREFS = [
  "/app/inbox",
  "/app/tasks",
  "/app/contacts",
  "/app/companies",
  "/app/connections",
  "/app/settings/atendimento",
] as const;

function hrefs(
  settings: unknown,
  role: "agent" | "admin" = "admin",
  modulos?: readonly ModuloOpcional[],
): string[] {
  return destinosDaInterface(settings, false, role, modulos).map((d) => d.href);
}

const sortado = (lista: readonly string[]) => [...new Set(lista)].sort();

describe("preset suporte (spec 2026-11-11 §7)", () => {
  it("as portas do preset existem no catálogo (a lista não pode apontar para porta morta)", () => {
    const ids = new Set(NAV_CATALOG.map((d) => d.href));
    for (const href of SUPORTE_HREFS) {
      expect(ids, `${href} não existe no NAV_CATALOG`).toContain(href);
    }
  });

  it("resolve exatamente as portas do preset + as essenciais (admin, sem lista de módulos)", () => {
    expect(hrefs({ preset: "suporte" }).sort()).toEqual(
      sortado([...SUPORTE_HREFS, ...PORTAS_ESSENCIAIS]),
    );
    // esconde o que a spec manda esconder: funil/kanban/agenda/IA/análise
    const visiveis = hrefs({ preset: "suporte" });
    expect(visiveis).not.toContain("/app/kanban");
    expect(visiveis).not.toContain("/app/agenda");
    expect(visiveis).not.toContain("/app/ai/agents");
  });

  it("destinos à mão continuam mandando sobre o preset", () => {
    const escolha = { preset: "suporte", destinos: ["/app/inbox", "/app/kanban"] };
    const visiveis = hrefs(escolha);
    expect(visiveis).toContain("/app/kanban");
    expect(visiveis).not.toContain("/app/companies");
    expect(visiveis).toContain("/app/inbox");
  });

  it("essenciais nunca somem, nem contra o preset", () => {
    const minima = { preset: "suporte", destinos: ["/app/inbox"] };
    for (const porta of PORTAS_ESSENCIAIS) {
      expect(hrefs(minima), `${porta} sumiu sob o preset suporte`).toContain(porta);
    }
  });

  it("porta de módulo desligado não aparece pelo preset; ligada, aparece", () => {
    // `/app/companies` está no preset, mas é porta do módulo `crm_b2b`.
    expect(hrefs({ preset: "suporte" }, "admin", [])).not.toContain("/app/companies");
    expect(hrefs({ preset: "suporte" }, "admin", ["crm_b2b"])).toContain("/app/companies");
  });

  it("o papel continua decidindo por cima: settings/atendimento é manager+ e some para agent", () => {
    expect(hrefs({ preset: "suporte" }, "admin")).toContain("/app/settings/atendimento");
    const paraAgente = hrefs({ preset: "suporte" }, "agent");
    expect(paraAgente).not.toContain("/app/settings/atendimento");
    expect(paraAgente).not.toContain("/app/team");
    expect(paraAgente).toContain("/app/inbox");
  });

  it("home continua being o Inbox; a interface tem destinos de trabalho", () => {
    expect(homeDaInterface({ preset: "suporte" }, false, "admin")).toBe("/app/inbox");
    expect(interfaceTemDestino({ preset: "suporte" }, "agent")).toBe(true);
  });

  it("lerInterface tolera e preserva o preset salvo", () => {
    const lido = lerInterface({ preset: "suporte" });
    expect(lido.settings.preset).toBe("suporte");
    expect(lido.needsAdjustment).toBe(false);
    // valor desconhecido continua caindo na interface completa (tolerância de antes)
    expect(lerInterface({ preset: "intergalactica" }).settings).toEqual(INTERFACE_COMPLETA);
  });
});

describe("combinarInterfaces com o preset suporte", () => {
  it("preset sobrevive quando nenhum lado escolheu destinos à mão (dos dois lados)", () => {
    expect(combinarInterfaces({ preset: "suporte" }, INTERFACE_COMPLETA).preset).toBe("suporte");
    expect(combinarInterfaces(INTERFACE_COMPLETA, { preset: "suporte" }).preset).toBe("suporte");
    expect(combinarInterfaces({ preset: "suporte" }, { preset: "suporte" }).preset).toBe("suporte");
    expect(combinarInterfaces({ preset: "suporte" }, INTERFACE_COMPLETA).destinos).toBeUndefined();
  });

  it("simplificada continua sobrevivendo sozinha como antes (controle)", () => {
    expect(combinarInterfaces({ preset: "simplificada" }, INTERFACE_COMPLETA).preset).toBe(
      "simplificada",
    );
  });

  it("dois presets diferentes estreitam por interseção — nenhum abre porta que o outro fechou", () => {
    const resultado = combinarInterfaces({ preset: "suporte" }, { preset: "simplificada" });
    const visiveis = hrefs(resultado);
    // inbox/tasks/contacts/connections são comuns; companies e settings/atendimento
    // só estão no suporte, kanban e agenda só estão na simplificada.
    expect(visiveis).toContain("/app/inbox");
    expect(visiveis).toContain("/app/tasks");
    expect(visiveis).not.toContain("/app/companies");
    expect(visiveis).not.toContain("/app/settings/atendimento");
    expect(visiveis).not.toContain("/app/kanban");
    for (const porta of PORTAS_ESSENCIAIS) {
      expect(visiveis, `${porta} sumiu da interseção de presets`).toContain(porta);
    }
  });

  it("destino explícito de um lado volta a ser lista (há decisão humana a respeitar)", () => {
    const resultado = combinarInterfaces(
      { preset: "suporte" },
      { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] },
    );
    expect(resultado.destinos).toEqual(["/app/inbox"]);
    expect(hrefs(resultado)).toContain("/app/inbox");
    expect(hrefs(resultado)).not.toContain("/app/kanban"); // fora do universo da empresa
  });

  it("nem suporte nem simplificada abrem porta que o papel fecha", () => {
    const combinado = combinarInterfaces({ preset: "suporte" }, INTERFACE_COMPLETA);
    expect(hrefs(combinado, "agent")).not.toContain("/app/settings/atendimento");
  });
});
