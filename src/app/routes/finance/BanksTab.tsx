import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, Landmark, Loader2, Undo2, Wallet } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatBRL } from '@/lib/money';
import { addDays, fmtDate, friendlyError, rpc, todaySP, type Account, type Lookups } from './data';
import { CompanySelect, EmptyRow, Field, inputCls, MoneyInput, ReasonDialog, TableWrap, tdCls, thCls } from './ui';

interface Transfer {
  id: string; from_account_id: string; to_account_id: string; amount_cents: number; transfer_date: string;
  description: string | null; reversal_of: string | null; reversed_at: string | null; reverse_reason: string | null; created_at: string;
}
interface Movement { account_id: string; move_date: string; signed_cents: number; origin: string; description: string; created_at: string; ref_id: string }

const ORIGIN: Record<string, string> = {
  settlement: 'Baixa', settlement_reversal: 'Estorno de baixa', transfer_in: 'Transferência recebida', transfer_out: 'Transferência enviada',
  transfer_reversal_in: 'Estorno de transferência', transfer_reversal_out: 'Estorno de transferência',
};

export function BanksTab({ lookups }: { lookups: Lookups }) {
  const perms = usePermission();
  const [company, setCompany] = useState('');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [creating, setCreating] = useState(false);
  const [reversing, setReversing] = useState<Transfer | null>(null);
  const [statement, setStatement] = useState<Account | null>(null);

  const load = useCallback(async () => {
    const { data } = await getSupabase().from('fin_transfers').select('*').order('created_at', { ascending: false }).limit(200);
    setTransfers((data ?? []) as Transfer[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const accounts = lookups.accounts.filter((a) => !company || a.company_id === company);
  const total = accounts.filter((a) => a.is_active).reduce((s, a) => s + a.balance_cents, 0);
  const accName = (id: string) => lookups.accounts.find((a) => a.id === id)?.name ?? '—';
  const shownTransfers = transfers.filter((t) => !company || lookups.accounts.some((a) => (a.id === t.from_account_id || a.id === t.to_account_id) && a.company_id === company));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56"><CompanySelect companies={lookups.companies} value={company} onChange={setCompany} /></div>
        <div className="ml-auto text-sm text-[var(--color-text-secondary)]">Saldo total: <b className="tabular-nums text-[var(--color-text-primary)]">{formatBRL(total)}</b></div>
        {perms.can('financial.transfer') && <Button onClick={() => setCreating(true)}><ArrowLeftRight className="h-4 w-4" /> Nova transferência</Button>}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {accounts.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum banco/caixa. Cadastre em Cadastros → Bancos e caixas.</p>}
        {accounts.map((a) => (
          <button key={a.id} type="button" onClick={() => setStatement(a)}
            className={cn('rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-left hover:bg-[var(--color-surface-hover)]', !a.is_active && 'opacity-60')}>
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              {a.kind === 'cash' ? <Wallet className="h-4 w-4 text-[var(--accent-primary)]" /> : <Landmark className="h-4 w-4 text-[var(--accent-primary)]" />}
              <span className="truncate">{a.name}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{a.company_name}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_number ? ` · ${a.account_number}` : ''}</div>
            <div className={cn('mt-2 text-xl font-bold tabular-nums', a.balance_cents < 0 && 'text-[var(--color-error)]')}>{formatBRL(a.balance_cents)}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Ver extrato</div>
          </button>
        ))}
      </div>

      <h3 className="pt-2 text-sm font-semibold text-[var(--color-text-primary)]">Transferências</h3>
      <TableWrap minWidth={820}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Data</th><th className={thCls}>De</th><th className={thCls}>Para</th><th className={thCls}>Descrição</th>
          <th className={cn(thCls, 'text-right')}>Valor</th><th className={cn(thCls, 'text-right')}>Ações</th>
        </tr></thead>
        <tbody>
          {shownTransfers.length === 0 && <EmptyRow cols={6} text="Nenhuma transferência." />}
          {shownTransfers.map((t) => (
            <tr key={t.id} className={cn('border-b border-[var(--color-border-soft)] last:border-0', (t.reversed_at || t.reversal_of) && 'text-[var(--color-text-muted)]')}>
              <td className={tdCls}>{fmtDate(t.transfer_date)}</td>
              <td className={tdCls}>{accName(t.from_account_id)}</td>
              <td className={tdCls}>{accName(t.to_account_id)}</td>
              <td className={tdCls}>
                {t.description ?? '—'}
                {t.reversal_of && <span className="ml-1 rounded bg-[rgba(239,68,68,0.1)] px-1 text-[10px] font-semibold text-[var(--color-error)]">ESTORNO</span>}
              </td>
              <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(t.amount_cents)}</td>
              <td className={cn(tdCls, 'text-right text-xs')}>
                {t.reversed_at ? <span title={t.reverse_reason ?? ''}>Estornada</span>
                  : !t.reversal_of && perms.can('financial.ledger_reverse') && (
                    <Button size="sm" variant="outline" onClick={() => setReversing(t)}><Undo2 className="h-3.5 w-3.5" /> Estornar</Button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {creating && <TransferDialog lookups={lookups} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load(); void lookups.reload(); }} />}
      {reversing && (
        <ReasonDialog title="Estornar transferência" danger confirmLabel="Estornar"
          description={`Cria a transferência de volta (${formatBRL(reversing.amount_cents)}) com a data de hoje. A original continua visível.`}
          onClose={() => setReversing(null)}
          onConfirm={async (reason) => {
            try { await rpc('fin_reverse_transfer', { p_id: reversing.id, p_reason: reason }); toast.success('Transferência estornada.'); setReversing(null); void load(); void lookups.reload(); }
            catch (e) { toast.error('Não foi possível estornar', { description: e instanceof Error ? e.message : String(e) }); }
          }} />
      )}
      {statement && <StatementDialog account={statement} onClose={() => setStatement(null)} />}
    </div>
  );
}

function TransferDialog({ lookups, onClose, onDone }: { lookups: Lookups; onClose: () => void; onDone: () => void }) {
  const active = lookups.accounts.filter((a) => a.is_active);
  const [fromId, setFromId] = useState(active[0]?.id ?? '');
  const [toId, setToId] = useState(active[1]?.id ?? '');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todaySP());
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const from = active.find((a) => a.id === fromId);
  const to = active.find((a) => a.id === toId);
  const save = async () => {
    if (!fromId || !toId || fromId === toId) { toast.error('Escolha duas contas diferentes.'); return; }
    if (amount <= 0) { toast.error('Informe o valor.'); return; }
    setBusy(true);
    try {
      await rpc('fin_create_transfer', { p: { from_account_id: fromId, to_account_id: toId, amount_cents: amount, transfer_date: date, description: desc.trim() || null } });
      toast.success('Transferência registrada.');
      onDone();
    } catch (e) {
      toast.error('Não foi possível transferir', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Nova transferência" description="Sai de uma conta e entra na outra no mesmo ato.">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sai de" required htmlFor="tr-from">
            <select id="tr-from" value={fromId} onChange={(e) => setFromId(e.target.value)} className={inputCls}>
              {active.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.company_name})</option>)}
            </select>
          </Field>
          <Field label="Entra em" required htmlFor="tr-to">
            <select id="tr-to" value={toId} onChange={(e) => setToId(e.target.value)} className={inputCls}>
              {active.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.company_name})</option>)}
            </select>
          </Field>
        </div>
        {from && to && from.company_id !== to.company_id && (
          <p className="rounded-lg bg-[rgba(245,158,11,0.1)] px-3 py-2 text-xs">Atenção: as contas são de empresas diferentes ({from.company_name} → {to.company_name}).</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor" required htmlFor="tr-amount"><MoneyInput id="tr-amount" cents={amount} onChange={setAmount} autoFocus /></Field>
          <Field label="Data" required htmlFor="tr-date"><input id="tr-date" type="date" max={todaySP()} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
        </div>
        <Field label="Descrição" htmlFor="tr-desc"><input id="tr-desc" value={desc} onChange={(e) => setDesc(e.target.value.slice(0, 200))} className={inputCls} placeholder="Ex.: Sangria do caixa para o banco" /></Field>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Transferir</Button>
      </div>
    </Dialog>
  );
}

function StatementDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const today = todaySP();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [opening, setOpening] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      const sb = getSupabase();
      const [m, before] = await Promise.all([
        sb.from('fin_movements_v').select('*').eq('account_id', account.id).gte('move_date', from).lte('move_date', to).order('move_date').order('created_at'),
        sb.from('fin_movements_v').select('signed_cents').eq('account_id', account.id).lt('move_date', from),
      ]);
      if (cancel) return;
      setErr(m.error ? friendlyError(m.error) : null);
      setRows((m.data ?? []) as Movement[]);
      setOpening(account.opening_balance_cents + ((before.data ?? []) as Array<{ signed_cents: number }>).reduce((s, x) => s + Number(x.signed_cents), 0));
    })();
    return () => { cancel = true; };
  }, [account, from, to]);
  let running = opening;
  return (
    <Dialog open onClose={onClose} title={`Extrato · ${account.name}`} description={account.company_name} widthClass="max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
        de <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, 'w-36')} />
        até <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(inputCls, 'w-36')} />
        <span className="ml-auto">Saldo anterior: <b className="tabular-nums text-[var(--color-text-primary)]">{formatBRL(opening)}</b></span>
      </div>
      {err && <p className="text-sm text-[var(--color-error)]">{err}</p>}
      <div className="max-h-[55vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Data</th><th className={thCls}>Histórico</th><th className={cn(thCls, 'text-right')}>Valor</th><th className={cn(thCls, 'text-right')}>Saldo</th></tr></thead>
          <tbody>
            {rows?.length === 0 && <EmptyRow cols={4} text="Sem movimentos no período." />}
            {rows?.map((m, i) => {
              running += Number(m.signed_cents);
              return (
                <tr key={`${m.ref_id}-${i}`} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className={tdCls}>{fmtDate(m.move_date)}</td>
                  <td className={tdCls}><span className="text-xs text-[var(--color-text-muted)]">{ORIGIN[m.origin] ?? m.origin} · </span>{m.description}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums', m.signed_cents < 0 ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]')}>{formatBRL(m.signed_cents, { sign: true })}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(running)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
