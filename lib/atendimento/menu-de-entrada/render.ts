import type { MenuOpcao } from "./schema";
import { opcoesOrdenadas } from "./parser";

/**
 * Render dos templates configurados (spec §4) — substituição de placeholders,
 * sem expressões nem código no texto. Conhecidos: `[empresa]` (marca da org),
 * `[empresa_cliente]` (a empresa que está chamando), `[nome]` (atendente),
 * `[setor]` (o setor escolhido), `[opcoes]` (a lista numerada GERADA das
 * opções configuradas — o operador nunca digita números à mão).
 *
 * Placeholder CONHECIDO sem valor é REMOVIDO: "[nome]" cru nunca chega ao
 * cliente. Token DESCONHECIDO fica literal — é texto do operador, não
 * placeholder do sistema, e removê-lo esconderia o erro dele.
 */

export interface VarsDoTemplate {
  empresa?: string | null;
  empresa_cliente?: string | null;
  nome?: string | null;
  setor?: string | null;
  opcoes?: readonly MenuOpcao[] | null;
}

const TOKENS_CONHECIDOS = ["empresa_cliente", "empresa", "nome", "setor", "opcoes"] as const;
const REGEX_TOKENS = new RegExp(`\\[(${TOKENS_CONHECIDOS.join("|")})\\]`, "g");

export function renderizarOpcoes(opcoes: readonly MenuOpcao[]): string {
  return opcoesOrdenadas(opcoes)
    .map((o, indice) => `${indice + 1} - ${o.rotulo}`)
    .join("\n");
}

export function renderTemplate(template: string, vars: VarsDoTemplate): string {
  return template.replace(REGEX_TOKENS, (token, nome: string) => {
    if (nome === "opcoes") {
      return vars.opcoes && vars.opcoes.length > 0 ? renderizarOpcoes(vars.opcoes) : "";
    }
    const valor = vars[nome as Exclude<(typeof TOKENS_CONHECIDOS)[number], "opcoes">];
    return valor ?? "";
  });
}
