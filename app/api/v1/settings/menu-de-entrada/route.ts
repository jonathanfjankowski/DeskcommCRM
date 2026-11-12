/**
 * GET /api/v1/settings/menu-de-entrada — números da org + configs do menu com
 *      suas opções (manager+).
 * PUT /api/v1/settings/menu-de-entrada — grava a config de UM número:
 *      upsert em `menu_de_entrada` (unique org+canal) e SUBSTITUIÇÃO das
 *      opções (delete do que saiu + upsert do conjunto atual, unique
 *      menu+setor). Manager+, `requireSupportWrite`, auditada.
 *
 * O menu de entrada é a triagem determinística por número (spec 2026-11-11
 * §3–4): quem OBEDECE a config é o handler `menuDeEntradaHandler`
 * (`lib/atendimento/menu-de-entrada/handler.ts`). Esta rota só grava e lê.
 *
 * Gate de módulo: sem `setores` ligado a rota não existe (404, mesmo desenho
 * de `app/api/v1/attendants/sectors`) — as opções apontam para setores, e
 * configurar menu sem filas seria configurar nada.
 *
 * Multi-tenancy: toda leitura/escrita vai pelo ADMIN client (as tabelas não
 * concedem escrita a `authenticated`) com `organization_id` filtrado À MÃO,
 * resolvido do cookie (`activeOrg`), nunca do corpo. Os `sector_id` do corpo
 * são a lista de uuid aceito da doutrina (Modelagem, `CLAUDE.md`): pequenos,
 * lidos junto com a linha e CONFERIDOS aqui — setor de outra organização é
 * 422 nomeando o id, antes de qualquer efeito. O mesmo vale para o
 * `channel_session_id`: o composto `(organization_id, channel_session_id)`
 * existe na FK, mas a tela precisa ler o motivo, não o 23503 cru.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { menuConfigSchema } from "@/lib/atendimento/menu-de-entrada/schema";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O corpo do PUT: a config do menu + a QUEM ela pertence (fonte confiável é a org; o número é identificadores, não autoridade). */
const putSchema = menuConfigSchema.extend({
  channel_session_id: z.string().uuid(),
});

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_menu_de_entrada" });
  if (!authz.ok) return authz.response;
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const [canais, configs, opcoes] = await Promise.all([
    admin.from("channel_sessions").select("id, display_name, phone_number").eq("organization_id", orgId),
    admin
      .from("menu_de_entrada")
      .select("id, channel_session_id, ativo, pedir_cnpj, textos, setor_padrao_id, updated_at")
      .eq("organization_id", orgId),
    admin
      .from("menu_de_entrada_opcoes")
      .select("menu_id, sector_id, rotulo, ordem")
      .eq("organization_id", orgId)
      .order("ordem", { ascending: true }),
  ]);
  const leituraRuim = [canais, configs, opcoes].find((q) => q.error);
  if (leituraRuim?.error) return fail("internal_error", leituraRuim.error.message, 500, { requestId });

  const opcoesPorMenu = new Map<string, unknown[]>();
  for (const o of (opcoes.data ?? []) as Array<{ menu_id: string }>) {
    const lista = opcoesPorMenu.get(o.menu_id) ?? [];
    lista.push(o);
    opcoesPorMenu.set(o.menu_id, lista);
  }
  return ok(
    {
      canais: canais.data ?? [],
      configs: ((configs.data ?? []) as Array<{ id: string }>).map((c) => ({
        ...c,
        opcoes: opcoesPorMenu.get(c.id) ?? [],
      })),
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_menu_de_entrada" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user: authUser } = authz;
  const orgId = activeOrg.orgId;

  let input;
  try {
    input = await validateRequest(putSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;

  const admin = createAdminClient();

  // O número tem que SER DA ORGANIZAÇÃO antes de qualquer efeito: a FK composta
  // bararia no insert, mas 23503 cru não diz ao operador o que ele escolheu errado.
  const canal = await admin
    .from("channel_sessions")
    .select("id")
    .eq("id", input.channel_session_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (canal.error) return fail("internal_error", canal.error.message, 500, { requestId });
  if (!canal.data) {
    return fail(
      "validation_error",
      "Este número não pertence à organização. Confira em Conexões.",
      422,
      { requestId, details: { fieldErrors: { channel_session_id: ["unknown_channel"] } } },
    );
  }

  // Setores aceitos: os DA ORG — `opcoes[].sector_id` e `setor_padrao_id`
  // conferidos numa única pergunta (a exceção escrita da lista de uuid).
  const idsSetores = [
    ...new Set([
      ...input.opcoes.map((o) => o.sector_id),
      ...(input.setor_padrao_id ? [input.setor_padrao_id] : []),
    ]),
  ];
  if (idsSetores.length > 0) {
    const setores = await admin
      .from("attendant_sectors")
      .select("id")
      .eq("organization_id", orgId)
      .in("id", idsSetores);
    if (setores.error) return fail("internal_error", setores.error.message, 500, { requestId });
    const conhecidos = new Set((setores.data ?? []).map((s) => s.id as string));
    const fora = idsSetores.filter((id) => !conhecidos.has(id));
    if (fora.length > 0) {
      return fail(
        "validation_error",
        `Setores fora da organização: ${fora.join(", ")}. Crie a fila em Equipe › Setores antes de salvá-la aqui.`,
        422,
        { requestId, details: { unknown_sector_ids: fora } },
      );
    }
  }

  const { data: menu, error: upsertConfig } = await admin
    .from("menu_de_entrada")
    .upsert(
      {
        organization_id: orgId,
        channel_session_id: input.channel_session_id,
        ativo: input.ativo,
        pedir_cnpj: input.pedir_cnpj,
        textos: input.textos,
        setor_padrao_id: input.setor_padrao_id,
      },
      { onConflict: "organization_id,channel_session_id" },
    )
    .select("id")
    .single();
  if (upsertConfig) return fail("internal_error", upsertConfig.message, 500, { requestId });
  if (!menu) return fail("internal_error", "A configuração não foi devolvida.", 500, { requestId });

  // As opções novas SUBSTITUEM o conjunto. Substituição TOTAL (apagar tudo do
  // menu e regravar): `.not(col,"in",…)` não é filtro confiável no PostgREST
  // (medido em produção como PUT 500 com "failed to parse filter not.in.[…]")
  // e o PUT já é o gesto "esta é a lista", feito pela tela com requisição única.
  // Rótulo/ordem vêm inteiros no corpo, então não há o que "atualizar no lugar".
  const { error: apagar } = await admin
    .from("menu_de_entrada_opcoes")
    .delete()
    .eq("organization_id", orgId)
    .eq("menu_id", menu.id);
  if (apagar) return fail("internal_error", apagar.message, 500, { requestId });
  if (input.opcoes.length > 0) {
    const { error: gravarOpcoes } = await admin
      .from("menu_de_entrada_opcoes")
      .upsert(
        input.opcoes.map((o) => ({
          organization_id: orgId,
          menu_id: menu.id,
          sector_id: o.sector_id,
          rotulo: o.rotulo,
          ordem: o.ordem,
        })),
        { onConflict: "menu_id,sector_id" },
      );
    if (gravarOpcoes) return fail("internal_error", gravarOpcoes.message, 500, { requestId });
  }

  void audit({
    action: "settings.menu_de_entrada_changed",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "menu_de_entrada",
    resourceId: menu.id,
    requestId,
    bypassedRls: true,
    metadata: {
      channel_session_id: input.channel_session_id,
      ativo: input.ativo,
      pedir_cnpj: input.pedir_cnpj,
      opcoes: input.opcoes.length,
    },
  });

  return ok(
    {
      menu_id: menu.id,
      channel_session_id: input.channel_session_id,
      ativo: input.ativo,
      pedir_cnpj: input.pedir_cnpj,
      textos: input.textos,
      setor_padrao_id: input.setor_padrao_id,
      opcoes: input.opcoes,
    },
    { requestId },
  );
}
