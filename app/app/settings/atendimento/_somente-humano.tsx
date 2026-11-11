"use client";
/**
 * O interruptor `somente_humano` da empresa (spec 2026-11-11 §7).
 *
 * Quem OBEDECE é o gate de elegibilidade (`lib/ai/elegibilidade/gate.ts`,
 * motivo `org_somente_humano`): ligada daqui, nenhuma conversa nova passa por
 * agente de IA. A gravação é a REST da casa — PATCH `/api/v1/settings/atendimento`
 * (merge não-destrutivo e CAS na rota), toast e `router.refresh()` — no mesmo
 * desenho do cartão de assinatura desta tela.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function SomenteHumano({
  valorInicial,
  podeMudar,
  idioma,
}: {
  valorInicial: boolean;
  podeMudar: boolean;
  idioma: Idioma;
}) {
  const [valor, setValor] = useState(valorInicial);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <Card className="p-6" data-testid="cartao-somente-humano">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="somente-humano">{t("Atendimento só por pessoas")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Ligado, nenhuma conversa nova desta empresa passa por agente de IA — o atendimento é sempre humano. Desligado, cada conversa segue a regra de elegibilidade de sempre.",
            )}
          </p>
          <p className="text-xs">
            {valor
              ? t("A IA está desligada para novas conversas desta empresa.")
              : t("A IA continua atendendo onde for elegível.")}
          </p>
        </div>
        <Switch
          id="somente-humano"
          checked={valor}
          disabled={pendente || !podeMudar}
          onCheckedChange={(novo) =>
            startTransition(async () => {
              try {
                await apiClient.patch("/api/v1/settings/atendimento", { somente_humano: novo });
                setValor(novo);
                toast.success(t("Opção salva."));
                router.refresh();
              } catch (err) {
                toast.error(t(err instanceof Error ? err.message : "Não foi possível salvar."));
              }
            })
          }
        />
      </div>
    </Card>
  );
}
