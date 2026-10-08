import { useMemo, useState, type ReactNode } from 'react';
import { SearchSelect, type SearchOption } from '@/components/ui/SearchSelect';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBRL, maskMoneyInput } from '@/lib/money';
import { Field, inputCls } from '@/app/routes/settings/sections/access/ui';
import { chartAllowed, chartTree, STATUS_LABEL, type ChartAccount, type Company, type EntryKind, type InstStatus } from './data';

export { Field, inputCls };

export const thCls = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] whitespace-nowrap';
export const tdCls = 'px-3 py-2 align-middle';

export function MoneyInput({ id, cents, onChange, disabled, autoFocus }: {
  id?: string; cents: number; onChange: (cents: number) => void; disabled?: boolean; autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-muted)]">R$</span>
      <input id={id} inputMode="numeric" autoFocus={autoFocus} disabled={disabled}
        value={cents ? formatBRL(cents).replace('R$ ', '') : ''}
        onChange={(e) => onChange(maskMoneyInput(e.target.value).cents)}
        placeholder="0,00" className={cn(inputCls, 'pl-9 text-right tabular-nums')} />
    </div>
  );
}

const STATUS_TONE: Record<InstStatus, string> = {
  open: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]',
  overdue: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]',
  partial: 'bg-[rgba(245,158,11,0.14)] text-[var(--inbox-warn-text,#B45309)]',
  paid: 'bg-[rgba(34,197,94,0.14)] text-[var(--color-success)]',
  canceled: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)] line-through',
};

export function StatusBadge({ status, partial }: { status: InstStatus; partial?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}{status === 'overdue' && partial ? ' · parcial' : ''}
    </span>
  );
}

export function SummaryCard({ label, cents, count, tone, active, onClick }: {
  label: string; cents: number; count?: number; tone?: 'error' | 'success' | 'accent'; active?: boolean; onClick?: () => void;
}) {
  const color = tone === 'error' ? 'var(--color-error)' : tone === 'success' ? 'var(--color-success)' : 'var(--accent-primary)';
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-card)] border bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]',
        active ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--color-border-card)]')}>
      <span className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</span>
      <span className="truncate text-lg font-bold tabular-nums" style={{ color }}>{formatBRL(cents)}</span>
      {count !== undefined && <span className="text-[11px] text-[var(--color-text-muted)]">{count} parcela{count === 1 ? '' : 's'}</span>}
    </button>
  );
}

export function CompanySelect({ companies, value, onChange, allLabel = 'Todas as empresas', id, onlyActive }: {
  companies: Company[]; value: string; onChange: (v: string) => void; allLabel?: string | null; id?: string; onlyActive?: boolean;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls} aria-label="Empresa">
      {allLabel !== null && <option value="">{allLabel}</option>}
      {companies.filter((c) => !onlyActive || c.is_active).map((c) => (
        <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' (padrão)' : ''}{c.is_active ? '' : ' — inativa'}</option>
      ))}
    </select>
  );
}

export function TableWrap({ children, minWidth = 900 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
      <table className="w-full text-sm" style={{ minWidth }}>{children}</table>
    </div>
  );
}

export function EmptyRow({ cols, text = 'Nada encontrado com esses filtros.' }: { cols: number; text?: string }) {
  return <tr><td colSpan={cols} className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">{text}</td></tr>;
}

// Janela que pede motivo (cancelar, estornar, reabrir).
export function ReasonDialog({ title, description, confirmLabel, danger, onClose, onConfirm, extra }: {
  title: string; description: string; confirmLabel: string; danger?: boolean;
  onClose: () => void; onConfirm: (reason: string) => Promise<void>; extra?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 5;
  return (
    <Dialog open onClose={onClose} title={title} description={description}>
      {extra}
      <Field label="Motivo" required htmlFor="rs-reason" hint="Fica registrado na auditoria. Mínimo de 5 letras.">
        <textarea id="rs-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value.slice(0, 300))} rows={3}
          className={cn(inputCls, 'h-auto py-2')} placeholder="Ex.: lançado em duplicidade" />
      </Field>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Voltar</Button>
        <Button disabled={!ok || busy} onClick={async () => { setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }}
          className={danger ? 'bg-[var(--color-error)] hover:bg-[var(--color-error)]/90' : undefined}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1">
      {tabs.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)}
          className={cn('rounded-[8px] px-3 py-1.5 text-xs font-semibold', value === k ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
          {l}
        </button>
      ))}
    </div>
  );
}

// Plano de contas com pesquisa (por código ou nome). Agrupadoras viram títulos.
// Só aparecem os grupos que têm conta permitida (conta a pagar: despesas e deduções; a receber: receitas).
export function ChartPicker({ id, chart, kind, value, onChange, emptyLabel, placeholder = 'Escolha a conta…', icon }: {
  id?: string; chart: ChartAccount[]; kind: EntryKind; value: string; onChange: (v: string) => void; emptyLabel?: string; placeholder?: string; icon?: ReactNode;
}) {
  const options = useMemo<SearchOption[]>(() => {
    const byId = new Map(chart.map((c) => [c.id, c]));
    const used = new Set<string>();
    for (const c of chart) {
      if (c.is_synthetic || !(chartAllowed(c, kind) || c.id === value)) continue;
      used.add(c.id);
      for (let p = c.parent_id ? byId.get(c.parent_id) : undefined; p && !used.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) used.add(p.id);
    }
    const out: SearchOption[] = [];
    for (const c of chartTree(chart)) {
      if (!used.has(c.id)) continue;
      out.push({ value: c.id, label: `${c.code} ${c.name}`, header: c.is_synthetic, depth: c.depth });
    }
    return out;
  }, [chart, kind, value]);
  return <SearchSelect id={id} value={value} onChange={onChange} options={options} placeholder={placeholder} emptyLabel={emptyLabel} icon={icon} searchPlaceholder="Pesquisar código ou nome da conta…" />;
}
