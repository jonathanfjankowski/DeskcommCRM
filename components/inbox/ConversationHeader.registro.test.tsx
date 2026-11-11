import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O REGISTRO DE ATENDIMENTO AO FECHAR (spec 2026-11-11 §5) — o diálogo pergunta
 * título + conteúdo + desfecho quando a conversa tem demanda atual, e o corpo do
 * fechamento leva `registro`. Sem demanda aberta a pergunta não aparece (nada
 * onde gravar), e o fechamento é exatamente o de antes.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 * - Tirar o gate `temDemandaAberta`: o caso "sem demanda" acusa a seção.
 * - Esquecer o `registro` no mutate: os dois primeiros casos caem.
 * - Liberar o Fechar com título vazio: o caso do botão desabilitado cai.
 */

const closeMutate = vi.hoisted(() => vi.fn());
const papel = vi.hoisted(() => ({ atual: "agent" }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", role: papel.atual },
  }),
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: closeMutate, isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useIaComDono", () => ({ useIaComDono: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/useCarteiraDoContato", () => ({
  useCarteiraDoContato: () => ({ data: { dono_user_id: null }, isLoading: false }),
  useDefinirCarteira: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [], isLoading: false }) }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/SnoozeButton", () => ({ SnoozeButton: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/hooks/inbox/useEnderecoDaResposta", () => ({ useEnderecoDaResposta: () => ({ data: undefined }) }));
vi.mock("@/components/inbox/ParticipantesDaConversa", () => ({
  ParticipantesDaConversa: () => null,
  DialogoDeConvite: () => null,
}));
vi.mock("@/components/agenda/ReservarServicoNaConversa", () => ({
  ItemReservarServico: () => null,
  ReservarServicoNaConversa: () => null,
}));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: { configured: true, paired: true } }),
}));
vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startCall: vi.fn() }),
}));

function conversa(comDemanda: string | null): ConversationWithContact {
  return {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    channel_session_id: "sess-1",
    channel: "whatsapp",
    status: "open",
    status_changed_at: new Date().toISOString(),
    service_revision: 3,
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: null,
    assigned_at: null,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_at: null,
    last_message_preview: null,
    unread_count_for_assignee: 0,
    is_group: false,
    group_chat_id: null,
    tags: [],
    metadata: {},
    snooze_until: null,
    current_demanda_id: comDemanda,
    contacts: {
      id: "contato-1",
      display_name: "Ana",
      name: "Ana",
      phone_number: "+5511999999999",
      tags: [],
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
    },
    channel_sessions: null,
  } as unknown as ConversationWithContact;
}

async function abrirODialogoDeFechar(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("acao-fechar"));
  const dialogo = await screen.findByRole("alertdialog");
  return dialogo as HTMLElement;
}

beforeEach(() => {
  closeMutate.mockReset();
  papel.atual = "agent";
});

describe("registro de atendimento no diálogo de fechamento", () => {
  it("conversa com demanda aberta: pergunta título, exige título e envia o registro", async () => {
    const { unmount } = render(<ConversationHeader conversation={conversa("demanda-1")} />);
    const dialogo = await abrirODialogoDeFechar();

    expect(within(dialogo).getByTestId("registro-ao-fechar")).toBeTruthy();
    const botaoFechar = within(dialogo)
      .getAllByRole("button")
      .find((b) => b.textContent?.trim() === "Fechar")!;
    expect((botaoFechar as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialogo).getByTestId("registro-titulo"), {
      target: { value: "  Impressora sem responder  " },
    });
    expect((botaoFechar as unknown as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(botaoFechar);

    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
      registro: { titulo: "Impressora sem responder", desfecho: "resolvida" },
    });
    unmount();
  });

  it("conteúdo e desfecho escolhidos viajam no registro (conteúdo aparado)", async () => {
    const { unmount } = render(<ConversationHeader conversation={conversa("demanda-1")} />);
    const dialogo = await abrirODialogoDeFechar();
    fireEvent.change(within(dialogo).getByTestId("registro-titulo"), { target: { value: "Título" } });
    fireEvent.change(within(dialogo).getByTestId("registro-conteudo"), {
      target: { value: "  Revisado em conjunto com o TI local.  " },
    });
    fireEvent.change(within(dialogo).getByTestId("registro-desfecho"), {
      target: { value: "nao_procede" },
    });
    const botaoFechar = within(dialogo)
      .getAllByRole("button")
      .find((b) => b.textContent?.trim() === "Fechar")!;
    fireEvent.click(botaoFechar);
    expect(closeMutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      expected_revision: 3,
      registro: { titulo: "Título", conteudo: "Revisado em conjunto com o TI local.", desfecho: "nao_procede" },
    });
    unmount();
  });

  it("conversa SEM demanda atual: nenhuma pergunta nova, fechamento como sempre", async () => {
    const { unmount } = render(<ConversationHeader conversation={conversa(null)} />);
    const dialogo = await abrirODialogoDeFechar();
    expect(within(dialogo).queryByTestId("registro-ao-fechar")).toBeNull();
    const botaoFechar = within(dialogo)
      .getAllByRole("button")
      .find((b) => b.textContent?.trim() === "Fechar")!;
    expect((botaoFechar as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(botaoFechar);
    expect(closeMutate).toHaveBeenCalledWith({ conversation_id: "conv-1", expected_revision: 3 });
    unmount();
  });
});
