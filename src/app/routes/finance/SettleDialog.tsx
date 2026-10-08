import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatBRL } from '@/lib/money';
import { fmtDate, rpc, todaySP, type InstallmentRow, type Lookups } from './data';
import { Field, inputCls, MoneyInput } from './ui';

// Baixa (pagamento/recebimento) de UMA parcela, total ou parcial.
// Só oferece bancos/caixas da MESMA empresa do lançamento (o servidor também recusa outros).
export function SettleDialog({ row, lookups, onClose, onDone }: {
  row: InstallmentRow; lookups: Lookups; onClose: () => void; onDone: () => void;
}) {
  const accounts = lookups.accounts.filter((a) => a.company_id === row.company_id && a.is_active);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [date, setDate] = useState(todaySP());
  const [amount, setAmount] = useState(row.remaining_cents);
  const [interest, setInterest] = useState(0);
  const [fine, setFine] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const net = amount + interest + fine - discount;
  const pay = row.kind === 'payable';

  const save = async () => {
    if (!accountId) { toast.error('Escolha o banco/caixa.'); return; }
    if (amount <= 0) { toast.error('Informe o valor da baixa.'); return; }
    if (amount > row.remaining_cents) { toast.error(`O valor passa do que falta na parcela (${formatBRL(row.remaining_cents)}).`); return; }
    setBusy(true);
    try {
      await rpc('fin_settle', {
        p: {
          installment_id: row.id, account_id: accountId, settle_date: date, amount_cents: amount,
          interest_cents: interest, fine_cents: fine, discount_cents: discount, notes: notes.trim() || null,
        },
      });
      toast.success(amount < row.remaining_cents ? 'Baixa parcial registrada.' : pay ? 'Pagamento registrado.' : 'Recebimento registrado.');
      onDone();
    } catch (e) {
      toast.error('Não foi possível dar baixa', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={pay ? 'Registrar pagamento' : 'Registrar recebimento'}
      description={`${row.description}${row.installments_count > 1 ? ` — parcela ${row.number}/${row.installments_count}` : ''} · vence ${fmtDate(row.due_date)} · ${row.company_name}`}>
      <div className="mb-4 grid grid-cols-3 gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 py-2 text-xs">
        <div><div className="text-[var(--color-text-muted)]">Parcela</div><div className="font-semibold tabular-nums">{formatBRL(row.amount_cents)}</div></div>
        <div><div className="text-[var(--color-text-muted)]">Já baixado</div><div className="font-semibold tabular-nums">{formatBRL(row.paid_cents)}</div></div>
        <div><div className="text-[var(--color-text-muted)]">Falta</div><div className="font-semibold tabular-nums text-[var(--accent-primary)]">{formatBRL(row.remaining_cents)}</div></div>
      </div>
      {accounts.length === 0 ? (
        <div className="rounded-lg bg-[rgba(245,158,11,0.1)] px-3 py-2 text-sm">
          A empresa <b>{row.company_name}</b> não tem banco/caixa ativo. Cadastre um em Financeiro → Cadastros → Bancos e caixas.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Data" htmlFor="st-date">
              <input id="st-date" type="date" max={todaySP()} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label={`Banco/caixa (${row.company_name})`} htmlFor="st-acc">
              <select id="st-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {formatBRL(a.balance_cents)}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Valor da parcela a baixar" htmlFor="st-amount" hint="Menor que o saldo = baixa parcial; o resto continua em aberto.">
            <MoneyInput id="st-amount" cents={amount} onChange={setAmount} autoFocus />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Juros" htmlFor="st-int"><MoneyInput id="st-int" cents={interest} onChange={setInterest} /></Field>
            <Field label="Multa" htmlFor="st-fine"><MoneyInput id="st-fine" cents={fine} onChange={setFine} /></Field>
            <Field label="Desconto" htmlFor="st-disc"><MoneyInput id="st-disc" cents={discount} onChange={setDiscount} /></Field>
          </div>
          <Field label="Observação" htmlFor="st-notes">
            <input id="st-notes" value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} className={inputCls} placeholder="Ex.: PIX comprovante 123" />
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-3 py-2">
            <span className="text-sm text-[var(--color-text-secondary)]">{pay ? 'Sai do banco' : 'Entra no banco'}</span>
            <span className="text-lg font-bold tabular-nums">{formatBRL(net)}</span>
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={busy || accounts.length === 0}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirmar baixa
        </Button>
      </div>
    </Dialog>
  );
}
