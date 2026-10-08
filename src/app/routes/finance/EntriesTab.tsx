import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Eye, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatBRL } from '@/lib/money';
import { fmtDate, friendlyError, monthEnd, monthStart, rpc, todaySP, type EntryKind, type InstStatus, type InstallmentRow, type Lookups } from './data';
import { EntryFormDialog } from './EntryFormDialog';
import { EntryDetailDialog } from './EntryDetailDialog';
import { SettleDialog } from './SettleDialog';
import { CompanySelect, EmptyRow, inputCls, StatusBadge, SummaryCard, TableWrap, tdCls, thCls } from './ui';

type StatusFilter = '' | InstStatus;

// Lista de contas a pagar OU a receber (uma linha por parcela).
export function EntriesTab({ kind, lookups }: { kind: EntryKind; lookups: Lookups }) {
  const perms = usePermission();
  const today = todaySP();
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(monthEnd(today));
  const [party, setParty] = useState('');
  const [chart, setChart] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<InstallmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ open_cents: number; overdue_cents: number; paid_cents: number; open_count: number; overdue_count: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [settling, setSettling] = useState<InstallmentRow | null>(null);

  const load = useCallback(async () => {
    let query = getSupabase().from('fin_installments_v').select('*').eq('kind', kind).order('due_date').order('description').limit(1000);
    if (company) query = query.eq('company_id', company);
    if (party) query = query.eq('party_id', party);
    if (chart) query = query.eq('chart_account_id', chart);
    if (status) query = query.eq('status', status);
    // Vencidos aparecem mesmo de meses anteriores quando o filtro é "vencido".
    if (from && status !== 'overdue') query = query.gte('due_date', from);
    if (to) query = query.lte('due_date', to);
    const [{ data, error: err }, sum] = await Promise.all([
      query,
      rpc<{ open_cents: number; overdue_cents: number; paid_cents: number; open_count: number; overdue_count: number }>(
        'fin_entries_summary', { p_kind: kind, p_company: company || null, p_from: from || null, p_to: to || null },
      ).catch(() => null),
    ]);
    setError(err ? friendlyError(err) : null);
    setRows((data ?? []) as InstallmentRow[]);
    setSummary(sum);
  }, [kind, company, party, chart, status, from, to]);

  useEffect(() => { void load(); }, [load]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows ?? [];
    return (rows ?? []).filter((r) => `${r.description} ${r.party_name ?? ''} ${r.chart_name}`.toLowerCase().includes(t));
  }, [rows, q]);

  const totals = useMemo(() => list.reduce((acc, r) => ({ amount: acc.amount + r.amount_cents, remaining: acc.remaining + r.remaining_cents }), { amount: 0, remaining: 0 }), [list]);
  const partyOptions = lookups.parties.filter((p) => p.kind === 'both' || p.kind === (kind === 'payable' ? 'supplier' : 'customer'));
  const chartOptions = lookups.chart.filter((c) => !c.is_synthetic && (kind === 'payable' ? c.type === 'expense' || c.nature === 'deduction' : c.type === 'revenue'));
  const pay = kind === 'payable';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label={`A ${pay ? 'pagar' : 'receber'} no período (aberto)`} cents={summary?.open_cents ?? 0} count={summary?.open_count}
          active={status === 'open'} onClick={() => setStatus(status === 'open' ? '' : 'open')} />
        <SummaryCard label="Vencido" tone="error" cents={summary?.overdue_cents ?? 0} count={summary?.overdue_count}
          active={status === 'overdue'} onClick={() => setStatus(status === 'overdue' ? '' : 'overdue')} />
        <SummaryCard label={pay ? 'Pago no período' : 'Recebido no período'} tone="success" cents={summary?.paid_cents ?? 0}
          active={status === 'paid'} onClick={() => setStatus(status === 'paid' ? '' : 'paid')} />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-48"><CompanySelect companies={lookups.companies} value={company} onChange={setCompany} /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={cn(inputCls, 'w-36')} aria-label="Status">
          <option value="">Todos os status</option><option value="open">Aberto</option><option value="overdue">Vencido</option>
          <option value="partial">Parcial</option><option value="paid">Pago</option><option value="canceled">Cancelado</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">Venc. de
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, 'w-36')} /></label>
        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">até
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(inputCls, 'w-36')} /></label>
        <select value={party} onChange={(e) => setParty(e.target.value)} className={cn(inputCls, 'w-44')} aria-label={pay ? 'Fornecedor' : 'Cliente'}>
          <option value="">{pay ? 'Todos os fornecedores' : 'Todos os clientes'}</option>
          {partyOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={chart} onChange={(e) => setChart(e.target.value)} className={cn(inputCls, 'w-44')} aria-label="Conta">
          <option value="">Todas as contas</option>
          {chartOptions.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
        </select>
        <label className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar descrição" className={cn(inputCls, 'pl-9')} />
        </label>
        {perms.can('financial.ledger_create') && (
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {pay ? 'Nova conta a pagar' : 'Nova conta a receber'}</Button>
        )}
      </div>

      {error && <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{error}</div>}

      {rows === null ? (
        <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : (
        <TableWrap minWidth={1080}>
          <thead><tr className="border-b border-[var(--color-border-card)]">
            <th className={thCls}>Vencimento</th><th className={thCls}>Descrição</th><th className={thCls}>{pay ? 'Fornecedor' : 'Cliente'}</th>
            <th className={thCls}>Empresa</th><th className={thCls}>Conta</th><th className={cn(thCls, 'text-right')}>Valor</th>
            <th className={cn(thCls, 'text-right')}>Falta</th><th className={thCls}>Status</th><th className={cn(thCls, 'text-right')}>Ações</th>
          </tr></thead>
          <tbody>
            {list.length === 0 && <EmptyRow cols={9} />}
            {list.map((r) => (
              <tr key={r.id} className={cn('border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]', r.status === 'canceled' && 'opacity-60')}>
                <td className={cn(tdCls, 'whitespace-nowrap', r.status === 'overdue' && 'font-semibold text-[var(--color-error)]')}>{fmtDate(r.due_date)}</td>
                <td className={tdCls}>
                  <button type="button" onClick={() => setDetail(r.entry_id)} className="text-left font-medium text-[var(--color-text-primary)] hover:underline">
                    {r.description}
                  </button>
                  {r.installments_count > 1 && <span className="ml-1 text-xs text-[var(--color-text-muted)]">{r.number}/{r.installments_count}</span>}
                </td>
                <td className={cn(tdCls, 'text-[var(--color-text-secondary)]')}>{r.party_name ?? '—'}</td>
                <td className={cn(tdCls, 'text-[var(--color-text-secondary)]')}>{r.company_name}</td>
                <td className={cn(tdCls, 'text-xs text-[var(--color-text-secondary)]')}>{r.chart_code} {r.chart_name}</td>
                <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(r.amount_cents)}</td>
                <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(r.remaining_cents)}</td>
                <td className={tdCls}><StatusBadge status={r.status} partial={r.is_partial} /></td>
                <td className={cn(tdCls, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    {r.remaining_cents > 0 && r.status !== 'canceled' && perms.can('financial.ledger_settle') && (
                      <Button size="sm" onClick={() => setSettling(r)}><CheckCircle2 className="h-3.5 w-3.5" /> {pay ? 'Pagar' : 'Receber'}</Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setDetail(r.entry_id)} aria-label="Ver lançamento"><Eye className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {list.length > 0 && (
            <tfoot><tr className="border-t border-[var(--color-border-card)] font-semibold">
              <td className={tdCls} colSpan={5}>{list.length} parcela{list.length === 1 ? '' : 's'}</td>
              <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(totals.amount)}</td>
              <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(totals.remaining)}</td>
              <td colSpan={2} />
            </tr></tfoot>
          )}
        </TableWrap>
      )}

      {creating && <EntryFormDialog kind={kind} lookups={lookups} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); void load(); setDetail(id); }} />}
      {detail && <EntryDetailDialog entryId={detail} lookups={lookups} onClose={() => setDetail(null)} onChanged={() => { void load(); void lookups.reload(); }} />}
      {settling && <SettleDialog row={settling} lookups={lookups} onClose={() => setSettling(null)} onDone={() => { setSettling(null); void load(); void lookups.reload(); }} />}
    </div>
  );
}
