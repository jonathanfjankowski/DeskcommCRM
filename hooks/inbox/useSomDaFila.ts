"use client";

import { useEffect, useRef } from "react";

import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { playSound } from "@/lib/notifications/sounds";

/**
 * O SOM DE ENTRADA NA FILA (spec 2026-11-11 §8): toca uma nota curta quando a
 * contagem canônica de fila SUBE — nunca ao abrir a tela com fila já esperando
 * (a primeira leitura fixa a régua), nunca quando ela desce.
 *
 * A contagem vem do MESMO `useConversationCounts` do contador do menu e das
 * abas do Inbox — a definição de "fila" é uma só, no servidor
 * (`lib/inbox/comando-da-conversa`, vigiado por `fila-tem-uma-definicao-so`).
 * Quem traz a novidade é o tempo-real: desde esta entrega ele invalida também
 * as contagens (`recargaDasConversas`), então o som chega no instante em que o
 * cliente entra na fila, não no próximo ciclo de 30s.
 *
 * Rajadas (vários clientes entrando juntos, ou a rajada de eventos de UM só
 * inbound) viram UM toque: `INTERVALO_MINIMO_MS` entre toques. Som e toggle
 * vivem no `BotaoSomDaFila`; desligado, o hook segue acompanhando a régua —
 * ligar no meio de uma fila formada não toca o histórico.
 */
export const INTERVALO_MINIMO_MS = 2_000;

export function useSomDaFila(orgId: string | null, ligado: boolean): void {
  const { data } = useConversationCounts(orgId);
  const ultimaFilaRef = useRef<number | null>(null);
  const ultimoToqueRef = useRef(0);

  useEffect(() => {
    const fila = data?.fila ?? data?.unassigned ?? 0;
    const anterior = ultimaFilaRef.current;
    ultimaFilaRef.current = fila;
    if (anterior === null) return; // primeira leitura: só registra a régua
    if (fila <= anterior) return;
    if (!ligado) return;
    const agora = Date.now();
    if (agora - ultimoToqueRef.current < INTERVALO_MINIMO_MS) return;
    ultimoToqueRef.current = agora;
    playSound("attention");
  }, [data, ligado]);
}
