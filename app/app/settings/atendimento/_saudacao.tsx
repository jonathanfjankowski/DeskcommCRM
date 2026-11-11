"use client";
/**
 * A saudação da assumida (spec 2026-11-11 §4): o template enviado pelo sistema
 * quando uma PESSOA assume a conversa — em todos os caminhos (pegar na fila,
 * transferência, roteamento, handoff), porque o evento nasce no ponto único de
 * atribuição. Quem envia é `lib/atendimento/saudacao-na-assumida.ts`; este
 * cartão só grava `settings.atendimento.saudacao_na_assumida`.
 *
 * A prévia é Apresentação local: troca `[nome]` por um nome de exemplo,
 * `[empresa]` pelo nome da organização e `[empresa_cliente]` por um exemplo —
 * o envio real troca pelos valores da conversa.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import { SAUDACAO_PADRAO } from "@/lib/schemas/atendimento";
import type { Idioma } from "@/lib/i18n/idiomas";

export function SaudacaoNaAssumida({
  inicial,
  nomeOrganizacao,
  podeMudar,
  idioma,
}: {
  inicial: { ativo: boolean; template: string };
  nomeOrganizacao: string;
  podeMudar: boolean;
  idioma: Idioma;
}) {
  const [form, setForm] = useState(inicial);
  const [salvo, setSalvo] = useState(inicial);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();
  const t = (texto: string) => traduzir(texto, idioma);

  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);
  const previa = form.template
    .split("[nome]").join("Maria")
    .split("[empresa_cliente]").join(t("Empresa Exemplo"))
    .split("[empresa]").join(nomeOrganizacao);

  function salvar() {
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/atendimento", {
          saudacao_na_assumida: form,
        });
        setSalvo(form);
        toast.success(t("Saudação salva."));
        router.refresh();
      } catch (err) {
        toast.error(t(err instanceof Error ? err.message : "Não foi possível salvar."));
      }
    });
  }

  return (
    <Card className="space-y-4 p-6" data-testid="cartao-saudacao">
      <div>
        <h2 className="text-sm font-semibold">{t("Saudação quando alguém assume")}</h2>
        <p className="text-xs text-muted-foreground">
          {t(
            "A mensagem é enviada pelo sistema sempre que uma pessoa assume a conversa — ao pegar da fila, transferir ou receber do agente. O texto é do cliente, não da tela.",
          )}
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          id="saudacao-ativa"
          checked={form.ativo}
          disabled={pendente || !podeMudar}
          onCheckedChange={(ativo) => setForm((f) => ({ ...f, ativo }))}
          aria-label={t("Mandar saudação quando alguém assume")}
        />
        <span className="space-y-1">
          <Label htmlFor="saudacao-ativa" className="cursor-pointer">
            {t("Mandar saudação quando alguém assume")}
          </Label>
        </span>
      </label>

      <div className="space-y-1">
        <Label htmlFor="saudacao-template">{t("Modelo da saudação")}</Label>
        <Textarea
          id="saudacao-template"
          rows={2}
          maxLength={1000}
          value={form.template}
          placeholder={SAUDACAO_PADRAO}
          disabled={pendente || !podeMudar}
          onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          {t("Os marcadores [nome], [empresa] e [empresa_cliente] são trocados na hora do envio.")}
        </p>
        <p className="text-xs" data-testid="previa-saudacao">
          <span className="text-muted-foreground">{t("Prévia:")} </span>
          {previa}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={salvar} disabled={pendente || !sujo || !podeMudar}>
          {pendente ? t("Salvando…") : t("Salvar saudação")}
        </Button>
        {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
      </div>
    </Card>
  );
}
