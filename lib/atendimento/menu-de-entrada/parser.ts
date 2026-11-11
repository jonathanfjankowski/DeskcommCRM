import type { MenuOpcao } from "./schema";

/**
 * O parser da resposta do menu — determinístico, sem modelo.
 *
 * Casa de duas formas: pelo NÚMERO (a posição na lista ordenada por `ordem`,
 * 1-based — o mesmo número que `renderizarOpcoes` mostrou ao cliente) ou pelo
 * RÓTULO normalizado (sem acento, sem caixa, aparado). Áudio/mídia sem texto,
 * número fora do range e texto solto devolvem `null` — quem decide a
 * consequência (repetir o menu / setor padrão) é a máquina, não o parser.
 */

export function normalizarRotulo(bruto: string): string {
  return bruto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function opcoesOrdenadas(opcoes: readonly MenuOpcao[]): MenuOpcao[] {
  return [...opcoes].sort((a, b) => a.ordem - b.ordem);
}

export function parseOpcaoDoMenu(
  texto: string | null,
  opcoes: readonly MenuOpcao[],
): { sector_id: string; rotulo: string } | null {
  if (texto === null) return null;
  const alvo = texto.trim();
  if (alvo === "") return null;
  const ordenadas = opcoesOrdenadas(opcoes);

  if (/^\d{1,2}$/.test(alvo)) {
    const indice = Number(alvo);
    const escolha = indice >= 1 && indice <= ordenadas.length ? ordenadas[indice - 1] : undefined;
    return escolha ? { sector_id: escolha.sector_id, rotulo: escolha.rotulo } : null;
  }

  const porRotulo = ordenadas.find((o) => normalizarRotulo(o.rotulo) === normalizarRotulo(alvo));
  return porRotulo ? { sector_id: porRotulo.sector_id, rotulo: porRotulo.rotulo } : null;
}
