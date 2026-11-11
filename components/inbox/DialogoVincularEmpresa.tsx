"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * VINCULAR EMPRESA POR CNPJ (spec 2026-11-11 §3.3/§6) — um campo, não um CRUD:
 * para o número cujo cliente não soube o documento no menu, o atendente pergunta
 * na conversa e grava daqui. A empresa nasce (ou é reusada) pela MESMA função do
 * porteiro: validação com dígito verificador, upsert por (org, CNPJ), cadeia
 * people e enriquecimento BrasilAPI. Aparece na lateral da conversa e na ficha
 * do contato onde houver lugar para o botão.
 */
export function DialogoVincularEmpresa({
  contactId,
  onVinculada,
}: {
  contactId: string;
  onVinculada: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [cnpj, setCnpj] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function vincular() {
    const valor = cnpj.trim();
    if (!valor || enviando) return;
    setEnviando(true);
    try {
      await apiClient.post(`/api/v1/contacts/${contactId}/company-by-cnpj`, { cnpj: valor });
      toast.success(t("Empresa vinculada."));
      setAberto(false);
      setCnpj("");
      onVinculada();
    } catch (erro) {
      toast.error(erro instanceof Error && erro.message ? erro.message : t("Não foi possível vincular a empresa."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="vincular-empresa"
        className="text-xs text-muted-foreground underline hover:text-foreground"
        onClick={() => setAberto(true)}
      >
        {t("Vincular empresa por CNPJ")}
      </button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Vincular empresa por CNPJ")}</DialogTitle>
            <DialogDescription>
              {t("A empresa nasce do documento: se o CNPJ já é cliente, o cadastro existente é reusado.")}
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            data-testid="vincular-empresa-cnpj"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={t("CNPJ")}
            value={cnpj}
            maxLength={30}
            onChange={(e) => setCnpj(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void vincular();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button disabled={cnpj.trim().length === 0 || enviando} onClick={() => void vincular()}>
              {enviando ? t("Salvando…") : t("Vincular")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
