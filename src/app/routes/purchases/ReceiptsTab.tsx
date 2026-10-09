import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import {
  DIVERGENCE, DIVERGENCE_STATUS, fmtDate, fmtDateTime, personName, purError, qtyFmt, RECEIPT_STATUS, rpc,
  type OrderItem, type PurLookups, type Receipt, type ReceiptItem, type ReceiptStatus, type TabProps,
  partyDisplay, upperBR,
} from './data';
import { Badge, Field, inputCls, KV, QtyInput, ReasonDialog, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, Trace, useOpenDoc } from './ui';
import { DataGrid, GridReset, useGrid } from '@/components/ui/GridTable';

type ReceiptRow = Receipt & { created_by: string | null; done_by: string | null; pur_orders: { number: string | null; party_id: string | null } | null };

export function ReceiptsTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const [rows, setRows] = useState<ReceiptRow[] | null>(null);
  const [status, setStatus] = useState<'' | ReceiptStatus>('');
  const load = useCallback(async () => {
    let q = getSupabase().from('pur_receipts').select('*, pur_orders(number, party_id)').order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as ReceiptRow[]);
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  const current = useOpenDoc<ReceiptRow>('pur_receipts', openId, rows, '*, pur_orders(number, party_id)');
  const party = (id: string | null | undefined) => partyDisplay(lookups.suppliers.find((p) => p.id === id)) || '—';
  const partyLegal = (id: string | null | undefined) => upperBR(lookups.suppliers.find((p) => p.id === id)?.name) || '—';

  const grid = useGrid('megacrm_grid_pur_receipt', [
    { id: 'number', label: 'Número', width: 110, sortValue: (r: ReceiptRow) => r.number ?? '', render: (r: ReceiptRow) => <span className="font-semibold">{r.number}</span> },
    { id: 'order', label: 'Pedido', width: 110, sortValue: (r: ReceiptRow) => r.pur_orders?.number ?? '', render: (r: ReceiptRow) => r.pur_orders?.number ?? '—' },
    { id: 'party', label: 'Fornecedor', width: 240, sortValue: (r: ReceiptRow) => party(r.pur_orders?.party_id), render: (r: ReceiptRow) => <span className="block truncate">{party(r.pur_orders?.party_id)}</span> },
    { id: 'party_legal', label: 'Razão social', width: 220, defaultHidden: true, sortValue: (r: ReceiptRow) => partyLegal(r.pur_orders?.party_id), render: (r: ReceiptRow) => <span className="block truncate text-[var(--color-text-secondary)]">{partyLegal(r.pur_orders?.party_id)}</span> },
    { id: 'date', label: 'Data', width: 105, sortValue: (r: ReceiptRow) => r.received_date ?? '', render: (r: ReceiptRow) => fmtDate(r.received_date) },
    { id: 'loc', label: 'Local', width: 150, sortValue: (r: ReceiptRow) => lookups.locations.find((l) => l.id === r.location_id)?.name ?? '', render: (r: ReceiptRow) => lookups.locations.find((l) => l.id === r.location_id)?.name ?? '—' },
    { id: 'by', label: 'Conferido por', width: 150, sortValue: (r: ReceiptRow) => personName(lookups.people, r.done_by ?? r.created_by), render: (r: ReceiptRow) => <span className="block truncate">{personName(lookups.people, r.done_by ?? r.created_by)}</span> },
    { id: 'status', label: 'Situação', width: 150, sortValue: (r: ReceiptRow) => RECEIPT_STATUS[r.status][0], render: (r: ReceiptRow) => <StatusPill map={RECEIPT_STATUS} status={r.status} /> },
  ], rows ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs value={status} onChange={setStatus} tabs={[['', 'Todos'], ['draft', 'Em conferência'], ['done', 'Concluídos'], ['reversed', 'Estornados']]} />
        <span className="text-xs text-[var(--color-text-muted)]">Para receber, abra o pedido e clique em “Receber”.</span>
      </div>
      <div className="flex justify-end"><GridReset grid={grid} /></div>
      {!rows ? <Spinner /> : (
        <DataGrid grid={grid} rowKey={(r) => r.id} onRowClick={(r) => onOpen('receipt', r.id)} emptyText="Nenhum recebimento." />
      )}
      {openId && current && <ReceiptDetail rc={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} />}
    </div>
  );
}

type Line = ReceiptItem & { oi: OrderItem | undefined };

function ReceiptDetail({ rc, lookups, onClose, onOpen, onChanged }: { rc: ReceiptRow; lookups: PurLookups; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [tab, setTab] = useState<'conferencia' | 'historico'>('conferencia');
  const [reversing, setReversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const draft = rc.status === 'draft';
  const canEdit = draft && perms.can('purchases.receive');

  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [ri, oi] = await Promise.all([
      sb.from('pur_receipt_items').select('*').eq('receipt_id', rc.id),
      sb.from('pur_order_items').select('*').eq('order_id', rc.order_id),
    ]);
    const ois = (oi.data ?? []) as OrderItem[];
    setLines(((ri.data ?? []) as ReceiptItem[]).map((r) => ({ ...r, oi: ois.find((o) => o.id === r.order_item_id) })));
  }, [rc.id, rc.order_id]);
  useEffect(() => { void reload(); }, [reload, rc.status]);

  const patch = async (l: Line, p: Partial<ReceiptItem>) => {
    const next = { ...l, ...p };
    if ('received_qty' in p || 'accepted_qty' in p) {
      next.accepted_qty = Math.min(Number(next.accepted_qty), Number(next.received_qty));
      next.rejected_qty = Math.round((Number(next.received_qty) - Number(next.accepted_qty)) * 1000) / 1000;
    }
    setLines((ls) => ls?.map((x) => (x.id === l.id ? next : x)) ?? null);
    const { error } = await getSupabase().from('pur_receipt_items').update({
      received_qty: next.received_qty, accepted_qty: next.accepted_qty, rejected_qty: next.rejected_qty, lot: next.lot || null,
      expiry: next.expiry || null, divergence_type: next.divergence_type || null, divergence_status: next.divergence_status || null,
      divergence_notes: next.divergence_notes || null,
    }).eq('id', l.id);
    if (error) toast.error(purError(error));
  };
  const setLocation = async (loc: string) => {
    const { error } = await getSupabase().from('pur_receipts').update({ location_id: loc || null }).eq('id', rc.id);
    if (error) toast.error(purError(error)); else void onChanged();
  };
  const act = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await rpc(fn, args); toast.success(ok); await onChanged(); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    const { error } = await getSupabase().from('pur_receipts').delete().eq('id', rc.id);
    if (error) { toast.error(purError(error)); return; }
    toast.success('Conferência descartada.'); onClose(); void onChanged();
  };
  const reqLot = (l: Line) => !!lookups.items.find((i) => i.id === l.oi?.item_id)?.requires_lot;

  return (
    <Dialog open onClose={onClose} widthClass="max-w-6xl" opaque title={`Recebimento ${rc.number}`}
      description={`Pedido ${rc.pur_orders?.number ?? ''} · ${lookups.suppliers.find((p) => p.id === rc.pur_orders?.party_id)?.name ?? ''}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><StatusPill map={RECEIPT_STATUS} status={rc.status} /><Trace kind="receipt" id={rc.id} onOpen={onOpen} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <KV label="Data">{fmtDate(rc.received_date)}</KV>
          <KV label="Concluído">{rc.done_at ? `${fmtDateTime(rc.done_at)} · ${personName(lookups.people, rc.done_by)}` : '—'}</KV>
          {canEdit ? (
            <Field label="Local de estoque" htmlFor="rc-loc">
              <select id="rc-loc" value={rc.location_id ?? ''} onChange={(e) => setLocation(e.target.value)} className={inputCls}>
                <option value="">—</option>
                {lookups.locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          ) : <KV label="Local de estoque">{lookups.locations.find((l) => l.id === rc.location_id)?.name ?? '—'}</KV>}
          <KV label="Estorno">{rc.reversed_at ? `${fmtDateTime(rc.reversed_at)} — ${rc.reverse_reason}` : '—'}</KV>
        </div>
        {canEdit && <p className="text-xs text-[var(--color-text-secondary)]">Confira item a item: <b>recebida</b> é o que chegou; <b>aceita</b> é o que entra no estoque; a diferença é recusa e precisa do tipo de divergência. Itens do catálogo com lote exigem lote/validade.</p>}

        <SubTabs value={tab} onChange={setTab} tabs={[['conferencia', 'Conferência'], ['historico', 'Histórico']]} />
        {tab === 'historico' && <AuditList recordIds={[rc.id, ...(lines ?? []).map((l) => l.id)]} />}
        {tab === 'conferencia' && (!lines ? <Spinner /> : (
          <TableWrap minWidth={1100}>
            <thead><tr className="border-b border-[var(--color-border-card)]">
              <th className={thCls}>Item</th><th className={`${thCls} text-right`}>Pedido</th><th className={`${thCls} text-right`}>Pendente</th>
              <th className={thCls}>Recebida</th><th className={thCls}>Aceita</th><th className={`${thCls} text-right`}>Recusada</th>
              <th className={thCls}>Lote / validade</th><th className={thCls}>Divergência</th>
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const pending = Math.max(Number(l.oi?.qty ?? 0) - Number(l.oi?.received_qty ?? 0), 0);
                const lot = reqLot(l);
                return (
                  <tr key={l.id} className="border-b border-[var(--color-border-soft)] align-top last:border-0">
                    <td className={tdCls}>{l.oi?.description}{lot && <span className="ml-1"><Badge tone="warn">exige lote</Badge></span>}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(l.oi?.qty)} {l.oi?.unit}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{draft ? qtyFmt(pending) : '—'}</td>
                    <td className={tdCls}>{canEdit ? <QtyInput value={Number(l.received_qty)} onChange={(n) => patch(l, { received_qty: n, accepted_qty: Math.min(n, Number(l.accepted_qty) || n) })} /> : qtyFmt(l.received_qty)}</td>
                    <td className={tdCls}>{canEdit ? <QtyInput value={Number(l.accepted_qty)} onChange={(n) => patch(l, { accepted_qty: n })} /> : qtyFmt(l.accepted_qty)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums', Number(l.rejected_qty) > 0 && 'text-[var(--color-error)]')}>{qtyFmt(l.rejected_qty)}</td>
                    <td className={tdCls}>
                      {canEdit ? (
                        <div className="flex flex-col gap-1">
                          <input placeholder="Lote" defaultValue={l.lot ?? ''} onBlur={(e) => patch(l, { lot: e.target.value.trim() || null })} className="h-8 w-32 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                          <input type="date" defaultValue={l.expiry ?? ''} onBlur={(e) => patch(l, { expiry: e.target.value || null })} className="h-8 w-32 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                        </div>
                      ) : <span>{l.lot ?? '—'}{l.expiry ? ` · ${fmtDate(l.expiry)}` : ''}</span>}
                    </td>
                    <td className={tdCls}>
                      {canEdit ? (
                        <div className="flex flex-col gap-1">
                          <select value={l.divergence_type ?? ''} onChange={(e) => patch(l, { divergence_type: e.target.value || null, divergence_status: e.target.value ? l.divergence_status ?? 'analysis' : null })} className="h-8 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-sm">
                            <option value="">Sem divergência</option>
                            {Object.entries(DIVERGENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          {l.divergence_type && (<>
                            <select value={l.divergence_status ?? 'analysis'} onChange={(e) => patch(l, { divergence_status: e.target.value })} className="h-8 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-sm">
                              {Object.entries(DIVERGENCE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            <input placeholder="O que aconteceu" defaultValue={l.divergence_notes ?? ''} onBlur={(e) => patch(l, { divergence_notes: e.target.value.slice(0, 500) || null })} className="h-8 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                          </>)}
                        </div>
                      ) : l.divergence_type ? (
                        <span className="text-sm"><Badge tone="warn">{DIVERGENCE[l.divergence_type]}</Badge> {DIVERGENCE_STATUS[l.divergence_status ?? ''] ?? ''}<br /><span className="text-xs text-[var(--color-text-muted)]">{l.divergence_notes}</span></span>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        ))}

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
          {canEdit && <Button variant="ghost" onClick={remove}><Trash2 className="h-4 w-4" /> Descartar conferência</Button>}
          {rc.status === 'done' && perms.can('purchases.receive_reverse') && <Button variant="outline" disabled={busy} onClick={() => setReversing(true)}><Undo2 className="h-4 w-4" /> Estornar recebimento</Button>}
          {canEdit && <Button variant="success" disabled={busy} onClick={() => act('pur_receipt_complete', { p_id: rc.id }, 'Recebimento concluído: estoque, pedido e requisição atualizados.')}><CheckCircle2 className="h-4 w-4" /> Concluir recebimento</Button>}
        </div>
      </div>
      {reversing && (
        <ReasonDialog danger title="Estornar recebimento" confirmLabel="Estornar" description="O estoque que entrou sai de novo e o pedido volta a ficar pendente."
          onClose={() => setReversing(false)} onConfirm={async (r) => { await act('pur_receipt_reverse', { p_id: rc.id, p_reason: r }, 'Recebimento estornado.'); setReversing(false); }} />
      )}
    </Dialog>
  );
}
