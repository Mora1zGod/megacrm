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
            className={cn(thClass, 'group relative cursor-grab select-none', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center',
              over === c.id && 'bg-[var(--color-accent-subtle)]')}>
            <span className={cn('flex items-center gap-1', c.align === 'right' && 'justify-end', c.align === 'center' && 'justify-center')}>
              <GripVertical className="pointer-events-none absolute left-0.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-50" aria-hidden />
              {c.sortValue ? (
                <button type="button" onClick={() => grid.toggleSort(c.id)} className="flex min-w-0 items-center gap-1 uppercase hover:text-[var(--color-text-primary)]"
                  title="Clique para ordenar · arraste para mudar a posição">
                  <span className="truncate">{c.label}</span>
                  {s === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0 text-[var(--accent-primary)]" /> : s === 'desc' ? <ArrowDown className="h-3 w-3 shrink-0 text-[var(--accent-primary)]" />
                    : <ArrowUpDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-40" />}
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

// ---------------------------------------------------------------------------
// DataGrid: a tabela completa (colunas móveis/redimensionáveis/ordenáveis) pronta para qualquer lista.
//   const grid = useGrid('chave', columns, rows);
//   <DataGrid grid={grid} rowKey={(r) => r.id} onRowClick={…} actions={(r) => …} />
// ---------------------------------------------------------------------------
export function DataGrid<T>({
  grid, rowKey, onRowClick, rowClassName, actions, actionsWidth = 140, actionsLabel = 'Ações', emptyText = 'Nada encontrado com esses filtros.',
  footer, selection, thClass = DEFAULT_TH, tdClass = DEFAULT_TD, className,
}: {
  grid: Grid<T>;
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  rowClassName?: (r: T) => string | undefined | false | null;
  actions?: (r: T) => ReactNode;
  actionsWidth?: number;
  actionsLabel?: string;
  emptyText?: string;
  footer?: Record<string, ReactNode>;          // conteúdo do rodapé por id de coluna
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void };
  thClass?: string; tdClass?: string; className?: string;
}) {
  const rows = grid.sorted;
  const lead = selection ? [44] : [];
  const trail = actions ? [actionsWidth] : [];
  const width = lead.reduce((a, b) => a + b, 0) + grid.cols.reduce((a, c) => a + grid.width(c), 0) + trail.reduce((a, b) => a + b, 0);
  const allOn = !!selection && rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)));
  const someOn = !!selection && rows.some((r) => selection.selected.has(rowKey(r)));
  const toggle = (id: string) => {
    if (!selection) return;
    const n = new Set(selection.selected);
    if (n.has(id)) n.delete(id); else n.add(id);
    selection.onChange(n);
  };
  return (
    <div className={cn('overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]', className)}>
      <table className="text-sm" style={{ tableLayout: 'fixed', width, minWidth: '100%' }}>
        <GridColGroup grid={grid} lead={lead} trail={trail} />
        <thead>
          <GridHead grid={grid} thClass={thClass}
            lead={selection ? (
              <th className={cn(thClass, 'w-11')}>
                <input type="checkbox" aria-label="Marcar todas" checked={allOn} ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                  onChange={() => { const n = new Set(selection.selected); for (const r of rows) { if (allOn) n.delete(rowKey(r)); else n.add(rowKey(r)); } selection.onChange(n); }} className="h-4 w-4 accent-[var(--accent-fill)]" />
              </th>
            ) : undefined}
            trail={actions ? <th className={cn(thClass, 'text-right')}>{actionsLabel}</th> : undefined} />
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={grid.cols.length + lead.length + trail.length} className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">{emptyText}</td></tr>
          )}
          {rows.map((r) => {
            const id = rowKey(r);
            return (
              <tr key={id} onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn('border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]', onRowClick && 'cursor-pointer',
                  selection?.selected.has(id) && 'bg-[var(--color-accent-subtle)]', rowClassName?.(r))}>
                {selection && (
                  <td className={tdClass} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Marcar linha" checked={selection.selected.has(id)} onChange={() => toggle(id)} className="h-4 w-4 accent-[var(--accent-fill)]" />
                  </td>
                )}
                {grid.cols.map((c) => (
                  <td key={c.id} className={cn(tdClass, 'overflow-hidden', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>{c.render(r)}</td>
                ))}
                {actions && <td className={cn(tdClass, 'text-right')} onClick={(e) => e.stopPropagation()}>{actions(r)}</td>}
              </tr>
            );
          })}
        </tbody>
        {footer && rows.length > 0 && (
          <tfoot><tr className="border-t border-[var(--color-border-card)] font-semibold">
            {selection && <td className={tdClass} />}
            {grid.cols.map((c) => <td key={c.id} className={cn(tdClass, 'whitespace-nowrap', c.align === 'right' && 'text-right tabular-nums')}>{footer[c.id] ?? null}</td>)}
            {actions && <td />}
          </tr></tfoot>
        )}
      </table>
    </div>
  );
}

const DEFAULT_TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] whitespace-nowrap';
const DEFAULT_TD = 'px-3 py-2 align-middle';

// Botão "Colunas padrão" (só aparece quando a pessoa mexeu nas colunas).
export function GridReset<T>({ grid }: { grid: Grid<T> }) {
  if (!grid.customized) return null;
  return (
    <button type="button" onClick={grid.reset} title="Volta a ordem e a largura original das colunas"
      className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
      Colunas padrão
    </button>
  );
}

// Linhas para exportar (Excel/PDF) na ordem de colunas que a pessoa arrumou.
export function gridExportRows<T>(grid: Grid<T>): { header: string[]; rows: Array<Array<string | number | null>> } {
  return {
    header: grid.cols.map((c) => c.label),
    rows: grid.sorted.map((r) => grid.cols.map((c) => (c.exportValue ? c.exportValue(r) : c.sortValue ? c.sortValue(r) : ''))),
  };
}
