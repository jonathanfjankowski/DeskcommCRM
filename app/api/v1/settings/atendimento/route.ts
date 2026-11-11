/**
 * GET   /api/v1/settings/atendimento — lê a config de atendimento (manager+):
 *       `organizations.settings.atendimento` (somente humano + saudação).
 * PATCH /api/v1/settings/atendimento — grava (manager+, CAS, auditada).
 *
 * Irmã de `settings/routing` no mesmo gate (manager+): a tela que hospeda
 * Distribuição de Atendimento salva daqui o "quem atende" humano, e o merge
 * não-destrutivo protege as demais chaves de `organizations.settings` —
 * inclusive o `routing` que ela mesma escreve na outra aba.
 *
 * A escrita vai pelo ADMIN client porque a única policy de UPDATE de
 * `organizations` é `orgs_write_platform_admin` (issue #144): pelo client de
 * sessão o UPDATE casaria ZERO linhas e o PostgREST diria sucesso — a tela
 * mostraria "salvo" com nada gravado. O filtro por org é explícito e o CAS é
 * do documento inteiro (padrão `settings/catalogo`): escrita concorrente
 * nunca perde outra configuração da empresa.
 *
 * Quem OBEDECE `somente_humano` é o gate de elegibilidade
 * (`lib/ai/elegibilidade/gate.ts`, motivo `org_somente_humano`); quem envia a
 * saudação é o handler do evento de assumida (`lib/atendimento/saudacao-na-
 * assumida.ts`). Esta rota só grava configuração.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { atendimentoPatchSchema, mesclarSettingsAtendimento } from "@/lib/schemas/atendimento";
import { atendimentoDeclarado } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_atendimento" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data: orgRow, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  return ok(atendimentoDeclarado(settings), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_atendimento" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user: authUser } = authz;

  let input;
  try {
    input = await validateRequest(atendimentoPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const db = createAdminClient();
  const lido = await db.from("organizations").select("settings").eq("id", activeOrg.orgId).maybeSingle();
  // Leitura que falhou não vira settings vazio: o update apagaria o resto da
  // configuração da empresa (mesma régua de settings/catalogo).
  if (lido.error || !lido.data) {
    return fail("internal_error", "Falha ao ler a configuração.", 500, { requestId });
  }

  const currentSettings = (lido.data.settings as Record<string, unknown> | null) ?? {};
  const { settings: nextSettings, atendimento } = mesclarSettingsAtendimento(currentSettings, input);

  const update = db.from("organizations").update({ settings: nextSettings }).eq("id", activeOrg.orgId);
  const salvo = await (currentSettings === null || lido.data.settings === null
    ? update.is("settings", null)
    : update.filter("settings", "eq", JSON.stringify(lido.data.settings))
  )
    .select("id")
    .maybeSingle();
  if (salvo.error) return fail("internal_error", "Falha ao salvar.", 500, { requestId });
  if (!salvo.data) {
    return fail("conflict", "A configuração mudou. Recarregue a página e tente de novo.", 409, {
      requestId,
    });
  }

  void audit({
    action: "settings.atendimento_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: {
      ...(input.somente_humano !== undefined ? { somente_humano: atendimento.somente_humano } : {}),
      ...(input.saudacao_na_assumida !== undefined ? { saudacao: true } : {}),
    },
  });

  return ok(atendimento, { requestId });
}
