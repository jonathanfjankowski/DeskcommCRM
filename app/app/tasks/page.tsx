import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

import { TarefasClient } from "./_components/TarefasClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tarefas" };

/**
 * TAREFAS — "ligar de volta na terça", num lugar que não é a memória de ninguém.
 *
 * Extraído do PR #418, de @clinicacentrodosorrisosc-code, que construiu o
 * módulo inteiro rodando o produto numa operação real. O que muda aqui é o
 * vocabulário: a tela dele somava tarefas com "agendamentos" derivados de
 * `custom_fields.agendamento_*` do lead, e falava consulta/procedimento/
 * compareceu. Compromisso com cliente já é a Agenda (migration 0177), que tem
 * tabela, horário, local e confirmação — e este produto atende clínica,
 * imobiliária, loja e infoproduto com as mesmas telas.
 *
 * ─── Quem pode o quê ───────────────────────────────────────────────────────
 *
 * `viewer` VÊ as tarefas: saber o que o time combinou é informação de operação.
 * Criar e editar é `agent` — e a rota cobra de novo (`requireRole("agent")`).
 * A tela esconder o botão é cortesia, não autorização.
 */
export default async function TarefasPage({
  searchParams,
}: {
  searchParams: Promise<{ assigned_to?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  // `?assigned_to=me` é o endereço que o lembrete e o push de tarefa abrem.
  const { assigned_to } = await searchParams;

  // Os funis vivos da organização ativa, para o seletor. Lido aqui e não por `GET /api/v1/pipelines`
  // (que exige manager): a tela de Tarefas abre para qualquer papel. `organization_id` à mão porque
  // a RLS libera todas as organizações do usuário.
  const supabase = await createClient();
  const { data: funis } = await supabase
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position");

  // As empresas da organização ativa, para o FILTRO de empresa (spec §6). Lidas
  // aqui, pelo mesmo motivo dos funis: `GET /api/v1/companies` é módulo-gated e
  // a tela abre para qualquer papel. O teto de 200 é do seletor, não do banco —
  // beyond isso a busca por texto na lista da tela de Empresas já é o caminho.
  const { data: empresas } = await supabase
    .from("companies")
    .select("id, trade_name, legal_name")
    .eq("organization_id", activeOrg.orgId)
    .order("trade_name", { ascending: true })
    .limit(200);

  return (
    <TarefasClient
      podeEditar={podeEditar}
      minhasDeInicio={assigned_to === "me"}
      funis={(funis ?? []) as Array<{ id: string; name: string }>}
      empresas={(empresas ?? []) as Array<{ id: string; trade_name: string | null; legal_name: string | null }>}
    />
  );
}
