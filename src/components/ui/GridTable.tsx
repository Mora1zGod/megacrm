import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

// Tabela com colunas que o usuário arrasta (ordem), estica/encolhe (largura) e ordena (clique no título).
// A arrumação fica salva neste navegador (localStorage), por tabela.
export interface GridColumn<T> {
  id: string;
  label: string;
  width: number;                         // largura inicial (px)
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  sortValue?: (row: T) => string | number | null; // sem isto, a coluna não ordena
  render: (row: T) => ReactNode;
  exportValue?: (row: T) => string | number | null; // valor no Excel/PDF (sem isto, usa sortValue)
  footer?: ReactNode;
  className?: string;
}

interface Saved { order: string[]; widths: Record<string, number>; sort: { id: string; dir: 'asc' | 'desc' } | null }

function read(key: string): Partial<Saved> {
  try { return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Partial<Saved>; } catch { return {}; }
}
function write(key: string, v: Saved) {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* sem storage: só não lembra */ }
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

export function useGrid<T>(storageKey: string, columns: GridColumn<T>[], rows: T[], defaultSort: Saved['sort'] = null) {
  const saved = useMemo(() => read(storageKey), [storageKey]);
  const ids = columns.map((c) => c.id);
  const [order, setOrder] = useState<string[]>(() => {
    const o = (saved.order ?? []).filter((id) => ids.includes(id));
    return [...o, ...ids.filter((id) => !o.includes(id))];
  });
  const [widths, setWidths] = useState<Record<string, number>>(saved.widths ?? {});
  const [sort, setSort] = useState<Saved['sort']>(saved.sort === undefined ? defaultSort : saved.sort);
  const persist = (p: Partial<Saved>) => write(storageKey, { order, widths, sort, ...p });

  const cols = order.map((id) => columns.find((c) => c.id === id)).filter(Boolean) as GridColumn<T>[];
  const width = (c: GridColumn<T>) => Math.max(c.minWidth ?? 60, widths[c.id] ?? c.width);

  const sorted = useMemo(() => {
    const c = sort && columns.find((x) => x.id === sort.id);
    if (!c?.sortValue) return rows;
    const dir = sort!.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = c.sortValue!(a); const vb = c.sortValue!(b);
      if (va === null || va === '') return 1;
      if (vb === null || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return collator.compare(String(va), String(vb)) * dir;
    });
  }, [rows, sort, columns]);

  const toggleSort = (id: string) => {
    const next: Saved['sort'] = !sort || sort.id !== id ? { id, dir: 'asc' } : sort.dir === 'asc' ? { id, dir: 'desc' } : null;
    setSort(next); persist({ sort: next });
  };
  const move = (from: string, to: string) => {
    if (from === to) return;
    const o = order.filter((x) => x !== from);
    o.splice(o.indexOf(to), 0, from);
    setOrder(o); persist({ order: o });
  };
  const resize = (id: string, w: number) => setWidths((cur) => ({ ...cur, [id]: Math.round(w) }));
  const commitWidths = () => setWidths((cur) => { write(storageKey, { order, widths: cur, sort }); return cur; });
  const reset = () => {
    setOrder(ids); setWidths({}); setSort(defaultSort);
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
  };
  const customized = order.join() !== ids.join() || Object.keys(widths).length > 0;

  return { cols, sorted, sort, width, toggleSort, move, resize, commitWidths, reset, customized };
}

export type Grid<T> = ReturnType<typeof useGrid<T>>;

// Cabeçalho: arrastar o título muda a ordem; puxar a borda direita muda a largura; clicar ordena.
export function GridHead<T>({ grid, thClass, lead, trail }: { grid: Grid<T>; thClass: string; lead?: ReactNode; trail?: ReactNode }) {
  const dragId = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const startResize = (e: React.PointerEvent, c: GridColumn<T>) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const w0 = grid.width(c);
    const onMove = (ev: PointerEvent) => grid.resize(c.id, Math.max(c.minWidth ?? 60, w0 + ev.clientX - x0));
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); grid.commitWidths(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <tr className="border-b border-[var(--color-border-card)]">
      {lead}
      {grid.cols.map((c) => {
        const s = grid.sort?.id === c.id ? grid.sort.dir : null;
        return (
          <th key={c.id} scope="col" draggable
            onDragStart={(e) => { dragId.current = c.id; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); setOver(c.id); }}
            onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (dragId.current) grid.move(dragId.current, c.id); dragId.current = null; setOver(null); }}
            onDragEnd={() => { dragId.current = null; setOver(null); }}
            aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : undefined}
            className={cn(thClass, 'group relative select-none', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center',
              over === c.id && 'bg-[var(--color-accent-subtle)]')}>
            <span className={cn('flex items-center gap-1', c.align === 'right' && 'justify-end', c.align === 'center' && 'justify-center')}>
              <GripVertical className="h-3 w-3 shrink-0 cursor-grab opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
              {c.sortValue ? (
                <button type="button" onClick={() => grid.toggleSort(c.id)} className="flex min-w-0 items-center gap-1 uppercase hover:text-[var(--color-text-primary)]"
                  title="Clique para ordenar · arraste para mudar a posição">
                  <span className="truncate">{c.label}</span>
                  {s === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0 text-[var(--accent-primary)]" /> : s === 'desc' ? <ArrowDown className="h-3 w-3 shrink-0 text-[var(--accent-primary)]" />
                    : <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" />}
                </button>
              ) : <span className="truncate">{c.label}</span>}
            </span>
            <span role="separator" aria-orientation="vertical" aria-label={`Largura da coluna ${c.label}`} onPointerDown={(e) => startResize(e, c)}
              onDragStart={(e) => e.preventDefault()} draggable={false}
              className="absolute right-0 top-1/4 h-1/2 w-2 cursor-col-resize border-r-2 border-[var(--color-border-card)] opacity-0 hover:border-[var(--accent-primary)] group-hover:opacity-100" />
          </th>
        );
      })}
      {trail}
    </tr>
  );
}

export function GridColGroup<T>({ grid, lead = [], trail = [] }: { grid: Grid<T>; lead?: number[]; trail?: number[] }) {
  return (
    <colgroup>
      {lead.map((w, i) => <col key={`l${i}`} style={{ width: w }} />)}
      {grid.cols.map((c) => <col key={c.id} style={{ width: grid.width(c) }} />)}
      {trail.map((w, i) => <col key={`t${i}`} style={{ width: w }} />)}
    </colgroup>
  );
}
