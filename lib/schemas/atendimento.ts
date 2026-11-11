/**
 * A config de ATENDIMENTO da organização — `organizations.settings.atendimento`.
 *
 * O BLOCK (schema + leitura defensiva + `SAUDACAO_PADRAO`) mora em
 * `./settings.ts`, na casa das demais seções de `organizations.settings`
 * (ouvidoria, crm, automações, entrada_automatica_no_funil...). Este arquivo
 * é a metade de ESCRITA: o corpo aceito pela PATCH e o merge não-destrutivo,
 * irmãos de `mesclarSettingsDeAtendimento` de `./routing.ts`.
 */
import { z } from "zod";

import {
  atendimentoDeclarado,
  SAUDACAO_PADRAO,
  type AtendimentoSettings,
} from "./settings";

export { atendimentoDeclarado, SAUDACAO_PADRAO, type AtendimentoSettings };

/** O corpo aceito pela PATCH — estrito: chave desconhecida é erro, não silêncio. */
export const atendimentoPatchSchema = z
  .object({
    somente_humano: z.boolean().optional(),
    saudacao_na_assumida: z
      .object({
        ativo: z.boolean().optional(),
        template: z.string().trim().max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AtendimentoPatch = z.infer<typeof atendimentoPatchSchema>;

/**
 * Merge não-destrutivo em DOIS níveis (irmão de `mesclarSettingsDeAtendimento`
 * de routing.ts): preserva as demais chaves de `settings` e, dentro do bloco
 * `atendimento`, o que veio OMITIDO mantém o valor que já valia. Um cliente
 * que só liga o "somente humano" não pode, por omissão, apagar o template que
 * a equipe escreveu.
 */
export function mesclarSettingsAtendimento(
  atual: Record<string, unknown>,
  input: AtendimentoPatch,
): { settings: Record<string, unknown>; atendimento: AtendimentoSettings } {
  const blocoAtual = atendimentoDeclarado(atual);
  const atendimento: AtendimentoSettings = {
    somente_humano: input.somente_humano ?? blocoAtual.somente_humano,
    saudacao_na_assumida: {
      ativo: input.saudacao_na_assumida?.ativo ?? blocoAtual.saudacao_na_assumida.ativo,
      template: input.saudacao_na_assumida?.template ?? blocoAtual.saudacao_na_assumida.template,
    },
  };
  return { settings: { ...atual, atendimento }, atendimento };
}
