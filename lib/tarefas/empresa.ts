/**
 * A EMPRESA DA TAREFA (spec 2026-11-11 §6).
 *
 * `crm_tasks.company_id` e `demandas.company_id` têm chave estrangeira
 * COMPOSTA `(organization_id, company_id) → companies(organization_id, id)`,
 * mas quem cria pela API manda só o `company_id`: a conferência de FK do
 * Postgres não cruza a organização da SESSÃO com a dona da empresa até o
 * insert preencher `organization_id` — e aí a FK passaria para a empresa de
 * outra organização se alguém montasse a linha ao contrário. A régua de quem
 * pode ser apontado mora aqui, como a do responsável em `responsavel.ts` e a
 * da demanda em `demanda.ts`: a empresa tem de ser da organização, conferida
 * à mão (CLAUDE.md, multi-tenancy).
 *
 * A HERANÇA é leitura de conveniência, não gate: tarefa criada presa a uma
 * demanda com empresa, ou a um contato cujo número já aponta para uma empresa
 * (cadeia `people` da Task 12), nasce com a empresa preenchida. Qualquer
 * falha aqui devolve `null` — a tarefa continua nascendo como nascia antes,
 * sem empresa; conveniência nenhuma pode derrubar a criação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { empresaDoContato } from "@/lib/atendimento/menu-de-entrada/empresa-por-cnpj";
import { logger } from "@/lib/logger";

/**
 * A empresa existe NA ORGANIZAÇÃO? `false` também quando o banco não
 * respondeu: sem leitura não há como afirmar o vínculo, e a rota recusa
 * (fail-closed, a mesma regra de `conferirDemanda`).
 */
export async function conferirEmpresa(
  db: SupabaseClient,
  organizationId: string,
  companyId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("companies")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .maybeSingle();
    if (error) {
      logger.warn("[tarefas] conferência de empresa falhou", {
        organization_id: organizationId,
        company_id: companyId,
        erro: error.message.slice(0, 160),
      });
      return false;
    }
    return Boolean(data);
  } catch (erro) {
    logger.warn("[tarefas] conferência de empresa falhou", {
      organization_id: organizationId,
      company_id: companyId,
      erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return false;
  }
}

/**
 * A empresa que a tarefa herda ao nascer: primeiro a da DEMANDA (o vínculo
 * direto é a fonte de verdade — `people` é ambíguo, pessoa com várias empresas);
 * demanda sem empresa (ou sem demanda) cai para o CONTATO pela cadeia `people`
 * da Task 12. `null` = nada a herdar, e a tarefa nasce sem empresa.
 */
export async function empresaHerdada(
  db: SupabaseClient,
  input: { organizationId: string; demandaId?: string | null; contactId?: string | null },
): Promise<string | null> {
  try {
    if (input.demandaId) {
      const { data: demanda, error } = await db
        .from("demandas")
        .select("company_id")
        .eq("id", input.demandaId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();
      if (error) {
        logger.warn("[tarefas] leitura da empresa da demanda falhou", {
          organization_id: input.organizationId,
          demanda_id: input.demandaId,
          erro: error.message.slice(0, 160),
        });
      }
      const daDemanda = (demanda as { company_id?: string | null } | null)?.company_id;
      if (daDemanda) return daDemanda;
    }

    if (input.contactId) {
      const doContato = await empresaDoContato(db, {
        organizationId: input.organizationId,
        contactId: input.contactId,
      });
      if (doContato) return doContato.id;
    }

    return null;
  } catch (erro) {
    logger.warn("[tarefas] herança de empresa falhou", {
      organization_id: input.organizationId,
      erro: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}
