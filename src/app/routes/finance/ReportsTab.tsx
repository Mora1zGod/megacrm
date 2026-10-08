import { useEffect, useState, type ReactNode } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatBRL } from '@/lib/money';
import { addDays, fmtDate, monthEnd, monthStart, rpc, todaySP, type Lookups, type Nature } from './data';
import { CompanySelect, EmptyRow, inputCls, StatusBadge, SubTabs, TableWrap, tdCls, thCls } from './ui';

type Rep = 'agenda' | 'fluxo' | 'custos' | 'dre';

export function ReportsTab({ lookups }: { lookups: Lookups }) {
  const today = todaySP();
  const [rep, setRep] = useState<Rep>('agenda');
  const [company, setCompany] = useState('');
  const [from, setFrom] = useState(rep === 'agenda' ? today : monthStart(today));
  const [to, setTo] = useState(rep === 'agenda' ? addDays(today, 30) : monthEnd(today));

  const change = (r: Rep) => {
    setRep(r);
    if (r === 'agenda') { setFrom(today); setTo(addDays(today, 30)); }
    else if (r === 'fluxo') { setFrom(addDays(today, -15)); setTo(addDays(today, 45)); }
    else { setFrom(monthStart(today)); setTo(monthEnd(today)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <SubTabs<Rep> value={rep} onChange={change} tabs={[['agenda', 'Agenda de vencimentos'], ['fluxo', 'Fluxo de caixa'], ['custos', 'Custos'], ['dre', 'DRE']]} />
        <div className="w-52"><CompanySelect companies={lookups.companies} value={company} onChange={setCompany} /></div>
        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">de <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, 'w-36')} /></label>
        <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">até <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(inputCls, 'w-36')} /></label>
        <Button variant="outline" className="ml-auto" onClick={() => window.print()}><Printer className="h-4 w-4" /> Imprimir</Button>
      </div>
      <div className="hidden text-sm print:block">
        <b>{{ agenda: 'Agenda de vencimentos', fluxo: 'Fluxo de caixa', custos: 'Custos', dre: 'DRE' }[rep]}</b> · {fmtDate(from)} a {fmtDate(to)} ·{' '}
        {lookups.companies.find((c) => c.id === company)?.name ?? 'Todas as empresas'}
      </div>
      {from > to ? <p className="text-sm text-[var(--color-error)]">A data inicial precisa ser antes da final.</p>
        : rep === 'agenda' ? <Agenda company={company} from={from} to={to} />
        : rep === 'fluxo' ? <CashFlow company={company} from={from} to={to} />
        : rep === 'custos' ? <Costs company={company} from={from} to={to} />
        : <Dre company={company} from={from} to={to} />}
    </div>
  );
}

function useReport<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    setData(null);
    fn().then((d) => { if (!cancel) { setData(d); setError(null); } }).catch((e) => { if (!cancel) { setError(e instanceof Error ? e.message : String(e)); setData(null); } });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

function Wrap({ data, error, children }: { data: unknown; error: string | null; children: ReactNode }) {
  if (error) return <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{error}</div>;
  if (data === null) return <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>;
  return <>{children}</>;
}

interface AgendaRow { due_date: string; kind: 'payable' | 'receivable'; installment_id: string; description: string; party_name: string | null; company_name: string; number: number; installments_count: number; remaining_cents: number; status: 'open' | 'overdue' | 'partial' }

function Agenda({ company, from, to }: { company: string; from: string; to: string }) {
  const { data, error } = useReport(() => rpc<AgendaRow[]>('fin_report_agenda', { p_company: company || null, p_from: from, p_to: to }), [company, from, to]);
  const days = new Map<string, AgendaRow[]>();
  for (const r of data ?? []) days.set(r.due_date, [...(days.get(r.due_date) ?? []), r]);
  return (
    <Wrap data={data} error={error}>
      {days.size === 0 ? <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">Nada vencendo no período.</p> : (
        <div className="space-y-3">
          {[...days.entries()].map(([day, list]) => {
            const recv = list.filter((r) => r.kind === 'receivable').reduce((s, r) => s + r.remaining_cents, 0);
            const pay = list.filter((r) => r.kind === 'payable').reduce((s, r) => s + r.remaining_cents, 0);
            return (
              <div key={day} className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
                <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 text-sm">
                  <b>{fmtDate(day)}</b>
                  {day < todaySP() && <span className="text-xs font-semibold text-[var(--color-error)]">vencido</span>}
                  <span className="ml-auto text-xs text-[var(--color-text-secondary)]">A receber <b className="tabular-nums text-[var(--color-success)]">{formatBRL(recv)}</b> · A pagar <b className="tabular-nums text-[var(--color-error)]">{formatBRL(pay)}</b></span>
                </div>
                <table className="w-full text-sm"><tbody>
                  {list.map((r) => (
                    <tr key={r.installment_id} className="border-b border-[var(--color-border-soft)] last:border-0">
                      <td className={cn(tdCls, 'w-24 text-xs font-semibold', r.kind === 'payable' ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]')}>{r.kind === 'payable' ? 'Pagar' : 'Receber'}</td>
                      <td className={tdCls}>{r.description}{r.installments_count > 1 && <span className="ml-1 text-xs text-[var(--color-text-muted)]">{r.number}/{r.installments_count}</span>}</td>
                      <td className={cn(tdCls, 'text-[var(--color-text-secondary)]')}>{r.party_name ?? '—'}</td>
                      <td className={cn(tdCls, 'text-xs text-[var(--color-text-secondary)]')}>{r.company_name}</td>
                      <td className={tdCls}><StatusBadge status={r.status} /></td>
                      <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(r.remaining_cents)}</td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            );
          })}
        </div>
      )}
    </Wrap>
  );
}

interface FlowRow { date: string; realized_in: number; realized_out: number; realized_net: number; projected_in: number; projected_out: number }

function CashFlow({ company, from, to }: { company: string; from: string; to: string }) {
  const [group, setGroup] = useState<'day' | 'month'>('day');
  const { data, error } = useReport(() => rpc<{ opening_cents: number; today: string; rows: FlowRow[] }>('fin_report_cashflow', { p_company: company || null, p_from: from, p_to: to, p_group: group }), [company, from, to, group]);
  let bal = Number(data?.opening_cents ?? 0);
  const rows = (data?.rows ?? []).filter((r) => r.realized_in || r.realized_out || r.realized_net || r.projected_in || r.projected_out);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.realized_in + r.projected_in, r.realized_out + r.projected_out)));
  return (
    <Wrap data={data} error={error}>
      <div className="mb-2 flex items-center gap-3 text-sm">
        <SubTabs<'day' | 'month'> value={group} onChange={setGroup} tabs={[['day', 'Por dia'], ['month', 'Por mês']]} />
        <span className="text-[var(--color-text-secondary)]">Saldo inicial: <b className="tabular-nums text-[var(--color-text-primary)]">{formatBRL(data?.opening_cents ?? 0)}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">Realizado = baixas e transferências. Projetado = saldo das parcelas em aberto (vencidas contam a partir de hoje).</span>
      </div>
      <TableWrap minWidth={860}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>{group === 'day' ? 'Dia' : 'Mês'}</th>
          <th className={cn(thCls, 'text-right')}>Entradas realizadas</th><th className={cn(thCls, 'text-right')}>Saídas realizadas</th>
          <th className={cn(thCls, 'text-right')}>A receber</th><th className={cn(thCls, 'text-right')}>A pagar</th>
          <th className={cn(thCls, 'text-right')}>Saldo</th><th className={thCls} />
        </tr></thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={7} text="Sem movimento no período." />}
          {rows.map((r) => {
            bal += Number(r.realized_net) + Number(r.projected_in) - Number(r.projected_out);
            const inW = ((r.realized_in + r.projected_in) / max) * 100;
            const outW = ((r.realized_out + r.projected_out) / max) * 100;
            return (
              <tr key={r.date} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={tdCls}>{group === 'day' ? fmtDate(r.date) : fmtDate(r.date).slice(3)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums text-[var(--color-success)]')}>{formatBRL(r.realized_in)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums text-[var(--color-error)]')}>{formatBRL(r.realized_out)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums text-[var(--color-text-secondary)]')}>{formatBRL(r.projected_in)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums text-[var(--color-text-secondary)]')}>{formatBRL(r.projected_out)}</td>
                <td className={cn(tdCls, 'text-right font-semibold tabular-nums', bal < 0 && 'text-[var(--color-error)]')}>{formatBRL(bal)}</td>
                <td className={cn(tdCls, 'w-40')}>
                  <div className="h-1.5 rounded bg-[var(--color-success)]/70" style={{ width: `${inW}%` }} />
                  <div className="mt-0.5 h-1.5 rounded bg-[var(--color-error)]/70" style={{ width: `${outW}%` }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </Wrap>
  );
}

type CostGroup = 'cost_center' | 'account' | 'party' | 'company';

function Costs({ company, from, to }: { company: string; from: string; to: string }) {
  const [group, setGroup] = useState<CostGroup>('cost_center');
  const { data, error } = useReport(() => rpc<Array<{ group_key: string; group_label: string; total_cents: number; entries_count: number }>>('fin_report_costs', { p_company: company || null, p_from: from, p_to: to, p_group: group }), [company, from, to, group]);
  const total = (data ?? []).reduce((s, r) => s + Number(r.total_cents), 0);
  return (
    <Wrap data={data} error={error}>
      <div className="mb-2 flex items-center gap-3">
        <SubTabs<CostGroup> value={group} onChange={setGroup} tabs={[['cost_center', 'Por centro de custo'], ['account', 'Por conta'], ['party', 'Por fornecedor'], ['company', 'Por empresa']]} />
        <span className="text-xs text-[var(--color-text-muted)]">Contas a pagar ativas, pela competência.</span>
      </div>
      <TableWrap minWidth={600}>
        <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Grupo</th><th className={cn(thCls, 'text-right')}>Lançamentos</th><th className={cn(thCls, 'text-right')}>Total</th><th className={cn(thCls, 'text-right')}>%</th><th className={thCls} /></tr></thead>
        <tbody>
          {(data ?? []).length === 0 && <EmptyRow cols={5} text="Sem custos no período." />}
          {(data ?? []).map((r) => {
            const pct = total ? (Number(r.total_cents) * 1000) / total : 0;
            return (
              <tr key={r.group_key} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={cn(tdCls, r.group_key === '-' && 'italic text-[var(--color-text-secondary)]')}>{r.group_label}</td>
                <td className={cn(tdCls, 'text-right tabular-nums')}>{r.entries_count}</td>
                <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(r.total_cents)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums text-[var(--color-text-secondary)]')}>{(Math.round(pct) / 10).toFixed(1).replace('.', ',')}%</td>
                <td className={cn(tdCls, 'w-40')}><div className="h-2 rounded bg-[var(--color-accent-secondary)]" style={{ width: `${pct / 10}%` }} /></td>
              </tr>
            );
          })}
        </tbody>
        {total > 0 && <tfoot><tr className="border-t border-[var(--color-border-card)] font-semibold"><td className={tdCls}>Total</td><td /><td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(total)}</td><td colSpan={2} /></tr></tfoot>}
      </TableWrap>
    </Wrap>
  );
}

interface DreData {
  gross_revenue: number; deductions: number; net_revenue: number; costs: number; operating_expenses: number;
  financial_result: number; taxes: number; result: number; investments: number; settlement_adjustments: number;
  accounts: Array<{ nature: Nature; code: string; name: string; kind: string; total_cents: number }>;
}

function Dre({ company, from, to }: { company: string; from: string; to: string }) {
  const { data, error } = useReport(() => rpc<DreData>('fin_report_dre', { p_company: company || null, p_from: from, p_to: to }), [company, from, to]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = (nature: Nature) => (data?.accounts ?? []).filter((a) => a.nature === nature);
  const line = (label: string, cents: number, opts: { nature?: Nature; strong?: boolean; minus?: boolean } = {}) => (
    <>
      <tr className={cn('border-b border-[var(--color-border-soft)]', opts.strong && 'bg-[var(--color-fill-subtle)] font-bold')}>
        <td className={tdCls}>
          {opts.nature ? (
            <button type="button" onClick={() => setOpen(open === opts.nature ? null : opts.nature!)} className="hover:underline">{opts.minus ? '(−) ' : ''}{label}</button>
          ) : label}
        </td>
        <td className={cn(tdCls, 'text-right tabular-nums', cents < 0 && 'text-[var(--color-error)]')}>{formatBRL(opts.minus ? -cents : cents)}</td>
      </tr>
      {opts.nature && open === opts.nature && detail(opts.nature).map((a) => (
        <tr key={`${a.code}-${a.kind}`} className="border-b border-[var(--color-border-soft)] text-xs text-[var(--color-text-secondary)]">
          <td className={cn(tdCls, 'pl-8')}>{a.code} {a.name}</td><td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(a.total_cents)}</td>
        </tr>
      ))}
    </>
  );
  return (
    <Wrap data={data} error={error}>
      {data && (
        <div className="max-w-2xl">
          <TableWrap minWidth={480}>
            <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Demonstração do resultado (competência)</th><th className={cn(thCls, 'text-right')}>Valor</th></tr></thead>
            <tbody>
              {line('Receita bruta', data.gross_revenue, { nature: 'operating_revenue' })}
              {line('Deduções', data.deductions, { nature: 'deduction', minus: true })}
              {line('Receita líquida', data.net_revenue, { strong: true })}
              {line('Custos', data.costs, { nature: 'cost', minus: true })}
              {line('Despesas operacionais', data.operating_expenses, { nature: 'operating_expense', minus: true })}
              {line('Resultado financeiro', data.financial_result, { nature: 'financial' })}
              {line('Impostos', data.taxes, { nature: 'tax', minus: true })}
              {line('Resultado do período', data.result, { strong: true })}
            </tbody>
          </TableWrap>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Resultado financeiro inclui juros, multas e descontos das baixas do período ({formatBRL(data.settlement_adjustments, { sign: true })}).
            Investimentos no período: {formatBRL(data.investments)} (não entram no resultado). Clique numa linha para ver as contas.
          </p>
        </div>
      )}
    </Wrap>
  );
}
