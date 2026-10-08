import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SearchOption {
  value: string;
  label: string;
  hint?: string;      // texto menor à direita / abaixo
  header?: boolean;   // linha de grupo (não selecionável)
  depth?: number;     // recuo
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Select com barra de pesquisa (acentos e maiúsculas não importam).
// Cabeçalhos (header) aparecem só quando algum item abaixo deles bate na busca.
export function SearchSelect({ id, value, onChange, options, placeholder = 'Escolha…', emptyLabel, disabled, className, searchPlaceholder = 'Pesquisar…' }: {
  id?: string; value: string; onChange: (v: string) => void; options: SearchOption[]; placeholder?: string;
  emptyLabel?: string; disabled?: boolean; className?: string; searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.value === value && !o.header);

  const visible = useMemo(() => {
    const t = norm(q.trim());
    const base = emptyLabel ? [{ value: '', label: emptyLabel } as SearchOption] : [];
    if (!t) return [...base, ...options];
    const out: SearchOption[] = [];
    let pendingHeaders: SearchOption[] = [];
    for (const o of options) {
      if (o.header) {
        // cabeçalho de nível igual ou acima substitui os pendentes mais fundos
        pendingHeaders = pendingHeaders.filter((h) => (h.depth ?? 0) < (o.depth ?? 0));
        pendingHeaders.push(o);
        continue;
      }
      if (norm(`${o.label} ${o.hint ?? ''}`).includes(t)) {
        for (const h of pendingHeaders) if (!out.includes(h)) out.push(h);
        out.push(o);
      }
    }
    return out;
  }, [options, q, emptyLabel]);
  const selectable = visible.filter((o) => !o.header);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { setActive(Math.max(0, selectable.findIndex((o) => o.value === value))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, q]);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); };

  return (
    <div ref={box} className={cn('relative', className)}>
      <button id={id} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-left text-sm text-[var(--color-text-primary)] focus:border-[var(--accent-primary)] focus:outline-none disabled:opacity-50">
        <span className={cn('truncate', !selected && 'text-[var(--color-text-muted)]')}>{selected ? selected.label : value === '' && emptyLabel ? emptyLabel : placeholder}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-[var(--z-popover,60)] mt-1 min-w-[280px] overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] shadow-[var(--shadow-lg)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3">
            <Search className="h-4 w-4 text-[var(--color-text-muted)]" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, selectable.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const o = selectable[active]; if (o) pick(o.value); }
                else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]" />
            {q && <button type="button" aria-label="Limpar" onClick={() => setQ('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>}
          </div>
          <ul ref={list} role="listbox" className="max-h-72 overflow-auto py-1">
            {selectable.length === 0 && <li className="px-3 py-3 text-sm text-[var(--color-text-muted)]">Nada encontrado.</li>}
            {visible.map((o, i) => {
              if (o.header) {
                return <li key={`h-${o.label}-${i}`} className="px-3 pb-0.5 pt-2 text-xs font-bold text-[var(--color-text-primary)]" style={{ paddingLeft: 12 + (o.depth ?? 0) * 12 }}>{o.label}</li>;
              }
              const idx = selectable.indexOf(o);
              return (
                <li key={o.value || '__empty'} data-idx={idx} role="option" aria-selected={o.value === value}
                  onMouseEnter={() => setActive(idx)} onClick={() => pick(o.value)}
                  className={cn('flex cursor-pointer items-center justify-between gap-2 py-1.5 pr-3 text-sm',
                    idx === active ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-primary)]')}
                  style={{ paddingLeft: 12 + (o.depth ?? 0) * 12 }}>
                  <span className="min-w-0 truncate">{o.label}{o.hint && <span className="ml-2 text-xs text-[var(--color-text-muted)]">{o.hint}</span>}</span>
                  {o.value === value && <Check className="h-4 w-4 shrink-0" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
