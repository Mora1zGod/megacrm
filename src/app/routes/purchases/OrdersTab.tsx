import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PackageCheck, Pencil, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import { formatCEP, formatDoc, formatPhone } from '@/lib/format';
import {
  fmtDate, fmtDateTime, ORDER_STATUS, purError, qtyFmt, RECEIPT_STATUS, rpc, todaySP,
  type Order, type OrderItem, type OrderStatus, type PurLookups, type Receipt, type TabProps,
  partyDisplay, upperBR,
} from './data';
import { Field, inputCls, KV, MoneyInput, QtyInput, ReasonDialog, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, Trace, useOpenDoc } from './ui';
import { DataGrid, GridReset, useGrid } from '@/components/ui/GridTable';

export function OrdersTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const perms = usePermission();
  const [rows, setRows] = useState<Order[] | null>(null);
  const [status, setStatus] = useState<'' | OrderStatus | 'open'>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    let query = getSupabase().from('pur_orders_v').select('*').order('created_at', { ascending: false }).limit(500);
    if (status === 'open') query = query.in('status', ['issued', 'partial']);
    else if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Order[]);
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  const current = useOpenDoc('pur_orders_v', openId, rows);
  const supName = useCallback((r: Order) => partyDisplay(lookups.suppliers.find((p) => p.id === r.party_id), r.party_name), [lookups.suppliers]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return !t || !rows ? rows : rows.filter((r) => [r.number, r.party_name, r.party_doc, supName(r)].some((x) => x?.toLowerCase().includes(t)));
  }, [rows, q, supName]);

  const grid = useGrid('megacrm_grid_pur_order', [
    { id: 'number', label: 'Número', width: 120, sortValue: (r: Order) => r.number ?? '', render: (r: Order) => <span className="font-semibold">{r.number ?? 'rascunho'}{r.revision > 0 && <span className="ml-1 text-xs font-normal text-[var(--color-text-muted)]">rev. {r.revision}</span>}</span> },
    { id: 'party', label: 'Fornecedor', width: 260, sortValue: (r: Order) => supName(r), render: (r: Order) => <span className="block truncate" title={r.party_name ?? ''}>{supName(r) || '—'}</span> },
    { id: 'party_legal', label: 'Razão social', width: 220, defaultHidden: true, sortValue: (r: Order) => upperBR(r.party_name), render: (r: Order) => <span className="block truncate text-[var(--color-text-secondary)]">{upperBR(r.party_name) || '—'}</span> },
    { id: 'company', label: 'Empresa', width: 120, sortValue: (r: Order) => r.company_name ?? '', render: (r: Order) => <span className="block truncate">{r.company_name}</span> },
    { id: 'issued', label: 'Emitido', width: 140, sortValue: (r: Order) => r.issued_at ?? '', render: (r: Order) => (r.issued_at ? fmtDateTime(r.issued_at) : '—') },
    { id: 'expected', label: 'Previsão', width: 105, sortValue: (r: Order) => r.expected_date ?? '', render: (r: Order) => fmtDate(r.expected_date) },
    { id: 'total', label: 'Total', width: 120, align: 'right' as const, sortValue: (r: Order) => r.total_cents, exportValue: (r: Order) => r.total_cents / 100, render: (r: Order) => <span className="tabular-nums">{formatBRL(r.total_cents)}</span> },
    { id: 'pending', label: 'Itens pendentes', width: 120, align: 'right' as const, sortValue: (r: Order) => r.pending_lines, render: (r: Order) => <span className="tabular-nums">{r.pending_lines}/{r.lines}</span> },
    { id: 'status', label: 'Situação', width: 160, sortValue: (r: Order) => ORDER_STATUS[r.status][0], render: (r: Order) => <StatusPill map={ORDER_STATUS} status={r.status} /> },
  ], filtered ?? []);
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 [&>*]:shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs value={status} onChange={setStatus} tabs={[['', 'Todos'], ['draft', 'Rascunhos'], ['open', 'A receber'], ['partial', 'Parciais'], ['received', 'Recebidos'], ['canceled', 'Cancelados']]} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar número ou fornecedor…" className={`${inputCls} max-w-xs`} aria-label="Buscar" />
        <div className="flex-1" />
        {perms.can('purchases.order') && <Button variant="outline" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Pedido avulso</Button>}
      </div>
      <div className="flex justify-end"><GridReset grid={grid} /></div>
      {!filtered ? <Spinner /> : (
        <DataGrid fill grid={grid} rowKey={(r) => r.id} onRowClick={(r) => onOpen('order', r.id)} emptyText="Nenhum pedido." />
      )}
      {creating && <OrderForm lookups={lookups} order={null} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); void load(); onOpen('order', id); }} />}
      {openId && current && !creating && <OrderDetail order={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} />}
    </div>
  );
}

interface Line { key: string; id?: string; item_id: string | null; description: string; qty: number; unit: string; unit_cents: number; received_qty: number; remove?: boolean }
const blank = (): Line => ({ key: Math.random().toString(36).slice(2), item_id: null, description: '', qty: 1, unit: 'UN', unit_cents: 0, received_qty: 0 });

function ItemsEditor({ lines, setLines, lookups }: { lines: Line[]; setLines: (fn: (l: Line[]) => Line[]) => void; lookups: PurLookups }) {
  const set = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const items = lookups.items.filter((i) => i.is_active);
  return (
    <div className="space-y-2">
      {lines.filter((l) => !l.remove).map((l, idx) => (
        <div key={l.key} className="grid items-end gap-2 rounded-lg border border-[var(--color-border-soft)] p-2 sm:grid-cols-[1fr_2fr_auto_70px_150px_auto]">
          <Field label={idx === 0 ? 'Item do catálogo' : ''} htmlFor={`oi-${l.key}`}>
            <select id={`oi-${l.key}`} value={l.item_id ?? ''} disabled={l.received_qty > 0} className={inputCls}
              onChange={(e) => { const it = items.find((x) => x.id === e.target.value); set(l.key, { item_id: it?.id ?? null, ...(it ? { description: it.name, unit: it.unit } : {}) }); }}>
              <option value="">Avulso</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.code ? `${i.code} · ` : ''}{i.name}</option>)}
            </select>
          </Field>
          <Field required={idx === 0} label={idx === 0 ? 'Descrição' : ''} htmlFor={`od-${l.key}`}><input id={`od-${l.key}`} value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} className={inputCls} /></Field>
          <Field required={idx === 0} label={idx === 0 ? 'Qtd.' : ''} htmlFor={`oq-${l.key}`}><QtyInput id={`oq-${l.key}`} value={l.qty} onChange={(n) => set(l.key, { qty: n })} /></Field>
          <Field label={idx === 0 ? 'Unid.' : ''} htmlFor={`ou-${l.key}`}><input id={`ou-${l.key}`} value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value.toUpperCase().slice(0, 6) })} className={inputCls} /></Field>
          <Field required={idx === 0} label={idx === 0 ? 'Preço (un.)' : ''} htmlFor={`op-${l.key}`}><MoneyInput id={`op-${l.key}`} cents={l.unit_cents} onChange={(c) => set(l.key, { unit_cents: c })} /></Field>
          <Button variant="ghost" size="icon" aria-label="Remover" disabled={l.received_qty > 0}
            onClick={() => setLines((ls) => (l.id ? ls.map((x) => (x.key === l.key ? { ...x, remove: true } : x)) : ls.filter((x) => x.key !== l.key)))}><Trash2 className="h-4 w-4" /></Button>
          {l.received_qty > 0 && <p className="text-[11px] text-[var(--color-text-muted)] sm:col-span-6">Já recebido: {qtyFmt(l.received_qty)} — a quantidade não pode ficar abaixo disso.</p>}
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-3.5 w-3.5" /> Adicionar item</Button>
    </div>
  );
}

function OrderForm({ lookups, order, onClose, onSaved }: { lookups: PurLookups; order: Order | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [companyId, setCompanyId] = useState(order?.company_id ?? lookups.companies.find((c) => c.is_default)?.id ?? '');
  const [partyId, setPartyId] = useState(order?.party_id ?? '');
  const [expected, setExpected] = useState(order?.expected_date ?? '');
  const [terms, setTerms] = useState(order?.payment_terms ?? '');
  const [freight, setFreight] = useState(order?.freight_cents ?? 0);
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const total = lines.filter((l) => !l.remove).reduce((s, l) => s + Math.round(l.qty * l.unit_cents), 0) + freight;
  const save = async () => {
    const live = lines.filter((l) => !l.remove);
    if (!partyId) { toast.error('Escolha o fornecedor.'); return; }
    if (!live.length || live.some((l) => l.description.trim().length < 2 || l.qty <= 0)) { toast.error('Confira a descrição e a quantidade dos itens.'); return; }
    setBusy(true);
    const sb = getSupabase();
    try {
      const { data, error } = await sb.from('pur_orders').insert({
        company_id: companyId || null, party_id: partyId, expected_date: expected || null, payment_terms: terms.trim() || null,
        freight_cents: freight, notes: notes.trim() || null,
      }).select('id').single();
      if (error) throw error;
      const { error: ie } = await sb.from('pur_order_items').insert(live.map((l) => ({ order_id: data.id, item_id: l.item_id, description: l.description.trim(), qty: l.qty, unit: l.unit || 'UN', unit_cents: l.unit_cents })));
      if (ie) throw ie;
      toast.success('Rascunho do pedido salvo. Confira e emita.');
      onSaved(data.id as string);
    } catch (e) { toast.error('Não foi possível salvar', { description: purError(e) }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque title="Pedido avulso" description="Pedido sem cotação (compra direta). Fica como rascunho até você emitir.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Empresa" required htmlFor="po-co">
          <select id="po-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            {lookups.companies.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Fornecedor" required htmlFor="po-p">
          <select id="po-p" value={partyId} onChange={(e) => setPartyId(e.target.value)} className={inputCls}>
            <option value="">Escolha…</option>
            {lookups.suppliers.filter((p) => p.is_active && p.kind !== 'customer').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Previsão de entrega" htmlFor="po-e"><input id="po-e" type="date" min={todaySP()} value={expected} onChange={(e) => setExpected(e.target.value)} className={inputCls} /></Field>
        <Field label="Condição de pagamento" htmlFor="po-t"><input id="po-t" value={terms} onChange={(e) => setTerms(e.target.value)} className={inputCls} placeholder="Ex.: 30/60 dias" /></Field>
        <Field label="Frete" htmlFor="po-f"><MoneyInput id="po-f" cents={freight} onChange={setFreight} /></Field>
        <div className="flex items-end text-sm">Total: <b className="ml-1 tabular-nums">{formatBRL(total)}</b></div>
      </div>
      <div className="mt-3"><Field label="Observações" htmlFor="po-n"><textarea id="po-n" rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 1000))} className={`${inputCls} h-auto py-2`} /></Field></div>
      <div className="mt-4"><ItemsEditor lines={lines} setLines={setLines} lookups={lookups} /></div>
      <div className="flex justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={save}>Salvar rascunho</Button>
      </div>
    </Dialog>
  );
}

function ReviseDialog({ order, items, lookups, onClose, onDone }: { order: Order; items: OrderItem[]; lookups: PurLookups; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>(items.map((i) => ({ key: i.id, id: i.id, item_id: i.item_id, description: i.description, qty: Number(i.qty), unit: i.unit, unit_cents: i.unit_cents, received_qty: Number(i.received_qty) })));
  const [freight, setFreight] = useState(order.freight_cents);
  const [expected, setExpected] = useState(order.expected_date ?? '');
  const [terms, setTerms] = useState(order.payment_terms ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque title={`Revisar pedido ${order.number}`} description="O pedido como está hoje fica guardado (antes) junto com o motivo da revisão.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Frete" htmlFor="rv-f"><MoneyInput id="rv-f" cents={freight} onChange={setFreight} /></Field>
        <Field label="Previsão" htmlFor="rv-e"><input id="rv-e" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className={inputCls} /></Field>
        <Field label="Condição de pagamento" htmlFor="rv-t"><input id="rv-t" value={terms} onChange={(e) => setTerms(e.target.value)} className={inputCls} /></Field>
      </div>
      <div className="mt-4"><ItemsEditor lines={lines} setLines={setLines} lookups={lookups} /></div>
      <div className="mt-4"><Field label="Motivo da revisão" required htmlFor="rv-r"><textarea id="rv-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 300))} className={`${inputCls} h-auto py-2`} placeholder="Ex.: fornecedor reajustou o preço" /></Field></div>
      <div className="flex justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Voltar</Button>
        <Button disabled={busy || reason.trim().length < 5} onClick={async () => {
          setBusy(true);
          try {
            const r = await rpc<number>('pur_order_revise', {
              p_id: order.id, p_reason: reason.trim(),
              p: {
                freight_cents: freight, expected_date: expected, payment_terms: terms,
                items: lines.map((l) => (l.id ? { id: l.id, remove: !!l.remove, description: l.description, qty: l.qty, unit: l.unit, unit_cents: l.unit_cents }
                  : { item_id: l.item_id, description: l.description, qty: l.qty, unit: l.unit, unit_cents: l.unit_cents })).filter((x) => !('id' in x) || true),
              },
            });
            toast.success(`Pedido revisado (revisão ${r}).`); onDone();
          } catch (e) { toast.error('Não foi possível revisar', { description: e instanceof Error ? e.message : String(e) }); }
          finally { setBusy(false); }
        }}><Pencil className="h-4 w-4" /> Salvar revisão</Button>
      </div>
    </Dialog>
  );
}

function printOrder(order: Order, items: OrderItem[], lookups: PurLookups) {
  const comp = lookups.companies.find((c) => c.id === order.company_id);
  const sup = lookups.suppliers.find((s) => s.id === order.party_id);
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const rows = items.map((i) => `<tr><td>${esc(i.description)}</td><td class="r">${qtyFmt(i.qty)} ${esc(i.unit)}</td><td class="r">${formatBRL(i.unit_cents)}</td><td class="r">${formatBRL(Math.round(Number(i.qty) * i.unit_cents))}</td></tr>`).join('');
  const addr = sup ? [sup.street, sup.street_number, sup.district, sup.city && `${sup.city}/${sup.state ?? ''}`, sup.zip_code && `CEP ${formatCEP(sup.zip_code)}`].filter(Boolean).join(', ') : '';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Pedido ${esc(order.number)}</title>
<style>body{font-family:Arial,sans-serif;color:#111;margin:32px;font-size:13px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}.r{text-align:right}.g{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}.box{border:1px solid #ccc;border-radius:6px;padding:10px}.t{font-size:15px;font-weight:bold}small{color:#555}</style></head>
<body><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><h1>Pedido de compra ${esc(order.number)}</h1><small>${order.revision ? `Revisão ${order.revision} · ` : ''}Emitido em ${esc(fmtDateTime(order.issued_at))}</small></div><div style="text-align:right"><b>${esc(comp?.name)}</b><br><small>${esc(formatDoc(comp?.cnpj ?? null))}</small></div></div>
<div class="g"><div class="box"><b>Fornecedor</b><br>${esc(sup?.name ?? order.party_name)}<br><small>${esc(formatDoc(sup?.doc ?? order.party_doc))}</small><br><small>${esc(addr)}</small><br><small>${esc([formatPhone(sup?.whatsapp || sup?.phone), sup?.email].filter(Boolean).join(' · '))}</small></div>
<div class="box"><b>Condições</b><br>Previsão de entrega: ${esc(fmtDate(order.expected_date))}<br>Pagamento: ${esc(order.payment_terms ?? '—')}<br>Frete: ${formatBRL(order.freight_cents)}</div></div>
<table><thead><tr><th>Descrição</th><th class="r">Qtd.</th><th class="r">Preço un.</th><th class="r">Total</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="3" class="r">Mercadorias</td><td class="r">${formatBRL(order.goods_cents)}</td></tr><tr><td colspan="3" class="r">Frete</td><td class="r">${formatBRL(order.freight_cents)}</td></tr><tr><td colspan="3" class="r t">Total</td><td class="r t">${formatBRL(order.total_cents)}</td></tr></tfoot></table>
${order.notes ? `<p><b>Observações:</b> ${esc(order.notes)}</p>` : ''}<p style="margin-top:48px"><small>Favor citar o número do pedido na nota fiscal.</small></p>
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast.error('O navegador bloqueou a janela de impressão. Libere pop-ups para este site.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

function OrderDetail({ order, lookups, onClose, onOpen, onChanged }: { order: Order; lookups: PurLookups; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const [items, setItems] = useState<OrderItem[] | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [revs, setRevs] = useState<Array<{ id: string; revision: number; reason: string; created_at: string; created_by: string | null }>>([]);
  const [tab, setTab] = useState<'itens' | 'recebimentos' | 'revisoes' | 'historico'>('itens');
  const [revising, setRevising] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [location, setLocation] = useState(lookups.locations.find((l) => l.is_active)?.id ?? '');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [i, r, v] = await Promise.all([
      sb.from('pur_order_items').select('*').eq('order_id', order.id).order('created_at'),
      sb.from('pur_receipts').select('*').eq('order_id', order.id).order('created_at', { ascending: false }),
      sb.from('pur_order_revisions').select('id, revision, reason, created_at, created_by').eq('order_id', order.id).order('revision', { ascending: false }),
    ]);
    setItems((i.data ?? []) as OrderItem[]); setReceipts((r.data ?? []) as Receipt[]); setRevs((v.data ?? []) as typeof revs);
  }, [order.id]);
  useEffect(() => { void reload(); }, [reload, order.status, order.revision]);

  const act = async (fn: string, args: Record<string, unknown>, ok: string, after?: (r: unknown) => void) => {
    setBusy(true);
    try { const r = await rpc(fn, args); toast.success(ok); await onChanged(); after?.(r); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    const { error } = await getSupabase().from('pur_orders').delete().eq('id', order.id);
    if (error) { toast.error(purError(error)); return; }
    toast.success('Rascunho excluído.'); onClose(); void onChanged();
  };
  const needsLocation = (items ?? []).some((i) => i.item_id && Number(i.received_qty) < Number(i.qty));

  return (
    <Dialog open onClose={onClose} widthClass="max-w-5xl" opaque title={`Pedido ${order.number ?? '(rascunho)'}${order.revision ? ` · rev. ${order.revision}` : ''}`}
      description={`${order.party_name ?? 'Sem fornecedor'} · ${order.company_name ?? ''}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><StatusPill map={ORDER_STATUS} status={order.status} /><Trace kind="order" id={order.id} onOpen={onOpen} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <KV label="Fornecedor"><button type="button" className="hover:underline" onClick={() => order.party_id && onOpen('supplier', order.party_id)}>{order.party_name}</button></KV>
          <KV label="CNPJ/CPF">{formatDoc(order.party_doc)}</KV>
          <KV label="Emitido">{order.issued_at ? fmtDateTime(order.issued_at) : '—'}</KV>
          <KV label="Previsão">{fmtDate(order.expected_date)}</KV>
          <KV label="Mercadorias">{formatBRL(order.goods_cents)}</KV>
          <KV label="Frete">{formatBRL(order.freight_cents)}</KV>
          <KV label="Total">{formatBRL(order.total_cents)}</KV>
          <KV label="Pagamento">{order.payment_terms}</KV>
        </div>
        {order.notes && <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm">{order.notes}</p>}
        {order.cancel_reason && <p className="rounded-lg border border-[rgba(239,68,68,0.3)] p-3 text-sm"><b>Cancelado:</b> {order.cancel_reason}</p>}

        <SubTabs value={tab} onChange={setTab} tabs={[['itens', 'Itens'], ['recebimentos', `Recebimentos (${receipts.length})`], ['revisoes', `Revisões (${revs.length})`], ['historico', 'Histórico']]} />
        {tab === 'itens' && (!items ? <Spinner /> : (
          <TableWrap minWidth={640}>
            <thead><tr className="border-b border-[var(--color-border-card)]">
              <th className={thCls}>Descrição</th><th className={`${thCls} text-right`}>Qtd.</th><th className={`${thCls} text-right`}>Preço</th>
              <th className={`${thCls} text-right`}>Total</th><th className={`${thCls} text-right`}>Recebido</th><th className={`${thCls} text-right`}>Falta</th>
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className={tdCls}>{i.description}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(i.qty)} {i.unit}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.unit_cents)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(Math.round(Number(i.qty) * i.unit_cents))}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(i.received_qty)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(Math.max(Number(i.qty) - Number(i.received_qty), 0))}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ))}
        {tab === 'recebimentos' && (receipts.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhum recebimento ainda.</p> : (
          <ul className="space-y-1">
            {receipts.map((r) => (
              <li key={r.id}><button type="button" onClick={() => onOpen('receipt', r.id)} className="flex w-full items-center justify-between rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]">
                <span className="font-semibold">{r.number}</span><span>{fmtDate(r.received_date)}</span><StatusPill map={RECEIPT_STATUS} status={r.status} />
              </button></li>
            ))}
          </ul>
        ))}
        {tab === 'revisoes' && (revs.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Sem revisões.</p> : (
          <ul className="space-y-1 text-sm">
            {revs.map((r) => <li key={r.id} className="rounded-lg border border-[var(--color-border-soft)] px-3 py-2"><b>Revisão {r.revision}</b> · {fmtDateTime(r.created_at)} · {lookups.people.get(r.created_by ?? '') ?? 'usuário'}<br /><span className="text-[var(--color-text-secondary)]">{r.reason}</span></li>)}
          </ul>
        ))}
        {tab === 'historico' && <AuditList recordIds={[order.id, ...(items ?? []).map((i) => i.id)]} />}

        <div className="flex flex-wrap items-end justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
          {order.status === 'draft' && perms.can('purchases.order') && <Button variant="ghost" onClick={remove}><Trash2 className="h-4 w-4" /> Excluir rascunho</Button>}
          {['issued', 'partial'].includes(order.status) && perms.can('purchases.cancel') && <Button variant="ghost" disabled={busy} onClick={() => setCanceling(true)}>Cancelar pedido</Button>}
          {order.status !== 'draft' && <Button variant="outline" disabled={!items} onClick={() => items && printOrder(order, items, lookups)}><Printer className="h-4 w-4" /> Imprimir / PDF</Button>}
          {['issued', 'partial'].includes(order.status) && perms.can('purchases.order') && <Button variant="outline" disabled={!items} onClick={() => setRevising(true)}><Pencil className="h-4 w-4" /> Revisar</Button>}
          {order.status === 'draft' && perms.can('purchases.order') && <Button disabled={busy} onClick={() => act('pur_order_issue', { p_id: order.id }, 'Pedido emitido.')}><Send className="h-4 w-4" /> Emitir pedido</Button>}
          {['issued', 'partial'].includes(order.status) && perms.can('purchases.receive') && (<>
            {needsLocation && (
              <Field label="Entrar no estoque em" htmlFor="od-loc">
                <select id="od-loc" value={location} onChange={(e) => setLocation(e.target.value)} className={`${inputCls} min-w-[180px]`}>
                  <option value="">Escolha…</option>
                  {lookups.locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            <Button disabled={busy} onClick={() => act('pur_receipt_create', { p_order: order.id, p_location: location || null }, 'Conferência aberta.', (id) => onOpen('receipt', String(id)))}><PackageCheck className="h-4 w-4" /> Receber</Button>
          </>)}
        </div>
      </div>
      {revising && items && <ReviseDialog order={order} items={items} lookups={lookups} onClose={() => setRevising(false)} onDone={() => { setRevising(false); void onChanged(); void reload(); }} />}
      {canceling && (
        <ReasonDialog danger title="Cancelar pedido" confirmLabel="Cancelar pedido" description="O que estava pedido volta para a requisição (pode cotar de novo)."
          onClose={() => setCanceling(false)} onConfirm={async (r) => { await act('pur_order_cancel', { p_id: order.id, p_reason: r }, 'Pedido cancelado.'); setCanceling(false); }} />
      )}
    </Dialog>
  );
}
