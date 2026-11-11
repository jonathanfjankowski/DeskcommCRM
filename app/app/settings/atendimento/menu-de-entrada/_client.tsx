"use client";
/**
 * Tela de configuração do MENU DE ENTRADA por número (spec 2026-11-11 §4).
 *
 * O porteiro determinístico que atende antes de qualquer IA: quem lê esta
 * config é `lib/atendimento/menu-de-entrada/handler.ts`. Nada aqui decide
 * comportamento — a tela GRAVA texto, opção e setor padrão; a máquina de
 * estados faz o resto.
 *
 * Os oitos textos nunca ficam hardcoded na tela além do SEED: o valor editável
 * vem da config salva, e o default semeado aparece como placeholder E como
 * valor quando o número ainda não tem config. Texto esvaziado de propósito
 * volta ao padrão ao salvar — mensagem vazia ao cliente não existe.
 */
import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  useMenuDeEntrada,
  useSalvarMenuDeEntrada,
  type CanalDoMenu,
  type ConfigDoMenu,
} from "@/hooks/settings/useMenuDeEntrada";
import { useSectors } from "@/hooks/team/useSectors";
import {
  TEXTOS_PADRAO_DO_MENU,
  type ChaveDeTextoDoMenu,
} from "@/lib/atendimento/menu-de-entrada/schema";
import { nomeDoCanal } from "@/lib/channels/estado";
import { CaretDown, CaretUp, Plus, Trash } from "@/lib/ui/icons";

/** Os oito textos da spec §4, na ordem da tela. Os rótulos moram em `ROTULO_DO_TEXTO`. */
const CAMPOS_DE_TEXTO: readonly ChaveDeTextoDoMenu[] = [
  "boas_vindas_cnpj",
  "cnpj_conhecido",
  "pedido_cnpj",
  "seguir_sem_cnpj",
  "menu_setores",
  "opcao_invalida",
  "confirmacao_fila",
  "aviso_setor_padrao",
];

const ROTULO_DO_TEXTO: Record<ChaveDeTextoDoMenu, string> = {
  boas_vindas_cnpj: "Boas-vindas (CNPJ)",
  cnpj_conhecido: "Empresa conhecida",
  pedido_cnpj: "Pedir CNPJ de novo",
  seguir_sem_cnpj: "Seguir sem CNPJ",
  menu_setores: "Menu de setores",
  opcao_invalida: "Opção inválida",
  confirmacao_fila: "Confirmação da fila",
  aviso_setor_padrao: "Aviso do setor padrão",
};

/** Mesma régua da máquina: o número exibido ao cliente é a posição na ordem. */
const MAX_OPCOES = 8;

interface RascunhoOpcao {
  sector_id: string;
  rotulo: string;
}

function FormularioDoNumero({
  canal,
  config,
  setores,
}: {
  canal: CanalDoMenu;
  config: ConfigDoMenu | undefined;
  setores: { id: string; name: string }[];
}) {
  const t = useT();
  const salvar = useSalvarMenuDeEntrada();
  const [ativo, setAtivo] = useState(config?.ativo ?? false);
  const [pedirCnpj, setPedirCnpj] = useState(config?.pedir_cnpj ?? true);
  const [textos, setTextos] = useState<Record<ChaveDeTextoDoMenu, string>>({
    ...TEXTOS_PADRAO_DO_MENU,
    ...(config?.textos ?? {}),
  });
  const [setorPadrao, setSetorPadrao] = useState<string>(config?.setor_padrao_id ?? "");
  const [opcoes, setOpcoes] = useState<RascunhoOpcao[]>(
    [...(config?.opcoes ?? [])]
      .sort((a, b) => a.ordem - b.ordem)
      .map((o) => ({ sector_id: o.sector_id, rotulo: o.rotulo })),
  );
  const [problema, setProblema] = useState<string | null>(null);

  const nomePorSetor = new Map(setores.map((s) => [s.id, s.name]));

  const adicionarOpcao = () => {
    const usadas = new Set(opcoes.map((o) => o.sector_id));
    const livre = setores.find((s) => !usadas.has(s.id));
    setOpcoes((atual) => [...atual, { sector_id: livre?.id ?? "", rotulo: "" }]);
  };
  const moverOpcao = (indice: number, delta: -1 | 1) => {
    setOpcoes((atual) => {
      const destino = indice + delta;
      if (destino < 0 || destino >= atual.length) return atual;
      const copia = [...atual];
      const origem = copia[indice];
      const alvo = copia[destino];
      if (origem === undefined || alvo === undefined) return atual;
      copia[indice] = alvo;
      copia[destino] = origem;
      return copia;
    });
  };
  const trocarOpcao = (indice: number, campo: keyof RascunhoOpcao, valor: string) =>
    setOpcoes((atual) => atual.map((o, i) => (i === indice ? { ...o, [campo]: valor } : o)));

  async function salvarNumero() {
    const linhas = opcoes.filter((o) => o.sector_id !== "");
    if (new Set(linhas.map((o) => o.sector_id)).size !== linhas.length) {
      setProblema(t("A mesma fila não pode entrar duas vezes no menu."));
      return;
    }
    setProblema(null);
    const textosCheios = Object.fromEntries(
      CAMPOS_DE_TEXTO.map((chave) => {
        const valor = (textos[chave] ?? "").trim();
        return [chave, valor === "" ? TEXTOS_PADRAO_DO_MENU[chave] : textos[chave]];
      }),
    ) as Record<ChaveDeTextoDoMenu, string>;
    await salvar.mutateAsync({
      channel_session_id: canal.id,
      ativo,
      pedir_cnpj: pedirCnpj,
      textos: textosCheios,
      setor_padrao_id: setorPadrao === "" ? null : setorPadrao,
      opcoes: linhas.map((o, i) => ({
        sector_id: o.sector_id,
        rotulo: (o.rotulo.trim() || nomePorSetor.get(o.sector_id) || "").slice(0, 60),
        ordem: i,
      })),
    });
  }

  return (
    <Card className="space-y-4 p-4" data-testid={`menu-numero-${canal.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{t(nomeDoCanal(canal))}</h3>
          <p className="text-xs text-muted-foreground">
            {config?.ativo ? t("Ligado — quem chega por este número passa pelo menu.") : t("Desligado — este número segue o fluxo normal.")}
          </p>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          id={`menu-ativo-${canal.id}`}
          checked={ativo}
          disabled={salvar.isPending}
          onCheckedChange={setAtivo}
          aria-label={t("Menu ligado neste número")}
        />
        <span className="space-y-1">
          <Label htmlFor={`menu-ativo-${canal.id}`} className="cursor-pointer">{t("Menu ligado neste número")}</Label>
          <span className="block text-xs text-muted-foreground">
            {t("Enquanto o menu opera, nenhuma IA responde neste número: o cliente fala com uma pessoa depois da triagem.")}
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          id={`menu-cnpj-${canal.id}`}
          checked={pedirCnpj}
          disabled={salvar.isPending || !ativo}
          onCheckedChange={setPedirCnpj}
          aria-label={t("Pedir o CNPJ antes do menu")}
        />
        <span className="space-y-1">
          <Label htmlFor={`menu-cnpj-${canal.id}`} className="cursor-pointer">{t("Pedir o CNPJ antes do menu")}</Label>
          <span className="block text-xs text-muted-foreground">
            {t("Ligado, o cliente primeiro informa o CNPJ; a empresa conhecida é chamada pelo nome. Desligado, o menu vem direto.")}
          </span>
        </span>
      </label>

      <div className="space-y-3 border-t pt-4">
        <div>
          <h4 className="text-sm font-semibold">{t("Mensagens do menu")}</h4>
          <p className="text-xs text-muted-foreground">
            {t("Os marcadores [empresa], [setor], [opcoes] e [empresa_cliente] são trocados na hora do envio. Deixe vazio para usar o texto padrão.")}
          </p>
        </div>
        {CAMPOS_DE_TEXTO.map((chave) => (
          <div key={chave} className="space-y-1">
            <Label htmlFor={`texto-${chave}`}>{t(ROTULO_DO_TEXTO[chave])}</Label>
            <Textarea
              id={`texto-${chave}`}
              rows={2}
              maxLength={2000}
              value={textos[chave] ?? ""}
              placeholder={TEXTOS_PADRAO_DO_MENU[chave]}
              disabled={salvar.isPending}
              onChange={(e) => setTextos((atual) => ({ ...atual, [chave]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-semibold">{t("Opções do menu")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("Cada opção é uma fila de atendimento (Equipe › Setores). O número que o cliente responde é a posição na lista.")}
        </p>
        {opcoes.map((o, i) => (
          <div key={i} data-testid={`linha-opcao-${i}`} className="flex flex-wrap items-end gap-2">
            <span className="w-6 pb-2 text-sm text-muted-foreground">{i + 1}</span>
            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor={`fila-${i}`}>{t("Fila desta opção")}</Label>
              <select
                id={`fila-${i}`}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={o.sector_id}
                disabled={salvar.isPending}
                onChange={(e) => trocarOpcao(i, "sector_id", e.target.value)}
              >
                <option value="">{t("Escolha a fila…")}</option>
                {setores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor={`rotulo-${i}`}>{t("Rótulo desta opção")}</Label>
              <Input
                id={`rotulo-${i}`}
                maxLength={60}
                value={o.rotulo}
                placeholder={nomePorSetor.get(o.sector_id) ?? ""}
                disabled={salvar.isPending}
                onChange={(e) => trocarOpcao(i, "rotulo", e.target.value)}
              />
            </div>
            <div className="flex gap-1 pb-1">
              <Button type="button" variant="outline" size="icon" aria-label={t("Subir")} disabled={i === 0 || salvar.isPending} onClick={() => moverOpcao(i, -1)}>
                <CaretUp />
              </Button>
              <Button type="button" variant="outline" size="icon" aria-label={t("Descer")} disabled={i === opcoes.length - 1 || salvar.isPending} onClick={() => moverOpcao(i, 1)}>
                <CaretDown />
              </Button>
              <Button type="button" variant="outline" size="icon" aria-label={t("Remover opção")} disabled={salvar.isPending} onClick={() => setOpcoes((atual) => atual.filter((_, j) => j !== i))}>
                <Trash />
              </Button>
            </div>
          </div>
        ))}
        {opcoes.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {ativo ? t("Ligado sem opções, o cliente não tem para onde ir — adicione ao menos uma fila.") : t("Sem opções por enquanto.")}
          </p>
        )}
        <Button type="button" variant="outline" size="sm" onClick={adicionarOpcao} disabled={opcoes.length >= MAX_OPCOES || salvar.isPending}>
          <Plus /> {t("Adicionar opção")}
        </Button>
      </div>

      <div className="space-y-1 border-t pt-4">
        <Label htmlFor="setor-padrao">{t("Setor padrão (opcional)")}</Label>
        <select
          id="setor-padrao"
          className="h-10 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
          value={setorPadrao}
          disabled={salvar.isPending}
          onChange={(e) => setSetorPadrao(e.target.value)}
        >
          <option value="">{t("Nenhum — a última tentativa cai na primeira opção")}</option>
          {setores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t("Para quem errar o número depois da primeira tentativa: sem padrão, a conversa vai para a primeira opção da lista.")}
        </p>
      </div>

      {problema ? (
        <p role="alert" className="text-sm text-destructive">{problema}</p>
      ) : null}

      <Button onClick={() => void salvarNumero()} disabled={salvar.isPending}>
        {salvar.isPending ? t("Salvando…") : t("Salvar menu")}
      </Button>
    </Card>
  );
}

export function MenuDeEntradaClient({ setoresLigado }: { setoresLigado: boolean }) {
  const t = useT();
  const menu = useMenuDeEntrada(setoresLigado);
  const setores = useSectors(setoresLigado);
  const [canalEscolhido, setCanalEscolhido] = useState<string | null>(null);

  if (!setoresLigado) {
    return (
      <Card className="space-y-2 p-4">
        <p className="text-sm">
          {t("Ligue o módulo Setores para desenhar o menu de entrada: cada opção do menu é uma fila de atendimento.")}{" "}
          <Link className="underline" href="/app/settings/recursos">{t("Ir para Recursos opcionais")}</Link>
        </p>
      </Card>
    );
  }
  if (menu.isLoading || setores.isLoading) {
    return <Skeleton className="h-40 max-w-3xl" />;
  }
  if (menu.isError) {
    return <p className="text-sm text-destructive">{t("Não foi possível carregar o menu de entrada.")}</p>;
  }

  const canais = menu.data?.data.canais ?? [];
  const configs = menu.data?.data.configs ?? [];
  const selecionado = canalEscolhido ?? canais[0]?.id ?? null;
  const canal = canais.find((c) => c.id === selecionado) ?? null;
  const config = configs.find((k) => k.channel_session_id === selecionado);
  const listaSetores = (setores.data?.data ?? []).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {canais.length === 0 ? (
        <Card className="p-4">
          <Link className="underline text-sm" href="/app/connections">{t("Conecte um número para configurar o menu.")}</Link>
        </Card>
      ) : (
        <fieldset className="space-y-2 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{t("Escolha o número")}</legend>
          {canais.map((c) => {
            const cfg = configs.find((k) => k.channel_session_id === c.id);
            return (
              <label key={c.id} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted max-md:min-h-11 max-md:items-center">
                <input
                  type="radio"
                  name="canal-do-menu"
                  checked={c.id === selecionado}
                  onChange={() => setCanalEscolhido(c.id)}
                />
                {t(nomeDoCanal(c))}
                {cfg?.ativo ? <span className="text-xs text-muted-foreground">— {t("menu ligado")}</span> : null}
              </label>
            );
          })}
        </fieldset>
      )}

      {canal ? (
        // A key remonta o formulário por número: as escolhas de um canal nunca
        // vazam para o rascunho do outro.
        <FormularioDoNumero key={canal.id} canal={canal} config={config} setores={listaSetores} />
      ) : null}
    </div>
  );
}
