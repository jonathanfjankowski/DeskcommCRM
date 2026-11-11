"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type {
  ChaveDeTextoDoMenu,
  MenuConfig,
} from "@/lib/atendimento/menu-de-entrada/schema";

/**
 * O estado da tela de Menu de entrada (spec 2026-11-11 §4), no MESMO formato
 * dos irmãos (`hooks/team/useSectors.ts`): query com `enabled` pelo módulo —
 * desligado, a rota responde 404 e a tela nem pergunta — e mutação com
 * invalidação + toast. A API é `app/api/v1/settings/menu-de-entrada`.
 */

export const MENU_DE_ENTRADA_KEY = ["settings", "menu-de-entrada"] as const;

export interface CanalDoMenu {
  id: string;
  display_name: string | null;
  phone_number: string | null;
}

export interface OpcaoDoMenuSalva {
  sector_id: string;
  rotulo: string;
  ordem: number;
}

/** A config como o GET devolve: a linha + as opções embutidas na ordem. */
export interface ConfigDoMenu extends Omit<MenuConfig, "textos" | "opcoes"> {
  id: string;
  channel_session_id: string;
  updated_at: string;
  /** `textos` pode vir parcial do banco (legado); a tela completa com o seed. */
  textos: Partial<Record<ChaveDeTextoDoMenu, string>>;
  opcoes: OpcaoDoMenuSalva[];
}

export interface DadosDoMenu {
  canais: CanalDoMenu[];
  configs: ConfigDoMenu[];
}

/** `ligado = false` com o módulo `setores` desligado: a rota daria 404. */
export function useMenuDeEntrada(ligado = true) {
  return useQuery({
    queryKey: MENU_DE_ENTRADA_KEY,
    enabled: ligado,
    queryFn: async () => apiClient.get<{ data: DadosDoMenu }>("/api/v1/settings/menu-de-entrada"),
    staleTime: 15_000,
  });
}

export interface EscritaDoMenu extends MenuConfig {
  channel_session_id: string;
}

export function useSalvarMenuDeEntrada() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EscritaDoMenu) =>
      apiClient.put<{ data: { menu_id: string } }>("/api/v1/settings/menu-de-entrada", input),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Menu de entrada salvo."));
      qc.invalidateQueries({ queryKey: MENU_DE_ENTRADA_KEY });
    },
  });
}
