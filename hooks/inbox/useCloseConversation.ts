"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { Conversation } from "@/lib/types/messaging";

interface CloseArgs {
  conversation_id: string;
  expected_revision?: number;
  /**
   * "Devolver ao automático ao fechar" (#3313) — a escolha que o diálogo de
   * fechamento mostra quando o CONTATO está travado com a equipe
   * (`contacts.force_human`), com "devolver" MARCADO por padrão.
   *
   * AUSENTE = fechar não mexe em trava nenhuma: é o que a tela manda em
   * conversa de contato sem trava, e o que todo cliente antigo da API continua
   * mandando. Por isso a chave só entra no corpo quando a escolha existe — um
   * `false` explícito diria "não devolva", que é uma resposta a uma pergunta
   * que ninguém fez.
   */
  devolver_ao_automatico?: boolean;
  /**
   * Registro de atendimento (spec 2026-11-11 §5) — o diálogo pergunta título
   * + conteúdo + desfecho quando a conversa tem demanda atual. A rota encerra
   * a demanda DEPOIS de fechar: recusa no registro não derruba o fechamento,
   * e o motivo volta em `registro` na resposta.
   */
  registro?: { titulo: string; conteudo?: string; desfecho?: string };
}

/**
 * O que a rota responde sobre a devolução: `null`/ausente = ninguém pediu.
 *
 * `ok: false` significa **a conversa fechou e a trava CONTINUA**. Não é erro
 * para a tela: é a única resposta honesta quando o `ai_opt_out` do contato
 * recusa a devolução, e a tela precisa dizê-la — foi exatamente o silêncio
 * sobre a trava que virou a issue #3313.
 */
interface RespostaDeFechamento {
  data: Conversation & {
    devolucao?: { ok: boolean; motivo?: string } | null;
    registro?: { ok: boolean; motivo?: string } | null;
  };
}

export function useCloseConversation() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: async (args: CloseArgs) => {
      const corpo: {
        expected_revision?: number;
        devolver_ao_automatico?: boolean;
        registro?: CloseArgs["registro"];
      } = {
        expected_revision: args.expected_revision,
      };
      if (args.devolver_ao_automatico !== undefined) {
        corpo.devolver_ao_automatico = args.devolver_ao_automatico;
      }
      if (args.registro !== undefined) {
        corpo.registro = args.registro;
      }
      return apiClient.post<RespostaDeFechamento>(
        `/api/v1/conversations/${args.conversation_id}/close`,
        corpo,
      );
    },
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (resposta, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });

      // O registro pode ter recusado mesmo com a conversa fechada (a ordem é
      // essa de propósito) — o aviso sai antes dos toasts da devolução, e as
      // duas recusas podem conviver no mesmo fechamento.
      const registro = resposta?.data?.registro;
      if (registro && !registro.ok) {
        toast.warning(fraseDeRecusaDoRegistro(registro.motivo, t));
      }

      const devolucao = resposta?.data?.devolucao;
      if (!devolucao || devolucao.ok) return;
      // A conversa encerrou; o que NÃO aconteceu foi a volta da IA. Duas razões
      // diferentes, duas frases diferentes: uma é o pedido do próprio cliente
      // (marca permanente), a outra é defeito — e quem lê a segunda tem de
      // saber que dá para tentar de novo pelo botão da conversa.
      if (devolucao.motivo === "contato_sempre_humano") {
        toast.info(
          t(
            "Conversa encerrada. A IA não voltou neste contato: ele está marcado como sempre atendimento humano, e a marca continua mandando. Para a IA atender, remova a marca na ficha do contato.",
          ),
        );
        return;
      }
      // Regra de dono do botão "Devolver ao automático" (#3436): a conversa é
      // de outro atendente e quem fechou não é gerente — tentar de novo pelo
      // botão recusaria igual, então a frase aponta quem pode.
      if (devolucao.motivo === "conversa_de_outro_atendente") {
        toast.info(
          t(
            "Conversa encerrada. A IA não voltou neste contato: a conversa é de outro atendente, e só um gerente pode devolvê-la ao automático.",
          ),
        );
        return;
      }
      toast.warning(
        t(
          "Conversa encerrada, mas não consegui devolver o atendimento ao automático — a trava continua. Use Devolver ao automático na conversa para tentar de novo.",
        ),
      );
    },
  });
}

/** Toast de recusa do registro: o texto é um só por motivo — cada um diz o que
 *  a equipe pode fazer, porque o fechamento já aconteceu e não há o que refazer. */
function fraseDeRecusaDoRegistro(motivo: string | undefined, t: (s: string) => string): string {
  switch (motivo) {
    case "demanda_mudou":
      return t(
        "Conversa encerrada, mas o atendimento tinha mudado bem na hora de gravar o registro. Abra o atendimento na ficha do contato e registre o desfecho por lá.",
      );
    case "demanda_ja_encerrada":
      return t(
        "Conversa encerrada. O atendimento já tinha sido encerrado — o registro não foi gravado por cima do que existe.",
      );
    case "sem_demanda":
      return t(
        "Conversa encerrada. Não havia atendimento aberto para receber o registro.",
      );
    default:
      return t(
        "Conversa encerrada, mas não consegui gravar o registro de atendimento. Registre o desfecho pela ficha do contato.",
      );
  }
}

/**
 * ARQUIVAR (#923) — tira a conversa do fluxo vivo sem destruir nada.
 *
 * Vai pelo mesmo PATCH versionado da reabertura, com `status: "archived"`: quem
 * aplica é a `fn_service_status`, com o lock otimista de sempre. Não existe rota
 * nova porque arquivar NÃO é um efeito colateral — é a mesma transição de status
 * que a API já aceita, e uma rota dedicada só criaria um segundo caminho para o
 * mesmo UPDATE.
 */
export function useArchiveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CloseArgs) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "archived", expected_revision: args.expected_revision },
    ),
    // `onSettled`, e não `onSuccess`: mesmo no 409 (alguém mexeu na conversa
    // entre a leitura e este clique) a tela precisa reler — é o estado do
    // servidor que vale, não o que estava no cache.
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}

/** Reabertura explícita preserva as proteções de automação do contato. */
export function useReopenConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CloseArgs) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "open", expected_revision: args.expected_revision },
    ),
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
