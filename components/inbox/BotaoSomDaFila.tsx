"use client";

import { useEffect, useState } from "react";

import { Bell, BellSlash } from "@/lib/ui/icons";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useSomDaFila } from "@/hooks/inbox/useSomDaFila";
import { resumeAudio } from "@/lib/notifications/sounds";
import { cn } from "@/lib/utils";

/**
 * O INTERRUPTOR DO SOM DA FILA (spec 2026-11-11 §8) — preferência POR
 * NAVEGADOR (localStorage): quem liga é a pessoa que está de plantão naquele
 * aparelho, não a empresa. O clique em LIGAR chama `resumeAudio()` — o
 * navegador só deixa tocar depois de um gesto, e este botão É o gesto.
 *
 * Estado inicial neutro e preferência lida no efeito: ler `localStorage` no
 * primeiro render dividiria o HTML do servidor do do cliente (a mesma régua de
 * hidratação que vigia a marca).
 */
const CHAVE_PREFERENCIA = "som-da-fila";

export function BotaoSomDaFila() {
  const t = useT();
  const { activeOrg } = useAuth();
  const [ligado, setLigado] = useState(false);

  useEffect(() => {
    try {
      setLigado(localStorage.getItem(CHAVE_PREFERENCIA) === "1");
    } catch {
      // navegador sem storage (privado restrito): fica desligado, o padrão.
    }
  }, []);

  useSomDaFila(activeOrg?.orgId ?? null, ligado);

  return (
    <button
      type="button"
      data-testid="botao-som-fila"
      aria-pressed={ligado}
      aria-label={t("Som da fila")}
      title={t("Avisa com um som quando um cliente entra na fila")}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:text-foreground",
        ligado && "border-primary/40 text-foreground",
      )}
      onClick={() => {
        const proximo = !ligado;
        if (proximo) void resumeAudio();
        setLigado(proximo);
        try {
          localStorage.setItem(CHAVE_PREFERENCIA, proximo ? "1" : "0");
        } catch {
          // sem storage: vale para esta aba, não sobrevive ao fechar.
        }
      }}
    >
      {ligado ? <Bell size={15} aria-hidden /> : <BellSlash size={15} aria-hidden />}
    </button>
  );
}
