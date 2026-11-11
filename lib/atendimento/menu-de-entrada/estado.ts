import { z } from "zod";

/**
 * O estado do menu de entrada na conversa — `conversations.metadata.menu_de_entrada`.
 *
 * Padrão da casa para chaves de metadata (irmão de `ai_com_dono` em
 * `lib/ai/elegibilidade/ia-com-dono.ts`): reader que nunca lança, writer que
 * PRESERVA as outras chaves. Sem schema central de metadata — a forma desta
 * chave é a `estadoLeituraSchema` abaixo, e só ela vale.
 *
 * `service_revision` amarra o estado à SESSÃO DE SERVIÇO: conversa fechada e
 * reaberta bumpa a revision (fn_service_inbound), e o reader devolve `null`
 * para revision diferente — o menu recomeça na sessão nova, sem estado morto
 * de uma conversa antiga.
 */

export const CHAVE_DO_MENU = "menu_de_entrada";

export interface EstadoDoMenu {
  service_revision: number;
  /** `concluido` só existe como ESCRITA (o writer remove a chave). */
  etapa: "cnpj" | "setor" | "concluido";
  tentativas_cnpj: number;
  tentativas_setor: number;
  empresa_id: string | null;
}

/** O que pode estar PERSISTIDO: `concluido` não é lido porque não é gravado. */
const estadoLeituraSchema = z
  .object({
    service_revision: z.number().int().nonnegative(),
    etapa: z.enum(["cnpj", "setor"]),
    tentativas_cnpj: z.number().int().min(0).max(2),
    tentativas_setor: z.number().int().min(0).max(1),
    empresa_id: z.string().uuid().nullable(),
  })
  .strict();

/**
 * Lê o estado da DETERMINADA sessão de serviço. Metadata ausente, torto,
 * etapa desconhecida ou revision de outra sessão devolvem `null` — o handler
 * trata null como "menu ainda não começou naquela sessão".
 */
export function lerEstadoDoMenu(metadata: unknown, serviceRevision: number): EstadoDoMenu | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bruto = (metadata as Record<string, unknown>)[CHAVE_DO_MENU];
  if (bruto === undefined || bruto === null) return null;
  const parse = estadoLeituraSchema.safeParse(bruto);
  if (!parse.success) return null;
  if (parse.data.service_revision !== serviceRevision) return null;
  return parse.data;
}

/**
 * Devolve o metadata NOVO com o estado gravado — ou, em `concluido`, COM A
 * CHAVE REMOVIDA (menu terminou; não deixar estado morto na linha). Nenhuma
 * outra chave é tocada; metadata null/lixo vira objeto só com o que gravamos.
 */
export function metadataComEstadoDoMenu(
  metadata: unknown,
  estado: EstadoDoMenu,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (estado.etapa === "concluido") {
    delete base[CHAVE_DO_MENU];
    return base;
  }
  base[CHAVE_DO_MENU] = estado;
  return base;
}
