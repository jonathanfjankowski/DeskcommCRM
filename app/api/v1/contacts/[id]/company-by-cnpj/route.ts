import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/[id]/company-by-cnpj — vincula a empresa do contato
 * pelo CNPJ, pela MESMA função do porteiro do menu (spec 2026-11-11 §3.3 e §6).
 *
 * Existe para o caminho que o menu abre quando o cliente NÃO soube o CNPJ de
 * primeira: "seguir sem empresa". O atendente pergunta na conversa e grava aqui
 * — um campo, não um CRUD: a empresa nasce do documento (find-or-create +
 * cadeia people + enriquecimento BrasilAPI), exatamente como no fluxo do menu.
 *
 * `agent+` (quem atende vincula o cliente dele), auditado, org da sessão —
 * nunca do corpo.
 */
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { vincularEmpresaPorCnpj } from "@/lib/atendimento/menu-de-entrada/empresa-por-cnpj";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ cnpj: z.string().trim().min(11).max(30) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: contactId } = await ctx.params;
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("validation_failed", t("Corpo inválido."), 422, { requestId });
  }
  const parsed = corpoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o CNPJ da empresa."), 422, { requestId, details: { fieldErrors: parsed.error.flatten().fieldErrors } });
  }

  // A ficha tem de estar na visão da org do ator — a RLS decide; daqui é o 404.
  const supabase = await createClient();
  const { data: contato, error: erroLeitura } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", erroLeitura.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const resultado = await vincularEmpresaPorCnpj(createAdminClient(), {
    organizationId: authz.org.orgId,
    contactId,
    cnpj: parsed.data.cnpj,
    actorUserId: authz.user.id,
  });

  if (!resultado.ok) {
    if (resultado.motivo === "cnpj_invalido") {
      return fail("validation_failed", t("Esse CNPJ não confere. Confira os dígitos e tente de novo."), 422, { requestId });
    }
    if (resultado.motivo === "contato_inexistente") {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    return fail("internal_error", t("Não consegui vincular a empresa agora."), 500, { requestId });
  }

  void audit({
    action: "contacts.company_linked_by_cnpj",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: { empresa_id: resultado.empresaId, criada: resultado.criada },
  });

  return ok(
    { empresa: { id: resultado.empresaId, nome: resultado.nome, criada: resultado.criada } },
    { requestId },
  );
}
