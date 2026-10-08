import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, Copy, ExternalLink, FileText, Loader2, Paperclip, Pencil, QrCode, Undo2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { formatBRL } from '@/lib/money';
import { fmtDate, fmtDateTime, friendlyError, rpc, type Entry, type InstallmentRow, type Lookups, type Settlement } from './data';
import { EntryFormDialog } from './EntryFormDialog';
import { SettleDialog } from './SettleDialog';
import { AuditList } from './AuditList';
import { Field, inputCls, ReasonDialog, StatusBadge, SubTabs, tdCls, thCls } from './ui';

interface Charge {
  id: string; installment_id: string; status: string; billing_type: string; value_cents: number; due_date: string;
  invoice_url: string | null; bank_slip_url: string | null; pix_payload: string | null; error_message: string | null; created_at: string;
}
interface Attachment { id: string; file_path: string; file_name: string; size_bytes: number | null; created_at: string }

const CHARGE_LABEL: Record<string, string> = {
  pending: 'Emitindo', open: 'Em aberto', paid: 'Paga', canceled: 'Cancelada', refund_requested: 'Devolução pedida', refunded: 'Devolvida', failed: 'Falhou',
};

type Tab = 'parcelas' | 'baixas' | 'anexos' | 'historico';

export function EntryDetailDialog({ entryId, lookups, onClose, onChanged }: {
  entryId: string; lookups: Lookups; onClose: () => void; onChanged: () => void;
}) {
  const perms = usePermission();
  const { orgId } = useAppUser();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [rows, setRows] = useState<InstallmentRow[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [tab, setTab] = useState<Tab>('parcelas');
  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState<InstallmentRow | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [reversing, setReversing] = useState<Settlement | null>(null);
  const [charging, setCharging] = useState<InstallmentRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const [e, i, s, c, f] = await Promise.all([
      sb.from('fin_entries').select('*').eq('id', entryId).maybeSingle(),
      sb.from('fin_installments_v').select('*').eq('entry_id', entryId).order('number'),
      sb.from('fin_settlements').select('*').eq('entry_id', entryId).order('created_at'),
      sb.from('fin_charges').select('*').eq('entry_id', entryId).order('created_at', { ascending: false }),
      sb.from('fin_entry_attachments').select('*').eq('entry_id', entryId).order('created_at'),
    ]);
    if (e.error) toast.error('Não foi possível abrir o lançamento', { description: friendlyError(e.error) });
    setEntry((e.data as Entry) ?? null);
    setRows((i.data ?? []) as InstallmentRow[]);
    setSettlements((s.data ?? []) as Settlement[]);
    setCharges((c.data ?? []) as Charge[]);
    setFiles((f.data ?? []) as Attachment[]);
  }, [entryId]);

  useEffect(() => { void load(); }, [load]);

  const refresh = () => { void load(); onChanged(); };
  const accName = (id: string) => lookups.accounts.find((a) => a.id === id)?.name ?? '—';
  const company = lookups.companies.find((c) => c.id === entry?.company_id);
  const party = lookups.parties.find((p) => p.id === entry?.party_id);
  const chart = lookups.chart.find((c) => c.id === entry?.chart_account_id);
  const cc = lookups.costCenters.find((c) => c.id === entry?.cost_center_id);
  const active = entry?.status === 'active';
  const totalPaid = rows.reduce((s, r) => s + r.paid_cents, 0);
  const hasSettlement = settlements.length > 0;

  const openFile = async (a: Attachment) => {
    const { data, error } = await getSupabase().storage.from('whatsapp-hub-finance').createSignedUrl(a.file_path, 300);
    if (error || !data) { toast.error('Não foi possível abrir o anexo', { description: friendlyError(error) }); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length || !orgId || !entry) return;
    const sb = getSupabase();
    for (const f of Array.from(list).slice(0, 10)) {
      const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80);
      const path = `${orgId}/${entry.id}/${Date.now()}-${safe}`;
      const up = await sb.storage.from('whatsapp-hub-finance').upload(path, f, { contentType: f.type || undefined });
      if (up.error) { toast.error(`Anexo ${f.name} não foi enviado`, { description: friendlyError(up.error) }); continue; }
      const { error } = await sb.from('fin_entry_attachments').insert({ entry_id: entry.id, file_path: path, file_name: f.name, size_bytes: f.size });
      if (error) toast.error(`Anexo ${f.name} não foi registrado`, { description: friendlyError(error) });
    }
    void load();
  };

  const chargeAction = async (action: 'cancel_charge' | 'refund_charge', ch: Charge) => {
    const msg = action === 'cancel_charge' ? 'Cancelar esta cobrança no ASAAS?' : 'Pedir ao ASAAS a devolução deste pagamento? A baixa é estornada quando o ASAAS confirmar.';
    if (!window.confirm(msg)) return;
    const { data, error } = await getSupabase().functions.invoke('fin-asaas', { body: { action, charge_id: ch.id } });
    if (error || !data?.ok) {
      let m = data?.error as string | undefined;
      if (!m && error && 'context' in error) { try { m = (await (error as { context: Response }).context.json())?.error; } catch { /* */ } }
      toast.error('Não foi possível concluir', { description: m ?? 'A função de cobrança ainda não foi publicada.' });
      return;
    }
    toast.success(action === 'cancel_charge' ? 'Cobrança cancelada.' : 'Devolução pedida ao ASAAS.');
    refresh();
  };

  if (!entry) {
    return (
      <Dialog open onClose={onClose} title="Lançamento">
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>
      </Dialog>
    );
  }

  const auditIds = [entry.id, ...rows.map((r) => r.id), ...settlements.map((s) => s.id), ...charges.map((c) => c.id), ...files.map((f) => f.id)];

  return (
    <>
      <Dialog open onClose={onClose} widthClass="max-w-4xl"
        title={`${entry.kind === 'payable' ? 'Conta a pagar' : 'Conta a receber'} · ${entry.description}`}
        description={`${company?.name ?? ''} · lançada em ${fmtDateTime(entry.created_at)}`}>
        <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-1">
          {!active && (
            <div className="rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] px-3 py-2 text-sm">
              <b className="text-[var(--color-error)]">Cancelado</b> em {fmtDateTime(entry.canceled_at)} — {entry.cancel_reason}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-4">
            <Info label={entry.kind === 'payable' ? 'Fornecedor' : 'Cliente'} value={party?.name ?? '—'} />
            <Info label="Plano de contas" value={chart ? `${chart.code} ${chart.name}` : '—'} />
            <Info label="Centro de custo" value={cc?.name ?? 'Sem centro de custo'} />
            <Info label="Valor total" value={formatBRL(entry.total_cents)} strong />
            <Info label="Emissão" value={fmtDate(entry.issue_date)} />
            <Info label="Competência" value={fmtDate(entry.competence_date)} />
            <Info label="Parcelas" value={entry.installments_count === 1 ? 'Única' : `${entry.installments_count}x`} />
            <Info label="Baixado" value={formatBRL(totalPaid)} />
            {entry.source !== 'manual' && <Info label="Origem" value={`${{ purchase: 'Compras', hr: 'RH', associates: 'Associados' }[entry.source] ?? entry.source}${entry.source_ref ? ` · ${entry.source_ref}` : ''}`} />}
          </div>
          {entry.notes && <p className="whitespace-pre-wrap rounded-lg bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">{entry.notes}</p>}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <SubTabs<Tab> value={tab} onChange={setTab} tabs={[['parcelas', 'Parcelas'], ['baixas', `Baixas (${settlements.length})`], ['anexos', `Anexos (${files.length})`], ['historico', 'Histórico']]} />
            {active && (
              <div className="flex flex-wrap gap-2">
                {perms.can('financial.ledger_edit') && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>}
                {perms.can('financial.ledger_reverse') && <Button size="sm" variant="outline" className="text-[var(--color-error)]" onClick={() => setCanceling(true)}><Ban className="h-3.5 w-3.5" /> Cancelar lançamento</Button>}
              </div>
            )}
          </div>

          {tab === 'parcelas' && (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
              <table className="w-full min-w-[720px] text-sm">
                <thead><tr className="border-b border-[var(--color-border-card)]">
                  <th className={thCls}>Parcela</th><th className={thCls}>Vencimento</th><th className={cn(thCls, 'text-right')}>Valor</th>
                  <th className={cn(thCls, 'text-right')}>Baixado</th><th className={cn(thCls, 'text-right')}>Falta</th><th className={thCls}>Status</th>
                  {entry.kind === 'receivable' && <th className={thCls}>Cobrança</th>}<th className={thCls} />
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const ch = charges.find((c) => c.installment_id === r.id && ['pending', 'open', 'paid', 'refund_requested', 'failed'].includes(c.status));
                    return (
                      <tr key={r.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                        <td className={tdCls}>{r.number}/{r.installments_count}</td>
                        <td className={tdCls}>{fmtDate(r.due_date)}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(r.amount_cents)}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(r.paid_cents)}</td>
                        <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(r.remaining_cents)}</td>
                        <td className={tdCls}><StatusBadge status={r.status} partial={r.is_partial} /></td>
                        {entry.kind === 'receivable' && (
                          <td className={tdCls}>
                            {ch ? (
                              <div className="flex flex-wrap items-center gap-1 text-xs">
                                <span className="font-semibold">{ch.billing_type === 'UNDEFINED' ? 'Boleto/PIX' : ch.billing_type}</span>
                                <span className="text-[var(--color-text-muted)]">· {CHARGE_LABEL[ch.status] ?? ch.status}</span>
                                {ch.invoice_url && <a href={ch.invoice_url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-primary)]" title="Abrir cobrança"><ExternalLink className="h-3.5 w-3.5" /></a>}
                                {ch.pix_payload && <button type="button" title="Copiar PIX copia-e-cola" onClick={() => { void navigator.clipboard.writeText(ch.pix_payload!); toast.success('PIX copiado.'); }} className="text-[var(--accent-primary)]"><Copy className="h-3.5 w-3.5" /></button>}
                                {perms.can('financial.billing') && ['open', 'pending', 'failed'].includes(ch.status) && <button type="button" onClick={() => void chargeAction('cancel_charge', ch)} className="text-[var(--color-error)] hover:underline">cancelar</button>}
                                {perms.can('financial.billing') && ch.status === 'paid' && <button type="button" onClick={() => void chargeAction('refund_charge', ch)} className="text-[var(--color-error)] hover:underline">pedir devolução</button>}
                                {ch.error_message && <span className="w-full text-[var(--color-error)]">{ch.error_message}</span>}
                              </div>
                            ) : active && r.remaining_cents > 0 && perms.can('financial.billing') ? (
                              <Button size="sm" variant="outline" onClick={() => setCharging(r)}><QrCode className="h-3.5 w-3.5" /> Emitir</Button>
                            ) : <span className="text-xs text-[var(--color-text-muted)]">—</span>}
                          </td>
                        )}
                        <td className={cn(tdCls, 'text-right')}>
                          {active && r.remaining_cents > 0 && perms.can('financial.ledger_settle') && (
                            <Button size="sm" onClick={() => setSettling(r)}><CheckCircle2 className="h-3.5 w-3.5" /> {entry.kind === 'payable' ? 'Pagar' : 'Receber'}</Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'baixas' && (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
              <table className="w-full min-w-[760px] text-sm">
                <thead><tr className="border-b border-[var(--color-border-card)]">
                  <th className={thCls}>Data</th><th className={thCls}>Parcela</th><th className={thCls}>Banco/caixa</th>
                  <th className={cn(thCls, 'text-right')}>Principal</th><th className={cn(thCls, 'text-right')}>Juros+multa</th>
                  <th className={cn(thCls, 'text-right')}>Desconto</th><th className={cn(thCls, 'text-right')}>Movimento</th><th className={thCls} />
                </tr></thead>
                <tbody>
                  {settlements.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--color-text-muted)]">Nenhuma baixa ainda.</td></tr>}
                  {settlements.map((s) => {
                    const r = rows.find((x) => x.id === s.installment_id);
                    const rev = s.reversal_of !== null;
                    return (
                      <tr key={s.id} className={cn('border-b border-[var(--color-border-soft)] last:border-0', (rev || s.reversed_at) && 'text-[var(--color-text-muted)]')}>
                        <td className={tdCls}>{fmtDate(s.settle_date)}</td>
                        <td className={tdCls}>{r ? `${r.number}/${r.installments_count}` : '—'}{rev && <span className="ml-1 rounded bg-[rgba(239,68,68,0.1)] px-1 text-[10px] font-semibold text-[var(--color-error)]">ESTORNO</span>}</td>
                        <td className={tdCls}>{accName(s.account_id)}{s.source === 'asaas' && <span className="ml-1 text-[10px] font-semibold text-[var(--accent-primary)]">ASAAS</span>}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(s.amount_cents)}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(s.interest_cents + s.fine_cents)}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(s.discount_cents)}</td>
                        <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(s.net_cents)}</td>
                        <td className={cn(tdCls, 'text-right text-xs')}>
                          {s.reversed_at ? <span title={s.reverse_reason ?? ''}>Estornada</span>
                            : !rev && perms.can('financial.ledger_reverse') && (
                              <Button size="sm" variant="outline" onClick={() => setReversing(s)}><Undo2 className="h-3.5 w-3.5" /> Estornar</Button>
                            )}
                          {rev && s.reverse_reason && <span title={s.reverse_reason}>{s.reverse_reason.slice(0, 30)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'anexos' && (
            <div className="space-y-2">
              {files.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum anexo.</p>}
              {files.map((f) => (
                <button key={f.id} type="button" onClick={() => void openFile(f)}
                  className="flex w-full items-center gap-2 rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)]">
                  <FileText className="h-4 w-4 text-[var(--accent-primary)]" /> <span className="flex-1 truncate">{f.file_name}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">{fmtDateTime(f.created_at)}</span>
                </button>
              ))}
              {active && (perms.can('financial.ledger_edit') || perms.can('financial.ledger_create')) && (
                <>
                  <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void addFiles(e.target.files)} />
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Paperclip className="h-3.5 w-3.5" /> Anexar arquivo</Button>
                </>
              )}
            </div>
          )}

          {tab === 'historico' && <AuditList recordIds={auditIds} />}
        </div>
      </Dialog>

      {editing && (
        <EntryFormDialog kind={entry.kind} lookups={lookups} entry={entry} hasSettlement={hasSettlement}
          onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />
      )}
      {settling && <SettleDialog row={settling} lookups={lookups} onClose={() => setSettling(null)} onDone={() => { setSettling(null); refresh(); }} />}
      {canceling && (
        <ReasonDialog title="Cancelar lançamento" danger confirmLabel="Cancelar lançamento"
          description="O lançamento fica visível como cancelado e sai dos totais. Nada é apagado."
          onClose={() => setCanceling(false)}
          onConfirm={async (reason) => {
            try { await rpc('fin_cancel_entry', { p_id: entry.id, p_reason: reason }); toast.success('Lançamento cancelado.'); setCanceling(false); refresh(); }
            catch (e) { toast.error('Não foi possível cancelar', { description: e instanceof Error ? e.message : String(e) }); }
          }} />
      )}
      {reversing && (
        <ReasonDialog title="Estornar baixa" danger confirmLabel="Estornar"
          description={`Cria um contra-lançamento de ${formatBRL(reversing.net_cents)} com a data de hoje. A parcela volta a ficar em aberto. A baixa original continua visível.`}
          onClose={() => setReversing(null)}
          onConfirm={async (reason) => {
            try { await rpc('fin_reverse_settlement', { p_id: reversing.id, p_reason: reason }); toast.success('Baixa estornada.'); setReversing(null); refresh(); }
            catch (e) { toast.error('Não foi possível estornar', { description: e instanceof Error ? e.message : String(e) }); }
          }} />
      )}
      {charging && <ChargeDialog row={charging} lookups={lookups} onClose={() => setCharging(null)} onDone={() => { setCharging(null); refresh(); }} />}
    </>
  );
}

function Info({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className={cn('truncate', strong ? 'font-bold tabular-nums' : 'text-[var(--color-text-primary)]')}>{value}</div>
    </div>
  );
}

// Emitir boleto/PIX pelo ASAAS para uma parcela a receber.
function ChargeDialog({ row, lookups, onClose, onDone }: { row: InstallmentRow; lookups: Lookups; onClose: () => void; onDone: () => void }) {
  const accounts = lookups.accounts.filter((a) => a.company_id === row.company_id && a.is_active && a.kind === 'bank');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [type, setType] = useState<'PIX' | 'BOLETO' | 'UNDEFINED'>('UNDEFINED');
  const [busy, setBusy] = useState(false);
  const emit = async () => {
    if (!accountId) { toast.error('Escolha o banco que vai receber.'); return; }
    setBusy(true);
    const { data, error } = await getSupabase().functions.invoke('fin-asaas', {
      body: { action: 'create_charge', installment_id: row.id, account_id: accountId, billing_type: type },
    });
    setBusy(false);
    if (error || !data?.ok) {
      let m = data?.error as string | undefined;
      if (!m && error && 'context' in error) { try { m = (await (error as { context: Response }).context.json())?.error; } catch { /* */ } }
      toast.error('Não foi possível emitir a cobrança', { description: m ?? 'A função de cobrança ainda não foi publicada.' });
      return;
    }
    toast.success('Cobrança emitida.', { description: data.invoice_url ? 'O link já está na parcela.' : undefined });
    onDone();
  };
  return (
    <Dialog open onClose={onClose} title="Emitir cobrança (ASAAS)" description={`${row.description} · ${formatBRL(row.remaining_cents)} · vence ${fmtDate(row.due_date)}`}>
      <div className="space-y-3">
        <Field label="Forma" htmlFor="ch-type">
          <select id="ch-type" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={inputCls}>
            <option value="UNDEFINED">Boleto + PIX (o cliente escolhe)</option>
            <option value="PIX">Só PIX</option>
            <option value="BOLETO">Só boleto</option>
          </select>
        </Field>
        <Field label={`Banco que recebe (${row.company_name})`} htmlFor="ch-acc" hint="Quando o pagamento cair, a baixa entra neste banco.">
          {accounts.length === 0 ? (
            <div className="text-sm text-[var(--color-error)]">A empresa {row.company_name} não tem conta bancária ativa.</div>
          ) : (
            <select id="ch-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void emit()} disabled={busy || accounts.length === 0}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} Emitir</Button>
      </div>
    </Dialog>
  );
}

