import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { rpc, type Tone } from './data';

export { Field, inputCls, thCls, tdCls, MoneyInput, TableWrap, EmptyRow, ReasonDialog, SubTabs, CompanySelect } from '../finance/ui';

const TONE: Record<Tone, string> = {
  muted: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]',
  accent: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]',
  warn: 'bg-[rgba(245,158,11,0.14)] text-[var(--inbox-warn-text,#B45309)]',
  error: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]',
  success: 'bg-[rgba(34,197,94,0.14)] text-[var(--color-success)]',
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE[tone])}>{children}</span>;
}

export function StatusPill<S extends string>({ map, status }: { map: Record<S, [string, Tone]>; status: S }) {
  const [label, tone] = map[status] ?? [status, 'muted' as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

export function QtyInput({ value, onChange, id, disabled, min = 0 }: { value: number; onChange: (n: number) => void; id?: string; disabled?: boolean; min?: number }) {
  const [text, setText] = useState(String(value).replace('.', ','));
  useEffect(() => { setText((t) => (Number(t.replace(',', '.')) === value ? t : String(value).replace('.', ','))); }, [value]);
  return (
    <input id={id} inputMode="decimal" disabled={disabled} value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9,.]/g, '');
        setText(t);
        const n = Number(t.replace(/\./g, '').replace(',', '.'));
        if (Number.isFinite(n) && n >= min) onChange(Math.round(n * 1000) / 1000);
      }}
      className="h-9 w-24 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-right text-sm tabular-nums" />
  );
}

export function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className="truncate text-sm text-[var(--color-text-primary)]">{children ?? '—'}</div>
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'error' | 'success' | 'warn' }) {
  const color = tone === 'error' ? 'var(--color-error)' : tone === 'success' ? 'var(--color-success)' : tone === 'warn' ? 'var(--inbox-warn-text,#B45309)' : 'var(--color-text-primary)';
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</div>
      <div className="truncate text-lg font-bold tabular-nums" style={{ color }}>{value}</div>
      {hint && <div className="truncate text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>;
}

// Rastro do documento: REQ → COT → PED → REC → NF.
type TraceDoc = { id: string; number: string | null; status: string };
interface TraceData { requisitions: TraceDoc[]; quotations: TraceDoc[]; orders: TraceDoc[]; receipts: TraceDoc[]; invoices: TraceDoc[] }

export function Trace({ kind, id, onOpen }: { kind: 'requisition' | 'quotation' | 'order' | 'receipt' | 'invoice'; id: string; onOpen?: (kind: string, id: string) => void }) {
  const [t, setT] = useState<TraceData | null>(null);
  useEffect(() => {
    let off = false;
    rpc<TraceData>('pur_trace', { p_kind: kind, p_id: id }).then((d) => { if (!off) setT(d); }).catch(() => { if (!off) setT(null); });
    return () => { off = true; };
  }, [kind, id]);
  if (!t) return null;
  const steps: [string, string, TraceDoc[]][] = [
    ['requisition', 'Requisição', t.requisitions], ['quotation', 'Cotação', t.quotations], ['order', 'Pedido', t.orders],
    ['receipt', 'Recebimento', t.receipts], ['invoice', 'Nota', t.invoices],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {steps.map(([k, label, docs], i) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          {i > 0 && <ArrowRight className="h-3 w-3 text-[var(--color-text-muted)]" />}
          <span className="font-semibold text-[var(--color-text-secondary)]">{label}:</span>
          {docs.length === 0 ? <span className="text-[var(--color-text-muted)]">—</span> : docs.map((d) => (
            <button key={d.id} type="button" disabled={!onOpen || (k === kind && d.id === id)} onClick={() => onOpen?.(k, d.id)}
              className={cn('rounded-full border px-2 py-0.5 font-medium', k === kind && d.id === id
                ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]'
                : 'border-[var(--color-border-card)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]')}>
              {d.number ?? 'rascunho'}
            </button>
          ))}
        </span>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// Documento aberto pela URL (?doc=) mesmo fora do filtro atual da lista.
export function useOpenDoc<T extends { id: string }>(view: string, openId: string | null, rows: T[] | null, select = '*'): T | null {
  const [extra, setExtra] = useState<T | null>(null);
  const inList = openId && rows ? rows.find((r) => r.id === openId) ?? null : null;
  useEffect(() => {
    if (!openId || !rows || inList) return;
    let off = false;
    void getSupabase().from(view).select(select).eq('id', openId).maybeSingle().then(({ data }) => { if (!off) setExtra((data as unknown as T) ?? null); });
    return () => { off = true; };
  }, [view, openId, rows, inList, select]);
  return inList ?? (extra && extra.id === openId ? extra : null);
}
