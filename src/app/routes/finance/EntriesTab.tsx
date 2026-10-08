import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, ChevronDown, Download, Eye, FileSpreadsheet, FileText, ListChecks, Pencil, Plus, RotateCcw, Search, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatBRL } from '@/lib/money';
import { fmtDate, friendlyError, monthEnd, monthStart, rpc, STATUS_LABEL, todaySP, type Entry, type EntryKind, type InstStatus, type InstallmentRow, type Lookups } from './data';
import { EntryFormDialog } from './EntryFormDialog';
import { EntryDetailDialog } from './EntryDetailDialog';
import { SettleDialog } from './SettleDialog';
import { CompanySelect, inputCls, ReasonDialog, StatusBadge, SummaryCard, tdCls, thCls } from './ui';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/app/routes/settings/sections/access/ui';
import { GridColGroup, GridHead, useGrid, type GridColumn } from '@/components/ui/GridTable';
import { exportExcel, exportPdf } from '@/lib/table-export';

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
    else query = query.neq('status', 'canceled'); // cancelados (= excluídos) só com o filtro "Cancelado"
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

  const pay = kind === 'payable';
  const partyOptions = lookups.parties.filter((p) => p.kind === 'both' || p.kind === (kind === 'payable' ? 'supplier' : 'customer'));
  const chartOptions = lookups.chart.filter((c) => !c.is_synthetic && (kind === 'payable' ? c.type === 'expense' || c.nature === 'deduction' : c.type === 'revenue'));

  const columns = useMemo<GridColumn<InstallmentRow>[]>(() => [
    { id: 'due', label: 'Vencimento', width: 110, sortValue: (r) => r.due_date, exportValue: (r) => fmtDate(r.due_date),
      render: (r) => <span className={cn('whitespace-nowrap', r.status === 'overdue' && 'font-semibold text-[var(--color-error)]')}>{fmtDate(r.due_date)}</span> },
    { id: 'desc', label: 'Descrição', width: 250, minWidth: 140, sortValue: (r) => r.description,
      render: (r) => <button type="button" onClick={() => setDetail(r.entry_id)} className="block w-full truncate text-left font-medium text-[var(--color-text-primary)] hover:underline" title={r.description}>{r.description}</button> },
    { id: 'party', label: pay ? 'Fornecedor' : 'Cliente', width: 180, sortValue: (r) => r.party_name ?? '',
      render: (r) => <span className="block truncate text-[var(--color-text-secondary)]" title={r.party_name ?? ''}>{r.party_name ?? '—'}</span> },
    { id: 'inst', label: 'Parcela', width: 92, align: 'center', sortValue: (r) => r.number, exportValue: (r) => `${r.number}/${r.installments_count}`,
      render: (r) => <span className="tabular-nums text-[var(--color-text-secondary)]">{r.number}/{r.installments_count}</span> },
    { id: 'company', label: 'Empresa', width: 120, sortValue: (r) => r.company_name,
      render: (r) => <span className="block truncate text-[var(--color-text-secondary)]">{r.company_name}</span> },
    { id: 'chart', label: 'Conta', width: 170, sortValue: (r) => r.chart_code, exportValue: (r) => `${r.chart_code} ${r.chart_name}`,
      render: (r) => <span className="block truncate text-xs text-[var(--color-text-secondary)]" title={`${r.chart_code} ${r.chart_name}`}>{r.chart_code} {r.chart_name}</span> },
    { id: 'amount', label: 'Valor', width: 115, align: 'right', sortValue: (r) => r.amount_cents, exportValue: (r) => r.amount_cents / 100,
      render: (r) => <span className="tabular-nums">{formatBRL(r.amount_cents)}</span> },
    { id: 'remaining', label: 'Falta', width: 115, align: 'right', sortValue: (r) => r.remaining_cents, exportValue: (r) => r.remaining_cents / 100,
      render: (r) => <span className="font-semibold tabular-nums">{formatBRL(r.remaining_cents)}</span> },
    { id: 'paid_at', label: pay ? 'Pago em' : 'Recebido em', width: 110, sortValue: (r) => r.last_settle_date ?? '', exportValue: (r) => (r.last_settle_date ? fmtDate(r.last_settle_date) : ''),
      render: (r) => <span className="whitespace-nowrap text-[var(--color-text-secondary)]">{r.last_settle_date ? fmtDate(r.last_settle_date) : '—'}</span> },
    { id: 'status', label: 'Status', width: 110, sortValue: (r) => STATUS_LABEL[r.status] ?? r.status, exportValue: (r) => STATUS_LABEL[r.status] ?? r.status,
      render: (r) => <StatusBadge status={r.status} partial={r.is_partial} /> },
    { id: 'cc', label: 'Centro de custo', width: 130, sortValue: (r) => r.cost_center_name ?? '',
      render: (r) => <span className="block truncate text-xs text-[var(--color-text-secondary)]">{r.cost_center_name ?? '—'}</span> },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [pay]);
  const grid = useGrid(`megacrm_fin_grid_${kind}`, columns, list);
  const rowsView = grid.sorted;
  const totals = useMemo(() => list.reduce((acc, r) => ({ amount: acc.amount + r.amount_cents, remaining: acc.remaining + r.remaining_cents }), { amount: 0, remaining: 0 }), [list]);

  // Seleção (só das linhas visíveis).
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { setSel((cur) => new Set([...cur].filter((id) => list.some((r) => r.id === id)))); }, [list]);
  const chosen = rowsView.filter((r) => sel.has(r.id));
  const allOn = rowsView.length > 0 && chosen.length === rowsView.length;
  const toggle = (id: string) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const [bulk, setBulk] = useState<null | 'settle' | 'cancel' | 'delete' | 'reverse'>(null);
  const [editing, setEditing] = useState<{ entry: Entry; hasSettlement: boolean } | null>(null);
  const [menu, setMenu] = useState<null | 'actions' | 'export'>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const need = (min: number, what: string) => {
    if (chosen.length < min) { toast.info(`Marque ${min === 1 ? 'pelo menos uma parcela' : `${min} parcelas`} para ${what}.`); return false; }
    return true;
  };
  const openEdit = async () => {
    const ids = [...new Set(chosen.map((r) => r.entry_id))];
    if (ids.length !== 1) { toast.info('Para editar, marque parcelas de um lançamento só.'); return; }
    const sb = getSupabase();
    const [{ data: e, error: err }, { count }] = await Promise.all([
      sb.from('fin_entries').select('*').eq('id', ids[0]).maybeSingle(),
      sb.from('fin_settlements').select('id', { count: 'exact', head: true }).eq('entry_id', ids[0]),
    ]);
    if (err || !e) { toast.error('Não foi possível abrir o lançamento', { description: err ? friendlyError(err) : undefined }); return; }
    if ((e as Entry).status === 'canceled') { toast.info('Lançamento cancelado não se edita.'); return; }
    setEditing({ entry: e as Entry, hasSettlement: (count ?? 0) > 0 });
  };

  // Executa uma ação item a item e resume o resultado.
  const runEach = async <X,>(items: X[], fn: (x: X) => Promise<unknown>, okMsg: (n: number) => string) => {
    let ok = 0; const errs: string[] = [];
    for (const x of items) {
      try { await fn(x); ok++; } catch (e) { errs.push(e instanceof Error ? e.message : String(e)); }
    }
    if (ok) toast.success(okMsg(ok));
    if (errs.length) toast.error(`${errs.length} não foram feitos`, { description: [...new Set(errs)].slice(0, 3).join(' · ') });
    setSel(new Set()); void load(); void lookups.reload();
  };
  const cancelEntries = (reason: string) => runEach([...new Set(chosen.map((r) => r.entry_id))],
    (id) => rpc('fin_cancel_entry', { p_id: id, p_reason: reason }), (n) => `${n} lançamento(s) cancelado(s).`);
  const reverseSelected = async (reason: string) => {
    const { data, error: err } = await getSupabase().from('fin_settlements').select('id')
      .in('installment_id', chosen.map((r) => r.id)).is('reversal_of', null).is('reversed_at', null);
    if (err) { toast.error(friendlyError(err)); return; }
    if (!data?.length) { toast.info('As parcelas marcadas não têm baixa para estornar.'); return; }
    await runEach(data as Array<{ id: string }>, (s) => rpc('fin_reverse_settlement', { p_id: s.id, p_reason: reason }), (n) => `${n} baixa(s) estornada(s).`);
  };

  const exportRows = () => {
    const header = grid.cols.map((c) => c.label);
    const rows = rowsView.map((r) => grid.cols.map((c) => (c.exportValue ? c.exportValue(r) : c.sortValue ? c.sortValue(r) : '')));
    return { header, rows };
  };
  const periodTxt = `Vencimento de ${from ? fmtDate(from) : '—'} até ${to ? fmtDate(to) : '—'} · ${rowsView.length} parcela(s)`;
  const title = pay ? 'Contas a pagar' : 'Contas a receber';
  const doExcel = async () => {
    setMenu(null);
    const { header, rows } = exportRows();
    try { await exportExcel(`${pay ? 'contas-a-pagar' : 'contas-a-receber'}-${today}`, title, header, rows); }
    catch (e) { toast.error('Não foi possível gerar o Excel', { description: e instanceof Error ? e.message : String(e) }); }
  };
  const doPdf = () => {
    setMenu(null);
    const { header } = exportRows();
    const rows = rowsView.map((r) => grid.cols.map((c) => (c.id === 'amount' ? formatBRL(r.amount_cents) : c.id === 'remaining' ? formatBRL(r.remaining_cents)
      : c.exportValue ? c.exportValue(r) : c.sortValue ? c.sortValue(r) : '')));
    const right = grid.cols.map((c, i) => (c.align === 'right' ? i : -1)).filter((i) => i >= 0);
    const footer = grid.cols.map((c, i) => (c.id === 'amount' ? formatBRL(totals.amount) : c.id === 'remaining' ? formatBRL(totals.remaining) : i === 0 ? 'Total' : ''));
    exportPdf(title, periodTxt, header, rows, { rightCols: right, footer });
  };

  const barBtn = 'flex h-10 items-center gap-1.5 px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50';
  const menuItem = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40';

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
      </div>

      <div ref={menuRef} className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-visible rounded-[var(--radius-control)] shadow-sm">
          <div className="relative">
            <button type="button" onClick={() => setMenu(menu === 'actions' ? null : 'actions')} aria-expanded={menu === 'actions'}
              className={cn(barBtn, 'rounded-l-[var(--radius-control)] bg-[#1E2A5A]')}>
              <ListChecks className="h-4 w-4" /> Ações{chosen.length ? ` (${chosen.length})` : ''} <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {menu === 'actions' && (
              <div className="absolute left-0 z-[var(--z-popover,60)] mt-1 w-60 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1 shadow-[var(--shadow-lg)]">
                <button type="button" className={menuItem} disabled={!perms.can('financial.ledger_settle')}
                  onClick={() => { setMenu(null); if (need(1, pay ? 'pagar' : 'receber')) setBulk('settle'); }}>
                  <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" /> {pay ? 'Marcar como pago' : 'Marcar como recebido'}
                </button>
                <button type="button" className={menuItem} disabled={!perms.can('financial.ledger_reverse')}
                  onClick={() => { setMenu(null); if (need(1, 'estornar')) setBulk('reverse'); }}>
                  <Undo2 className="h-4 w-4 text-[var(--color-warning,#d97706)]" /> Estornar pagamento
                </button>
                <button type="button" className={menuItem} disabled={!perms.can('financial.ledger_reverse')}
                  onClick={() => { setMenu(null); if (need(1, 'cancelar')) setBulk('cancel'); }}>
                  <Ban className="h-4 w-4 text-[var(--color-error)]" /> Cancelar lançamento
                </button>
                <div className="my-1 border-t border-[var(--color-border-soft)]" />
                <button type="button" className={menuItem} onClick={() => { setSel(new Set(rowsView.map((r) => r.id))); setMenu(null); }}>Marcar todas da lista</button>
                <button type="button" className={menuItem} disabled={!chosen.length} onClick={() => { setSel(new Set()); setMenu(null); }}>Desmarcar</button>
              </div>
            )}
          </div>
          {perms.can('financial.ledger_create') && (
            <button type="button" onClick={() => setCreating(true)} className={cn(barBtn, 'bg-[#14B8A6]')}><Plus className="h-4 w-4" /> Novo</button>
          )}
          {perms.can('financial.ledger_edit') && (
            <button type="button" onClick={() => { if (need(1, 'editar')) void openEdit(); }} className={cn(barBtn, 'bg-[#F59E0B]')}><Pencil className="h-4 w-4" /> Editar</button>
          )}
          {perms.can('financial.ledger_reverse') && (
            <button type="button" onClick={() => { if (need(1, 'excluir')) setBulk('delete'); }} className={cn(barBtn, 'rounded-r-[var(--radius-control)] bg-[#E11D48]')}><Trash2 className="h-4 w-4" /> Excluir</button>
          )}
        </div>
        <div className="relative ml-auto flex items-center gap-2">
          {grid.customized && (
            <Button variant="ghost" size="sm" onClick={grid.reset} title="Volta a ordem e a largura original das colunas"><RotateCcw className="h-3.5 w-3.5" /> Colunas padrão</Button>
          )}
          <Button variant="outline" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'} disabled={!rowsView.length}>
            <Download className="h-4 w-4" /> Exportar <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          {menu === 'export' && (
            <div className="absolute right-0 top-full z-[var(--z-popover,60)] mt-1 w-48 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1 shadow-[var(--shadow-lg)]">
              <button type="button" className={menuItem} onClick={() => void doExcel()}><FileSpreadsheet className="h-4 w-4 text-[#16a34a]" /> Excel (.xlsx)</button>
              <button type="button" className={menuItem} onClick={doPdf}><FileText className="h-4 w-4 text-[#dc2626]" /> PDF</button>
            </div>
          )}
        </div>
      </div>
      <p className="-mt-2 text-[11px] text-[var(--color-text-muted)]">Dica: arraste o título da coluna para mudar a posição, puxe a borda para mudar a largura e clique para ordenar (A→Z, Z→A).</p>

      {error && <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{error}</div>}

      {rows === null ? (
        <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
          <table className="text-sm" style={{ tableLayout: 'fixed', width: 44 + grid.cols.reduce((a, c) => a + grid.width(c), 0) + 130, minWidth: '100%' }}>
            <GridColGroup grid={grid} lead={[44]} trail={[130]} />
            <thead>
              <GridHead grid={grid} thClass={thCls}
                lead={<th className={cn(thCls, 'w-11')}><input type="checkbox" aria-label="Marcar todas" checked={allOn}
                  ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allOn; }}
                  onChange={() => setSel(allOn ? new Set() : new Set(rowsView.map((r) => r.id)))} className="h-4 w-4 accent-[var(--accent-fill)]" /></th>}
                trail={<th className={cn(thCls, 'text-right')}>Ações</th>} />
            </thead>
            <tbody>
              {rowsView.length === 0 && <tr><td colSpan={grid.cols.length + 2} className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">Nada encontrado com esses filtros.</td></tr>}
              {rowsView.map((r) => (
                <tr key={r.id} className={cn('border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]',
                  r.status === 'canceled' && 'opacity-60', sel.has(r.id) && 'bg-[var(--color-accent-subtle)]')}>
                  <td className={tdCls}><input type="checkbox" aria-label={`Marcar ${r.description}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-[var(--accent-fill)]" /></td>
                  {grid.cols.map((c) => (
                    <td key={c.id} className={cn(tdCls, 'overflow-hidden', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>{c.render(r)}</td>
                  ))}
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
            {rowsView.length > 0 && (
              <tfoot><tr className="border-t border-[var(--color-border-card)] font-semibold">
                <td className={tdCls}>{chosen.length ? <span className="text-xs text-[var(--accent-primary)]">{chosen.length}</span> : null}</td>
                {grid.cols.map((c, i) => (
                  <td key={c.id} className={cn(tdCls, 'whitespace-nowrap', c.align === 'right' && 'text-right tabular-nums')}>
                    {c.id === 'amount' ? formatBRL(totals.amount) : c.id === 'remaining' ? formatBRL(totals.remaining)
                      : i === 0 ? `${rowsView.length} parcela${rowsView.length === 1 ? '' : 's'}` : null}
                  </td>
                ))}
                <td />
              </tr></tfoot>
            )}
          </table>
        </div>
      )}

      {creating && <EntryFormDialog kind={kind} lookups={lookups} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); void load(); setDetail(id); }} />}
      {detail && <EntryDetailDialog entryId={detail} lookups={lookups} onClose={() => setDetail(null)} onChanged={() => { void load(); void lookups.reload(); }} />}
      {editing && <EntryFormDialog kind={kind} lookups={lookups} entry={editing.entry} hasSettlement={editing.hasSettlement}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setSel(new Set()); void load(); }} />}
      {bulk === 'settle' && <BulkSettleDialog rows={chosen} lookups={lookups} pay={pay} onClose={() => setBulk(null)}
        onDone={() => { setBulk(null); setSel(new Set()); void load(); void lookups.reload(); }} />}
      {(bulk === 'cancel' || bulk === 'delete') && (
        <ReasonDialog title={bulk === 'delete' ? 'Excluir lançamentos' : 'Cancelar lançamentos'} danger confirmLabel={bulk === 'delete' ? 'Excluir' : 'Cancelar lançamentos'}
          description={`${new Set(chosen.map((r) => r.entry_id)).size} lançamento(s) — com todas as parcelas. Por segurança o sistema não apaga de vez: fica cancelado no histórico (auditoria) e some desta lista (veja em Status → Cancelado). Lançamento com baixa precisa do estorno antes.`}
          onClose={() => setBulk(null)} onConfirm={async (reason) => { await cancelEntries(reason); setBulk(null); }} />
      )}
      {bulk === 'reverse' && (
        <ReasonDialog title="Estornar pagamento" danger confirmLabel="Estornar"
          description={`Desfaz as baixas das ${chosen.length} parcela(s) marcadas. O saldo do banco volta e a parcela fica em aberto de novo.`}
          onClose={() => setBulk(null)} onConfirm={async (reason) => { await reverseSelected(reason); setBulk(null); }} />
      )}
      {settling && <SettleDialog row={settling} lookups={lookups} onClose={() => setSettling(null)} onDone={() => { setSettling(null); void load(); void lookups.reload(); }} />}
    </div>
  );
}

// Baixa em lote: valor que falta de cada parcela, uma conta bancária por empresa, mesma data.
function BulkSettleDialog({ rows, lookups, pay, onClose, onDone }: { rows: InstallmentRow[]; lookups: Lookups; pay: boolean; onClose: () => void; onDone: () => void }) {
  const open = rows.filter((r) => r.remaining_cents > 0 && r.status !== 'canceled');
  const companies = [...new Set(open.map((r) => r.company_id))];
  const [date, setDate] = useState(todaySP());
  const [acc, setAcc] = useState<Record<string, string>>(() => Object.fromEntries(companies.map((c) => [c, lookups.accounts.find((a) => a.company_id === c && a.is_active)?.id ?? ''])));
  const [busy, setBusy] = useState(false);
  const total = open.reduce((a, r) => a + r.remaining_cents, 0);
  const go = async () => {
    if (companies.some((c) => !acc[c])) { toast.error('Escolha a conta bancária de cada empresa.'); return; }
    setBusy(true);
    let ok = 0; const errs: string[] = [];
    for (const r of open) {
      try { await rpc('fin_settle', { p: { installment_id: r.id, account_id: acc[r.company_id], settle_date: date, amount_cents: r.remaining_cents } }); ok++; }
      catch (e) { errs.push(`${r.description}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBusy(false);
    if (ok) toast.success(`${ok} parcela(s) ${pay ? 'paga(s)' : 'recebida(s)'}.`);
    if (errs.length) toast.error(`${errs.length} não foram baixadas`, { description: errs.slice(0, 3).join(' · ') });
    onDone();
  };
  return (
    <Dialog open onClose={onClose} title={pay ? 'Marcar como pago' : 'Marcar como recebido'} widthClass="max-w-lg" opaque
      description={`${open.length} parcela(s) · ${formatBRL(total)} (o valor que falta de cada uma).${rows.length > open.length ? ` ${rows.length - open.length} marcada(s) já quitada(s) ou cancelada(s) ficam de fora.` : ''}`}>
      {open.length === 0 ? <p className="text-sm text-[var(--color-text-secondary)]">Nenhuma parcela marcada está em aberto.</p> : (
        <div className="space-y-3">
          <Field label={pay ? 'Data do pagamento' : 'Data do recebimento'} required htmlFor="bs-date">
            <input id="bs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
          {companies.map((c) => (
            <Field key={c} label={`Conta bancária — ${open.find((r) => r.company_id === c)?.company_name ?? ''}`} required htmlFor={`bs-acc-${c}`}>
              <select id={`bs-acc-${c}`} value={acc[c] ?? ''} onChange={(e) => setAcc({ ...acc, [c]: e.target.value })} className={inputCls}>
                <option value="">Escolha…</option>
                {lookups.accounts.filter((a) => a.company_id === c && a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          ))}
          <p className="text-xs text-[var(--color-text-muted)]">Juros, multa, desconto ou pagamento parcial: use o botão {pay ? '"Pagar"' : '"Receber"'} da linha.</p>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void go()} disabled={busy || open.length === 0}>{busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />} Confirmar</Button>
      </div>
    </Dialog>
  );
}
