import type { SupabaseClient } from "@supabase/supabase-js";

import { formatCnpj, normalizeCnpj, normalizePersonName } from "@/lib/crm-b2b/normalize";
import { enrichCompanyFromBrasilApi } from "@/lib/crm-b2b/enrich";
import { logger } from "@/lib/logger";

/**
 * Vínculo empresa↔contato por CNPJ (spec 2026-11-11 §3.2-3.3) — a empresa
 * NASCE do documento que o cliente digitou no menu, sem nenhum CRUD:
 *
 *   1. `normalizeCnpj` valida formato E dígitos (numérico e o alfanumérico
 *      novo da Receita) — recusado antes de qualquer ida ao banco;
 *   2. busca por `(organization_id, normalized_cnpj)` — o unique do produto;
 *      não achou → cria (pending) e dispara o enriquecimento BrasilAPI
 *      fire-and-forget (razão social, fantasia, endereço chegam depois,
 *      sozinhos);
 *   3. cadeia B2B existente: o contato ganha uma `people` (a pessoa que fala)
 *      e a `company_people` liga as duas — `onConflict company_id,person_id`,
 *      `ignoreDuplicates` (re-avisar o mesmo CNPJ do mesmo número nunca
 *      duplica nada);
 *   4. corrida (outro salvando o mesmo CNPJ no mesmo instante) é 23505 →
 *      RE-LEITURA resolve na linha do outro. Duplicata nunca é perda.
 *
 * Service role na mão: TODA query filtra `organization_id`, e a org vem do
 * INPUT (fonte confiável do chamador), nunca de suposição sobre a linha. O
 * nome devolvido é trade_name → legal_name → CNPJ formatado — em qualquer
 * estádio do enriquecimento há uma resposta legível para o `[empresa_cliente]`
 * do template.
 */

export type VinculoResultado =
  | { ok: true; empresaId: string; nome: string; criada: boolean }
  | { ok: false; motivo: "cnpj_invalido" | "contato_inexistente" | "erro" };

export interface EntradaDoVinculo {
  organizationId: string;
  contactId: string;
  cnpj: string;
  /** Autor da criação, quando pessoa (ação do inbox); null = sistema (menu). */
  actorUserId?: string | null;
}

type ContatoLido = { id: string; display_name: string | null; name: string | null; person_id: string | null };
type EmpresaLida = { id: string; trade_name: string | null; legal_name: string | null };

async function buscarEmpresa(
  admin: SupabaseClient,
  organizationId: string,
  normalizedCnpj: string,
): Promise<{ linha: EmpresaLida | null; erro: boolean }> {
  const { data, error } = await admin
    .from("companies")
    .select("id, trade_name, legal_name")
    .eq("organization_id", organizationId)
    .eq("normalized_cnpj", normalizedCnpj)
    .maybeSingle();
  if (error) {
    logger.warn("[menu] busca de empresa por CNPJ falhou", {
      organization_id: organizationId,
      erro: error.message.slice(0, 160),
    });
    return { linha: null, erro: true };
  }
  return { linha: (data as EmpresaLida | null) ?? null, erro: false };
}

function nomeDaEmpresa(empresa: EmpresaLida, normalizedCnpj: string): string {
  return empresa.trade_name ?? empresa.legal_name ?? formatCnpj(normalizedCnpj);
}

export async function vincularEmpresaPorCnpj(
  admin: SupabaseClient,
  input: EntradaDoVinculo,
): Promise<VinculoResultado> {
  const normalized = normalizeCnpj(input.cnpj);
  if (!normalized) return { ok: false, motivo: "cnpj_invalido" };

  const { data: contato, error: erroContato } = await admin
    .from("contacts")
    .select("id, display_name, name, person_id")
    .eq("id", input.contactId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (erroContato) {
    logger.warn("[menu] leitura do contato falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      erro: erroContato.message.slice(0, 160),
    });
    return { ok: false, motivo: "erro" };
  }
  if (!contato) return { ok: false, motivo: "contato_inexistente" };
  const ficha = contato as ContatoLido;

  // 1-2. Empresa: busca, cria se falta, re-leitura na corrida.
  let busca = await buscarEmpresa(admin, input.organizationId, normalized);
  if (busca.erro) return { ok: false, motivo: "erro" };
  let empresa = busca.linha;
  let criada = false;
  if (!empresa) {
    const { data: inserida, error: erroInsert } = await admin
      .from("companies")
      .insert({
        organization_id: input.organizationId,
        cnpj: formatCnpj(normalized),
        normalized_cnpj: normalized,
        enrichment_status: "pending",
        created_by: input.actorUserId ?? null,
      })
      .select("id, trade_name, legal_name")
      .single();
    if (erroInsert) {
      if ((erroInsert as { code?: string }).code === "23505") {
        // Outro gravou o mesmo CNPJ no mesmo instante: a linha dele É a resposta.
        busca = await buscarEmpresa(admin, input.organizationId, normalized);
        if (busca.erro) return { ok: false, motivo: "erro" };
        empresa = busca.linha;
      }
      if (!empresa) return { ok: false, motivo: "erro" };
    } else {
      empresa = inserida as EmpresaLida;
      criada = true;
      // Enriquecimento ASSÍNCRONO de propósito: o menu não pode esperar a
      // Receita para perguntar o setor. Falha aqui é log — a empresa existe,
      // só nasce sem nome social até alguém re-enriquecer pela tela.
      void Promise.resolve(enrichCompanyFromBrasilApi(admin, {
        organizationId: input.organizationId,
        companyId: empresa.id,
        cnpj: normalized,
      })).catch((erro: unknown) =>
        logger.warn("[menu] enriquecimento BrasilAPI falhou", {
          organization_id: input.organizationId,
          company_id: empresa?.id,
          erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
        }),
      );
    }
  }

  // 3. Cadeia people → company_people. O contato vira pessoa com nome próprio;
  // quem já tem pessoa não ganha outra (o vínculo é empresa↔pessoa).
  let personId = ficha.person_id;
  if (!personId) {
    const fullName = ficha.display_name?.trim() || ficha.name?.trim() || `Contato ${formatCnpj(normalized)}`;
    const { data: pessoa, error: erroPessoa } = await admin
      .from("people")
      .insert({
        organization_id: input.organizationId,
        full_name: fullName,
        normalized_name: normalizePersonName(fullName),
        created_by: input.actorUserId ?? null,
      })
      .select("id")
      .single();
    if (erroPessoa || !pessoa) {
      logger.warn("[menu] criação da pessoa do vínculo falhou", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        erro: erroPessoa?.message.slice(0, 160) ?? "sem linha",
      });
      return { ok: false, motivo: "erro" };
    }
    personId = pessoa.id as string;
    const { error: erroUpdate } = await admin
      .from("contacts")
      .update({ person_id: personId })
      .eq("id", input.contactId)
      .eq("organization_id", input.organizationId);
    if (erroUpdate) {
      logger.warn("[menu] contato já vinculado, mas a ficha não pointou a pessoa", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        erro: erroUpdate.message.slice(0, 160),
      });
      return { ok: false, motivo: "erro" };
    }
  }

  const { error: erroLink } = await admin
    .from("company_people")
    .upsert(
      { organization_id: input.organizationId, company_id: empresa.id, person_id: personId },
      { onConflict: "company_id,person_id", ignoreDuplicates: true },
    );
  if (erroLink) {
    logger.warn("[menu] vínculo company_people falhou", {
      organization_id: input.organizationId,
      company_id: empresa.id,
      erro: erroLink.message.slice(0, 160),
    });
    return { ok: false, motivo: "erro" };
  }

  return { ok: true, empresaId: empresa.id, nome: nomeDaEmpresa(empresa, normalized), criada };
}

/**
 * A empresa do contato HOJE — a mesma cadeia que o vínculo escreve, lida para
 * exibição (inbox/ficha) e para a máquina do menu ("esse número já é de qual
 * empresa?"). Preferência `is_primary`, senão o vínculo mais antigo
 * (`created_at`); sem pessoa ou sem vínculo, `null`. Nunca lança: leitura do
 * painel de atendimento não pode derrubar a tela.
 */
export async function empresaDoContato(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<{ id: string; nome: string; cnpj: string | null } | null> {
  try {
    const { data: contato } = await admin
      .from("contacts")
      .select("person_id")
      .eq("id", input.contactId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    const personId = (contato as { person_id?: string | null } | null)?.person_id;
    if (!personId) return null;

    const { data: link } = await admin
      .from("company_people")
      .select("company_id, is_primary")
      .eq("organization_id", input.organizationId)
      .eq("person_id", personId)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle();
    const companyId = (link as { company_id?: string } | null)?.company_id;
    if (!companyId) return null;

    const { data: empresa } = await admin
      .from("companies")
      .select("id, trade_name, legal_name, cnpj")
      .eq("organization_id", input.organizationId)
      .eq("id", companyId)
      .maybeSingle();
    if (!empresa) return null;
    const lida = empresa as EmpresaLida & { id: string; cnpj: string | null };
    return {
      id: lida.id,
      nome: lida.trade_name ?? lida.legal_name ?? lida.cnpj ?? "Empresa",
      cnpj: lida.cnpj ?? null,
    };
  } catch (erro) {
    logger.warn("[menu] leitura da empresa do contato falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}
