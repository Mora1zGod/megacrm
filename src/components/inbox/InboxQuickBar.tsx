import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationWithContact } from '@/types/inbox';
import type { InboxFilterState } from './inbox-filters';

export type QuickChip = 'todas' | 'nao_lidas' | 'aguardando' | 'atrasadas' | 'aguardando_cliente' | 'ia_pausada' | 'favoritas' | 'grupos';

// Grupo do WhatsApp (UAZAPI): o contato do grupo tem como "telefone" o JID
// do grupo (…@g.us). Grupos ficam só na aba Grupos — não misturam com os
// atendimentos 1:1 nem entram nos contadores das outras abas.
export function isGroupConversation(c: ConversationWithContact): boolean {
  return (c.contact?.phone ?? '').endsWith('@g.us');
}

interface Props {
  // Busca livre: nome OU telefone. Um campo só, como no WhatsApp — o operador
  // não quer escolher em qual campo procurar, quer achar a pessoa.
  busca: string;
  onBuscaChange: (v: string) => void;
  chip: QuickChip;
  onChipChange: (c: QuickChip) => void;
  // Lista JÁ filtrada pelos filtros avançados, mas ANTES da busca/chip — é a
  // base correta para os contadores refletirem o que o clique vai mostrar.
  base: ConversationWithContact[];
  filters: InboxFilterState;
}

// Aguardando resposta = a última mensagem foi do contato.
export function isAguardando(c: ConversationWithContact): boolean {
  return c.lastMessageDirection === 'inbound';
}

// SLA estourado: contato esperando há mais que o limite vermelho.
export function isAtrasada(c: ConversationWithContact, slaLateMinutes: number, now = Date.now()): boolean {
  return Boolean(c.waitingSince) && now - new Date(c.waitingSince!).getTime() >= slaLateMinutes * 60_000;
}

export function matchesQuickChip(c: ConversationWithContact, chip: QuickChip, slaLateMinutes = 15): boolean {
  if (chip === 'grupos') return isGroupConversation(c);
  if (isGroupConversation(c)) return false;
  switch (chip) {
    case 'nao_lidas':
      return (c.unread_count ?? 0) > 0;
    case 'aguardando':
      return isAguardando(c);
    case 'atrasadas':
      return isAtrasada(c, slaLateMinutes);
    // Aguardando cliente = a equipe/IA já respondeu e espera o contato voltar
    // (oposto de "aguardando" — que é a equipe devendo resposta ao contato).
    case 'aguardando_cliente':
      return c.status !== 'closed' && !isAguardando(c);
    case 'ia_pausada':
      return Boolean(c.ai_paused);
    case 'favoritas':
      return Boolean(c.is_favorite);
    default:
      return true;
  }
}

export function matchesBusca(c: ConversationWithContact, busca: string): boolean {
  const q = busca.trim().toLowerCase();
  if (!q) return true;
  const nome = (c.contact?.name ?? '').toLowerCase();
  if (nome.includes(q)) return true;
  const digitos = q.replace(/\D/g, '');
  if (digitos) {
    const fone = (c.contact?.phone ?? '').replace(/\D/g, '');
    if (fone.includes(digitos)) return true;
  }
  // Busca também na prévia da última mensagem — é assim que a pessoa lembra
  // da conversa ("aquele que perguntou do day use").
  const ultima = (c.lastMessagePreview ?? '').toLowerCase();
  return ultima.includes(q);
}

export function InboxQuickBar({ busca, onBuscaChange, chip, onChipChange, base, trailing, slaLateMinutes = 15, now }: Props & { trailing?: ReactNode; slaLateMinutes?: number; now?: number }) {
  const contagem = useMemo(() => {
    let naoLidas = 0;
    let aguardando = 0;
    let atrasadas = 0;
    let aguardandoCliente = 0;
    let iaPausada = 0;
    let favoritas = 0;
    let grupos = 0;
    let todas = 0;
    for (const c of base) {
      if (isGroupConversation(c)) { grupos++; continue; }
      todas++;
      if ((c.unread_count ?? 0) > 0) naoLidas++;
      if (isAguardando(c)) aguardando++;
      if (isAtrasada(c, slaLateMinutes, now)) atrasadas++;
      else if (c.status !== 'closed') aguardandoCliente++;
      if (c.ai_paused) iaPausada++;
      if (c.is_favorite) favoritas++;
    }
    return { todas, naoLidas, aguardando, atrasadas, aguardandoCliente, iaPausada, favoritas, grupos };
  }, [base, slaLateMinutes, now]);

  const chips: Array<{ id: QuickChip; label: string; count: number; title?: string }> = [
    { id: 'todas', label: 'Tudo', count: contagem.todas },
    { id: 'nao_lidas', label: 'Não lidas', count: contagem.naoLidas },
    { id: 'aguardando', label: 'Aguardando', count: contagem.aguardando, title: 'Aguardando resposta da equipe' },
    { id: 'atrasadas', label: 'Atrasadas', count: contagem.atrasadas, title: `Esperando resposta há ${slaLateMinutes} min ou mais (SLA)` },
    { id: 'aguardando_cliente', label: 'Aguardando cliente', count: contagem.aguardandoCliente },
    { id: 'ia_pausada', label: 'AMAIA pausada', count: contagem.iaPausada },
    { id: 'favoritas', label: 'Favoritas', count: contagem.favoritas },
    { id: 'grupos', label: 'Grupos', count: contagem.grupos },
  ];

  // Aba sem nada para mostrar (fora Tudo/Grupos) fica oculta.
  const shown = chips.filter((c) => c.id === 'todas' || c.id === 'grupos' || c.count > 0 || chip === c.id);

  return (
    <div className="space-y-2.5">
      <QuickChips chips={shown} active={chip} onPick={(id) => onChipChange(chip === id && id !== 'todas' ? 'todas' : id)} />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            aria-label="Buscar por nome, telefone ou mensagem"
            placeholder="Pesquisar conversas..."
            className={cn(
              'w-full rounded-xl border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] py-2 pl-9 pr-8 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)]',
            )}
          />
          {busca && (
            <button
              type="button"
              onClick={() => onBuscaChange('')}
              aria-label="Limpar busca"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {trailing}
      </div>
    </div>
  );
}

// Abas que cabem na largura + "Mais ▾" com as outras (antes a faixa rolava para o lado com a barra
// escondida e, no computador, as últimas abas — Grupos, Favoritas… — ficavam inalcançáveis).
// A aba escolhida fica sempre à vista: se ela estiver no "Mais", ocupa o lugar da última que coube.
type Chip = { id: QuickChip; label: string; count: number; title?: string };
const GAP = 6;
const MORE_W = 78;

function QuickChips({ chips, active, onPick }: { chips: Chip[]; active: QuickChip; onPick: (id: QuickChip) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState(chips.length);
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const key = chips.map((c) => `${c.id}:${c.count}`).join('|');

  useLayoutEffect(() => {
    const box = boxRef.current;
    const meas = measureRef.current;
    if (!box || !meas) return;
    const calc = () => {
      const widths = Array.from(meas.children).map((el) => (el as HTMLElement).offsetWidth);
      const avail = box.clientWidth;
      const total = widths.reduce((a, w) => a + w + GAP, -GAP);
      if (total <= avail) { setFit(widths.length); return; }
      let used = MORE_W, n = 0;
      for (const w of widths) { if (used + w + GAP > avail) break; used += w + GAP; n++; }
      setFit(Math.max(1, n));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(box);
    return () => ro.disconnect();
  }, [key]);

  let visible = chips.slice(0, fit);
  const activeChip = chips.find((c) => c.id === active);
  if (activeChip && !visible.includes(activeChip) && visible.length) visible = [...visible.slice(0, -1), activeChip];
  const hidden = chips.filter((c) => !visible.includes(c));

  const renderChip = (c: Chip, extra?: { tabIndex?: number }) => (
    <button key={c.id} type="button" title={c.title} aria-pressed={active === c.id} onClick={() => onPick(c.id)} {...extra}>
      {c.label}
      {c.count > 0 && <span className="count">{c.count}</span>}
    </button>
  );

  const openMenu = () => {
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu(menu ? null : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <div ref={boxRef} className="relative">
      {/* Medição invisível de cada aba (largura real com o contador). */}
      <div ref={measureRef} aria-hidden className="inbox-quick-filters pointer-events-none invisible absolute left-0 top-0 !overflow-visible">
        {chips.map((c) => renderChip(c, { tabIndex: -1 }))}
      </div>
      <div className="inbox-quick-filters !overflow-visible" role="tablist" aria-label="Filtrar conversas">
        {visible.map((c) => renderChip(c))}
        {hidden.length > 0 && (
          <button ref={moreRef} type="button" onClick={openMenu} aria-expanded={!!menu} aria-haspopup="menu" title="Mais filtros">
            Mais
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {menu && createPortal(
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setMenu(null)} />
          <div role="menu" style={{ top: menu.top, right: menu.right }}
            className="fade-scale-in fixed z-[calc(var(--z-dropdown)+1)] w-56 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
            {hidden.map((c) => (
              <button key={c.id} type="button" role="menuitem" title={c.title}
                onClick={() => { onPick(c.id); setMenu(null); }}
                className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
                <span className="flex-1">{c.label}</span>
                {c.count > 0 && <span className="rounded-full bg-[var(--color-fill-subtle)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-text-secondary)]">{c.count}</span>}
                {active === c.id && <Check className="h-4 w-4 text-[var(--accent-primary)]" />}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
