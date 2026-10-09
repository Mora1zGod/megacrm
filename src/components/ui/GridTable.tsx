import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp, Columns3, GripVertical } from 'lucide-react';
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
  defaultHidden?: boolean;               // começa escondida (a pessoa liga em "Colunas")
}

interface Saved { order: string[]; widths: Record<string, number>; sort: { id: string; dir: 'asc' | 'desc' } | null; hidden?: string[] }

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
    // Coluna nova (que não existia quando a pessoa salvou): entra logo depois da vizinha do padrão.
    for (const id of ids) {
      if (o.includes(id)) continue;
      const prev = ids.slice(0, ids.indexOf(id)).reverse().find((x) => o.includes(x));
      o.splice(prev ? o.indexOf(prev) + 1 : 0, 0, id);
    }
    return o;
  });
  const [widths, setWidths] = useState<Record<string, number>>(saved.widths ?? {});
  const [sort, setSort] = useState<Saved['sort']>(saved.sort === undefined ? defaultSort : saved.sort);
  const defHidden = columns.filter((c) => c.defaultHidden).map((c) => c.id);
  // Colunas novas com defaultHidden começam escondidas mesmo para quem já tinha salvo a tabela.
  const [hidden, setHidden] = useState<string[]>(() => !saved.hidden ? defHidden
    : [...saved.hidden, ...defHidden.filter((id) => !(saved.order ?? []).includes(id) && !saved.hidden!.includes(id))]);
  const persist = (p: Partial<Saved>) => write(storageKey, { order, widths, sort, hidden, ...p });

  const allCols = order.map((id) => columns.find((c) => c.id === id)).filter(Boolean) as GridColumn<T>[];
  const cols = allCols.filter((c) => !hidden.includes(c.id));
  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    if (allCols.length - next.length < 1) return;
    setHidden(next); persist({ hidden: next });
  };
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
  // Arrastar para a direita entra DEPOIS da coluna alvo; para a esquerda, ANTES (assim a vizinha também troca).
  const move = (from: string, to: string) => {
    if (from === to) return;
    const fi = order.indexOf(from); const ti = order.indexOf(to);
    const o = order.filter((x) => x !== from);
    o.splice(o.indexOf(to) + (fi < ti ? 1 : 0), 0, from);
    setOrder(o); persist({ order: o });
  };
  // Sobe/desce uma posição (menu "Colunas").
  const step = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const o = [...order]; [o[i], o[j]] = [o[j], o[i]];
    setOrder(o); persist({ order: o });
  };
  const resize = (id: string, w: number) => setWidths((cur) => ({ ...cur, [id]: Math.round(w) }));
  const commitWidths = () => setWidths((cur) => { write(storageKey, { order, widths: cur, sort, hidden }); return cur; });
  const reset = () => {
    setOrder(ids); setWidths({}); setSort(defaultSort); setHidden(defHidden);
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
  };
  const customized = order.join() !== ids.join() || Object.keys(widths).length > 0 || hidden.join() !== defHidden.join();

  return { cols, allCols, hidden, toggleHidden, sorted, sort, width, toggleSort, move, step, resize, commitWidths, reset, customized };
}

export type Grid<T> = ReturnType<typeof useGrid<T>>;

// Cabeçalho: arrastar o título muda a ordem; puxar a borda direita muda a largura; clicar ordena.
export function GridHead<T>({ grid, thClass, lead, trail, scale = 1 }: { grid: Grid<T>; thClass: string; lead?: ReactNode; trail?: ReactNode; scale?: number }) {
  const dragId = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const startResize = (e: React.PointerEvent, c: GridColumn<T>) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const w0 = grid.width(c);
    const k = scale > 0 ? scale : 1; // a tela mostra a largura escalada; o arraste mexe na proporção
    const onMove = (ev: PointerEvent) => grid.resize(c.id, Math.max(c.minWidth ?? 60, w0 + (ev.clientX - x0) / k));
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

export function GridColGroup<T>({ grid, lead = [], trail = [], widthOf }: { grid: Grid<T>; lead?: number[]; trail?: number[]; widthOf?: (c: GridColumn<T>) => number }) {
  return (
    <colgroup>
      {lead.map((w, i) => <col key={`l${i}`} style={{ width: w }} />)}
      {grid.cols.map((c) => <col key={c.id} style={{ width: (widthOf ?? grid.width)(c) }} />)}
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
  footer, selection, thClass = DEFAULT_TH, tdClass = DEFAULT_TD, className, fill = false,
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
  // fill: a tabela ocupa o resto da altura da tela e só as linhas rolam (filtros, botões e títulos das colunas ficam parados).
  fill?: boolean;
}) {
  const rows = grid.sorted;
  const lead = selection ? [44] : [];
  const trail = actions ? [actionsWidth] : [];
  // Cabe na tela: as larguras viram proporções e a tabela ocupa exatamente a largura disponível
  // (só rola para o lado se nem com o mínimo de cada coluna couber).
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el); setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const fixed = lead.reduce((a, b) => a + b, 0) + trail.reduce((a, b) => a + b, 0);
  const natural = grid.cols.reduce((a, c) => a + grid.width(c), 0);
  const avail = Math.max(0, boxW - fixed - 2);
  const scale = boxW > 0 && natural > 0 ? avail / natural : 1;
  const minOf = (c: GridColumn<T>) => c.minWidth ?? Math.min(grid.width(c), c.align === 'right' ? 112 : 88);
  const widthOf = (c: GridColumn<T>) => Math.max(minOf(c), Math.floor(grid.width(c) * scale));
  const width = fixed + grid.cols.reduce((a, c) => a + widthOf(c), 0);
  const allOn = !!selection && rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)));
  const someOn = !!selection && rows.some((r) => selection.selected.has(rowKey(r)));
  const toggle = (id: string) => {
    if (!selection) return;
    const n = new Set(selection.selected);
    if (n.has(id)) n.delete(id); else n.add(id);
    selection.onChange(n);
  };
  return (
    <div ref={boxRef} className={cn('rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]',
      fill ? 'min-h-[260px] flex-1 overflow-auto overscroll-contain' : 'overflow-x-auto', className)}>
      <table className="text-sm" style={{ tableLayout: 'fixed', width, minWidth: '100%' }}>
        <GridColGroup grid={grid} lead={lead} trail={trail} widthOf={widthOf} />
        <thead className="sticky top-0 z-[2] bg-[var(--color-surface)] shadow-[0_1px_0_var(--color-border-card)]">
          <GridHead grid={grid} thClass={thClass} scale={scale}
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
                  <td key={c.id} className={cn(tdClass, 'overflow-hidden text-ellipsis whitespace-nowrap', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}>{c.render(r)}</td>
                ))}
                {actions && <td className={cn(tdClass, 'text-right')} onClick={(e) => e.stopPropagation()}>{actions(r)}</td>}
              </tr>
            );
          })}
        </tbody>
        {footer && rows.length > 0 && (
          <tfoot className="sticky bottom-0 z-[2] bg-[var(--color-surface)] shadow-[0_-1px_0_var(--color-border-card)]"><tr className="font-semibold">
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

// Botão "Colunas": liga/desliga colunas e volta ao padrão (ordem, largura e quais aparecem).
export function GridReset<T>({ grid }: { grid: Grid<T> }) {
  const [open, setOpen] = useState(false);
  const dragId = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setAlignLeft((ref.current?.getBoundingClientRect().left ?? 999) < 320); setOpen((o) => !o); }} aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
        <Columns3 className="h-4 w-4" /> Colunas{grid.hidden.length ? ` (${grid.allCols.length - grid.hidden.length}/${grid.allCols.length})` : ''}
      </button>
      {open && (
        <div className={cn('absolute z-[var(--z-popover,60)] mt-1 w-72 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1.5 shadow-[var(--shadow-lg)]', alignLeft ? 'left-0' : 'right-0')}>
          <div className="max-h-80 overflow-y-auto">
            {grid.allCols.map((c, i) => {
              const s = grid.sort?.id === c.id ? grid.sort.dir : null;
              return (
                <div key={c.id} draggable
                  onDragStart={(e) => { dragId.current = c.id; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); setOver(c.id); }}
                  onDrop={(e) => { e.preventDefault(); if (dragId.current) grid.move(dragId.current, c.id); dragId.current = null; setOver(null); }}
                  onDragEnd={() => { dragId.current = null; setOver(null); }}
                  className={cn('group flex items-center gap-1.5 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-surface-hover)]', over === c.id && 'bg-[var(--color-accent-subtle)]')}>
                  <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-[var(--color-text-muted)]" aria-hidden />
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={!grid.hidden.includes(c.id)} onChange={() => grid.toggleHidden(c.id)} className="h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                    <span className="truncate">{c.label}</span>
                  </label>
                  {c.sortValue && (
                    <button type="button" onClick={() => grid.toggleSort(c.id)} title="Ordenar por esta coluna (A→Z, Z→A)" aria-label={`Ordenar por ${c.label}`}
                      className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded', s ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100')}>
                      {s === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : s === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <button type="button" disabled={i === 0} onClick={() => grid.step(c.id, -1)} aria-label={`Subir ${c.label}`} title="Mover para a esquerda"
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-20"><ChevronUp className="h-3.5 w-3.5" /></button>
                  <button type="button" disabled={i === grid.allCols.length - 1} onClick={() => grid.step(c.id, 1)} aria-label={`Descer ${c.label}`} title="Mover para a direita"
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-20"><ChevronDown className="h-3.5 w-3.5" /></button>
                </div>
              );
            })}
          </div>
          <div className="mt-1 border-t border-[var(--color-border-soft)] pt-1">
            <button type="button" disabled={!grid.customized} onClick={() => { grid.reset(); setOpen(false); }} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">Voltar ao padrão</button>
          </div>
          <p className="px-2 pb-1 pt-1 text-[11px] text-[var(--color-text-muted)]">Arraste aqui ou no título da tabela para mudar a ordem; ↑↓ move uma posição; a seta ordena A→Z. Puxe a borda do título para a largura.</p>
        </div>
      )}
    </div>
  );
}

// Linhas para exportar (Excel/PDF) na ordem de colunas que a pessoa arrumou.
export function gridExportRows<T>(grid: Grid<T>): { header: string[]; rows: Array<Array<string | number | null>> } {
  return {
    header: grid.cols.map((c) => c.label),
    rows: grid.sorted.map((r) => grid.cols.map((c) => (c.exportValue ? c.exportValue(r) : c.sortValue ? c.sortValue(r) : ''))),
  };
}
