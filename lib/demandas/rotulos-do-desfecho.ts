/**
 * VOCABULÁRIO DE DESFECHO PARA A TELA (spec 2026-11-11 §6).
 *
 * Mora em `lib/` e não dentro do painel do inbox porque duas telas leem o
 * mesmo fato: o histórico do contato (`components/inbox/CRMSidePanel.tsx`) e
 * o card "Atendimentos" da ficha da empresa (`app/app/companies/[id]`). Uma
 * tradução do mesmo vocabulário copiada em dois lugares diverge na primeira
 * troca de palavra — e quem nota é quem usa as duas telas na mesma semana.
 *
 * Os CÓDIGOS são os do CHECK do banco (`demandas_desfecho_check`); o rótulo é
 * interface e passa por `t()` em quem renderiza — aqui ficam as chaves PT-BR.
 */
export const DESFECHO_LEGIVEL: Record<string, string> = {
  resolvida: "Resolvida",
  convertida: "Convertida",
  nao_procede: "Não procede",
  encerrada_pelo_cliente: "Encerrada pelo cliente",
  perdida: "Perdida",
  expirada_sem_resposta: "Expirada sem resposta",
};
