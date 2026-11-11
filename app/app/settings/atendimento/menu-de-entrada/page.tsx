/**
 * Configurações → Atendimento → Menu de entrada (spec 2026-11-11 §4).
 *
 * A triagem determinística por número, tela que hospeda a config lida pelo
 * porteiro (`lib/atendimento/menu-de-entrada/handler.ts`). Gate igual ao da
 * página-mãe (manager+): quem desenha o atendimento é quem o administra, e a
 * API da tela reforça o mesmo `requireRole`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { MenuDeEntradaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function MenuDeEntradaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const idioma = user.idioma;
  // Mesma régua da rota: módulo desligado = a tela explica como ligar, a API
  // responde 404 e o cliente nem pergunta.
  const setoresLigado = await moduloLigado(createAdminClient(), "setores");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Menu de entrada", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "A triagem por número que atende antes de qualquer IA: boas-vindas, pedido de CNPJ, opções por fila e para onde cai quando o cliente erra. Os textos vão ao WhatsApp, não à tela — edite com esse cliente em mente.",
            idioma,
          )}
        </p>
      </header>
      <MenuDeEntradaClient setoresLigado={setoresLigado} />
    </div>
  );
}
