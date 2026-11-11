"use client";

/**
 * SELETOR DE EMPRESA — busca por nome/CNPJ no lugar de um Select fechado
 * (spec 2026-11-11 §6).
 *
 * Vive sozinho porque três telas o usam com três larguras e pais diferentes:
 * o formulário de tarefa, a linha da demanda no painel do inbox e, um dia,
 * quem mais precisar. Consultar por cadeia própria (`from("companies")` na
 * tela) não existe: a busca é o `GET /api/v1/companies?search=&limit=20`, a
 * MESMA rota da tela de Empresas, que já sabe buscar em nome fantasia, razão
 * social e CNPJ.
 *
 * E a regra que decide o desenho: **o módulo B2B desligado some com o campo,
 * não com a tela.** A rota responde 404 quando `crm_b2b` está off
 * (`seModuloB2bDesligado`); um seletor que nunca vai funcionar na tela de
 * suporte não se esconde atrás de um clique que dá erro — ele não aparece.
 * Qualquer falha de leitura tem o mesmo destino: renderizar nada. O campo é
 * conveniência; conveniência que não responde é ruído.
 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  /** A empresa escolhida. `null` = sem empresa (e é isso que `onChange(null)` grava). */
  value: string | null;
  onChange: (companyId: string | null) => void;
  disabled?: boolean;
}

interface EmpresaOpcao {
  id: string;
  trade_name: string | null;
  legal_name: string | null;
  cnpj: string | null;
}

/** O mesmo critério de exibição da tela de Empresas: fantasia, razão, CNPJ. */
function nomeDaEmpresa(empresa: EmpresaOpcao): string {
  return empresa.trade_name ?? empresa.legal_name ?? empresa.cnpj ?? "";
}

export function SeletorDeEmpresa({ value, onChange, disabled }: Props) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [opcoes, setOpcoes] = useState<EmpresaOpcao[]>([]);
  const [aberto, setAberto] = useState(false);
  /**
   * O NOME da última empresa resolvida pela ficha (GET /{id}). O rótulo do
   * valor escolhido é DERIVADO na renderização (lista → nome da lista; ficha →
   * `rotuloResolvido`) — guardar `rotulo` em estado sincronizado por efeito é
   * render em cascata, e o lint da casa reprova.
   */
  const [rotuloResolvido, setRotuloResolvido] = useState<{ id: string; nome: string } | null>(null);
  /** Módulo B2B desligado ou leitura sem resposta: o campo se auto-esconde. */
  const [escondido, setEscondido] = useState(false);

  const carregar = useCallback(async (termo: string) => {
    const qs = termo.trim() ? `&search=${encodeURIComponent(termo.trim())}` : "";
    try {
      const r = await apiClient.get<{ data: unknown }>(`/api/v1/companies?limit=20${qs}`);
      setOpcoes(Array.isArray(r.data) ? (r.data as EmpresaOpcao[]) : []);
    } catch {
      // 404 é o módulo desligado; qualquer outro erro é o que não respondeu.
      // Nenhum dos dois justifica um seletor clicável que só devolveria falha.
      setEscondido(true);
      setOpcoes([]);
    }
  }, []);

  // debounce 250 ms, a mesma régua da tela de Empresas: um caractere digitado
  // é uma consulta paginar, e a busca por texto livre não precisa da ÚLTIMA
  // fração de segundo do teclado.
  useEffect(() => {
    if (escondido) return;
    const timer = setTimeout(() => void carregar(busca), 250);
    return () => clearTimeout(timer);
  }, [busca, carregar, escondido]);

  // O VALOR ESCOLHIDO pode não estar na página atual da busca — empresa
  // herdada na criação, ou filtro que mudou depois. Sem pedir o nome à ficha,
  // a tela de edição mostraria campo vazio sobre um valor GRAVADO, e "não
  // mexi em nada" passaria a gravar null. Um GET pontual por id escolhido é o
  // preço de não mentir na tela. Não está na lista NÃO é estado a limpar: a
  // exibição cai na derivação; aqui só se busca o que falta, uma vez por id.
  const precisaDoNome = Boolean(value) && !opcoes.some((o) => o.id === value) && rotuloResolvido?.id !== value;
  useEffect(() => {
    if (!value || !precisaDoNome) return;
    let cancelado = false;
    void (async () => {
      try {
        const r = await apiClient.get<{ data: { company: EmpresaOpcao } }>(
          `/api/v1/companies/${value}`,
        );
        if (!cancelado) setRotuloResolvido({ id: value, nome: nomeDaEmpresa(r.data.company) });
      } catch {
        // Sem ficha, sem nome: o valor continua o que é, e a tentativa não
        // repete a cada render — `{ id, nome: "" }` marca como resolvido.
        if (!cancelado) setRotuloResolvido({ id: value, nome: "" });
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [value, precisaDoNome]);

  // O campo DESAPARECE quando não tem a quem perguntar — e some sem deixar
  // buraco no formulário: quem preenche não pode saber que existe um módulo
  // desligado por decisão da plataforma.
  if (escondido) return null;

  // NOME EXIBIDO, derivado: da página da busca quando o escolhido está nela,
  // senão do que a ficha resolveu. Estado sincronizado por efeito é render em
  // cascata — a derivação lê o mesmo fato sem setState.
  const naLista = value ? opcoes.find((o) => o.id === value) : undefined;
  const nomeEscolhido = value
    ? naLista
      ? nomeDaEmpresa(naLista)
      : rotuloResolvido?.id === value
        ? rotuloResolvido.nome
        : ""
    : "";

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <Input
          aria-label={t("Empresa")}
          placeholder={t("Buscar empresa por nome ou CNPJ")}
          value={busca || nomeEscolhido}
          disabled={disabled}
          onFocus={() => setAberto(true)}
          onBlur={() => setAberto(false)}
          onChange={(e) => {
            setBusca(e.target.value);
            setAberto(true);
          }}
          className="h-9 text-sm"
          data-testid="seletor-empresa-busca"
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={disabled}
            // `mousedown` não tira o foco do campo: o `blur` fecharia a lista
            // antes do clique no item chegar.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(null);
              setBusca("");
            }}
          >
            {t("Limpar")}
          </Button>
        ) : null}
      </div>

      {aberto && opcoes.length > 0 ? (
        <ul
          role="listbox"
          aria-label={t("Resultados da busca de empresa")}
          className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {opcoes.map((opcao) => (
            <li key={opcao.id}>
              <button
                type="button"
                role="option"
                aria-selected={opcao.id === value}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(opcao.id);
                  setBusca("");
                  setAberto(false);
                }}
                className="w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {nomeDaEmpresa(opcao)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
