import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Award, Check, Lock, Plus, ShoppingBag, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { useAuth } from '@/app/providers/AuthProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import {
  fmtDateTime, personName, purError, qtyFmt, QUOTE_STATUS, rpc,
  type PurLookups, type QuotePrice, type QuoteItem, type QuoteStatus, type QuoteSupplier, type Quotation, type TabProps,
  partyDisplay,
} from './data';
import { Field, inputCls, KV, MoneyInput, ReasonDialog, Spinner, StatusPill, SubTabs, tdCls, thCls, Trace, useOpenDoc } from './ui';
import { DataGrid, GridReset, useGrid } from '@/components/ui/GridTable';

type QuoteRow = Quotation & { pur_requisitions: { number: string | null; justification: string | null } | null };

export function QuotationsTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [status, setStatus] = useState<'' | QuoteStatus>('');
  const load = useCallback(async () => {
    let q = getSupabase().from('pur_quotations').select('*, pur_requisitions(number, justification)').order('created_at', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as QuoteRow[]);
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  const current = useOpenDoc<QuoteRow>('pur_quotations', openId, rows, '*, pur_requisitions(number, justification)');

  const grid = useGrid('megacrm_grid_pur_quote', [
    { id: 'number', label: 'Número', width: 110, sortValue: (r: QuoteRow) => r.number ?? '', render: (r: QuoteRow) => <span className="font-semibold">{r.number}</span> },
    { id: 'req', label: 'Requisição', width: 280, sortValue: (r: QuoteRow) => r.pur_requisitions?.number ?? '', render: (r: QuoteRow) => <span className="block truncate">{r.pur_requisitions?.number ?? '—'} <span className="text-xs text-[var(--color-text-muted)]">{r.pur_requisitions?.justification?.slice(0, 60)}</span></span> },
    { id: 'created', label: 'Aberta em', width: 140, sortValue: (r: QuoteRow) => r.created_at, render: (r: QuoteRow) => fmtDateTime(r.created_at) },
    { id: 'by', label: 'Por', width: 150, sortValue: (r: QuoteRow) => personName(lookups.people, r.created_by), render: (r: QuoteRow) => <span className="block truncate">{personName(lookups.people, r.created_by)}</span> },
    { id: 'total', label: 'Total vencedor', width: 130, align: 'right' as const, sortValue: (r: QuoteRow) => r.total_cents ?? -1, render: (r: QuoteRow) => <span className="tabular-nums">{r.total_cents !== null ? formatBRL(r.total_cents) : '—'}</span> },
    { id: 'status', label: 'Situação', width: 160, sortValue: (r: QuoteRow) => QUOTE_STATUS[r.status][0], render: (r: QuoteRow) => <StatusPill map={QUOTE_STATUS} status={r.status} /> },
  ], rows ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs value={status} onChange={setStatus} tabs={[['', 'Todas'], ['open', 'Abertas'], ['pending_approval', 'Aguardando alçada'], ['approved', 'Aprovadas'], ['ordered', 'Com pedido'], ['canceled', 'Canceladas']]} />
        <span className="text-xs text-[var(--color-text-muted)]">Cotações nascem de uma requisição aprovada (botão “Abrir cotação”).</span>
      </div>
      <div className="flex justify-end"><GridReset grid={grid} /></div>
      {!rows ? <Spinner /> : (
        <DataGrid grid={grid} rowKey={(r) => r.id} onRowClick={(r) => onOpen('quotation', r.id)} emptyText="Nenhuma cotação." />
      )}
      {openId && current && <QuoteDetail quote={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} />}
    </div>
  );
}

function QuoteDetail({ quote, lookups, onClose, onOpen, onChanged }: { quote: QuoteRow; lookups: PurLookups; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const { user } = useAuth();
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [sups, setSups] = useState<QuoteSupplier[]>([]);
  const [prices, setPrices] = useState<QuotePrice[]>([]);
  const [saved, setSaved] = useState<QuotePrice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState('');
  const [justify, setJustify] = useState<{ item: QuoteItem; sup: QuoteSupplier } | null>(null);
  const [reason, setReason] = useState<null | 'reopen' | 'cancel' | 'approve'>(null);
  const [tab, setTab] = useState<'mapa' | 'historico'>('mapa');
  const [busy, setBusy] = useState(false);
  const open = quote.status === 'open';
  const canEdit = open && perms.can('purchases.quote');

  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [i, s] = await Promise.all([
      sb.from('pur_quotation_items').select('*').eq('quotation_id', quote.id).order('description'),
      sb.from('pur_quotation_suppliers').select('*').eq('quotation_id', quote.id).order('created_at'),
    ]);
    const supIds = ((s.data ?? []) as QuoteSupplier[]).map((x) => x.id);
    const p = supIds.length ? await sb.from('pur_quotation_prices').select('*').in('quotation_supplier_id', supIds) : { data: [] };
    setItems((i.data ?? []) as QuoteItem[]); setSups((s.data ?? []) as QuoteSupplier[]); setPrices((p.data ?? []) as QuotePrice[]); setSaved((p.data ?? []) as QuotePrice[]); setLoaded(true);
  }, [quote.id]);
  useEffect(() => { void reload(); }, [reload, quote.status]);

  const price = (supId: string, itemId: string) => prices.find((p) => p.quotation_supplier_id === supId && p.quotation_item_id === itemId)?.unit_cents;
  const serverPrice = (supId: string, itemId: string) => saved.find((p) => p.quotation_supplier_id === supId && p.quotation_item_id === itemId)?.unit_cents;
  const valid = (s: QuoteSupplier) => s.status !== 'no_response' && s.status !== 'declined';
  const minOf = (itemId: string) => {
    const vals = sups.filter(valid).map((s) => price(s.id, itemId)).filter((v): v is number => v !== undefined);
    return vals.length ? Math.min(...vals) : undefined;
  };
  const partyName = (id: string) => partyDisplay(lookups.suppliers.find((p) => p.id === id)) || 'Fornecedor';

  const totals = useMemo(() => sups.map((s) => {
    let goods = 0; let complete = true;
    for (const it of items) { const p = price(s.id, it.id); if (p === undefined) complete = false; else goods += Math.round(Number(it.qty) * p); }
    return { id: s.id, goods, complete, total: goods + s.freight_cents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sups, items, prices]);
  const winnerTotal = useMemo(() => {
    let t = 0; const winners = new Set<string>();
    for (const it of items) { if (!it.winner_supplier_id) continue; winners.add(it.winner_supplier_id); t += Math.round(Number(it.qty) * (price(it.winner_supplier_id, it.id) ?? 0)); }
    for (const s of sups) if (winners.has(s.id)) t += s.freight_cents;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sups, prices]);

  const savePrice = async (sup: QuoteSupplier, item: QuoteItem, cents: number) => {
    const sb = getSupabase();
    const res = cents > 0
      ? await sb.from('pur_quotation_prices').upsert({ quotation_supplier_id: sup.id, quotation_item_id: item.id, unit_cents: cents }, { onConflict: 'quotation_supplier_id,quotation_item_id' })
      : await sb.from('pur_quotation_prices').delete().eq('quotation_supplier_id', sup.id).eq('quotation_item_id', item.id);
    if (res.error) toast.error(purError(res.error));
    if (cents > 0 && sup.status === 'invited') await sb.from('pur_quotation_suppliers').update({ status: 'responded' }).eq('id', sup.id);
    void reload();
  };
  const saveSup = async (sup: QuoteSupplier, patch: Partial<QuoteSupplier>) => {
    const { error } = await getSupabase().from('pur_quotation_suppliers').update(patch).eq('id', sup.id);
    if (error) toast.error(purError(error));
    void reload();
  };
  const addSup = async () => {
    if (!adding) return;
    const { error } = await getSupabase().from('pur_quotation_suppliers').insert({ quotation_id: quote.id, party_id: adding });
    if (error) toast.error(/duplicate|unique/i.test(error.message) ? 'Este fornecedor já está na cotação.' : purError(error));
    setAdding(''); void reload();
  };
  const removeSup = async (sup: QuoteSupplier) => {
    if (items.some((i) => i.winner_supplier_id === sup.id)) { toast.error('Este fornecedor é vencedor de algum item. Troque o vencedor antes.'); return; }
    const { error } = await getSupabase().from('pur_quotation_suppliers').delete().eq('id', sup.id);
    if (error) toast.error(purError(error));
    void reload();
  };
  const choose = async (item: QuoteItem, sup: QuoteSupplier, justification: string | null) => {
    try { await rpc('pur_quote_set_winner', { p_item: item.id, p_supplier: sup.id, p_justification: justification }); void reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const pick = (item: QuoteItem, sup: QuoteSupplier) => {
    const p = price(sup.id, item.id); const m = minOf(item.id);
    if (p === undefined) return;
    if (m !== undefined && p > m) setJustify({ item, sup }); else void choose(item, sup, null);
  };
  const autoBest = async () => {
    for (const it of items) {
      const m = minOf(it.id); if (m === undefined) continue;
      const best = sups.filter(valid).filter((s) => price(s.id, it.id) === m).sort((a, b) => (a.lead_time_days ?? 999) - (b.lead_time_days ?? 999))[0];
      if (best && it.winner_supplier_id !== best.id) {
        try { await rpc('pur_quote_set_winner', { p_item: it.id, p_supplier: best.id, p_justification: null }); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
      }
    }
    void reload();
  };
  const act = async (fn: string, args: Record<string, unknown>, ok: string, after?: (r: unknown) => void) => {
    setBusy(true);
    try { const r = await rpc(fn, args); toast.success(typeof ok === 'string' ? ok : ''); await onChanged(); after?.(r); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  const used = new Set(sups.map((s) => s.party_id));
  const options = lookups.suppliers.filter((p) => p.is_active && p.kind !== 'customer' && !used.has(p.id));
  const isCreator = quote.created_by === user?.id;

  return (
    <Dialog open onClose={onClose} widthClass="max-w-6xl" opaque title={`Cotação ${quote.number}`}
      description={`Requisição ${quote.pur_requisitions?.number ?? ''} · aberta por ${personName(lookups.people, quote.created_by)} em ${fmtDateTime(quote.created_at)}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><StatusPill map={QUOTE_STATUS} status={quote.status} /><Trace kind="quotation" id={quote.id} onOpen={onOpen} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <KV label="Total dos vencedores">{formatBRL(quote.total_cents ?? winnerTotal)}</KV>
          <KV label="Fornecedores">{sups.length}</KV>
          <KV label="Itens">{items.length}</KV>
          <KV label="Aprovação">{quote.approved_by ? `${personName(lookups.people, quote.approved_by)} · ${fmtDateTime(quote.approved_at)}` : '—'}</KV>
        </div>
        {quote.approval_reason && <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm">{quote.approval_reason}</p>}
        {quote.status === 'pending_approval' && (
          <p className="rounded-lg border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] p-3 text-sm">O total passou do teto aprovado na requisição. Precisa da aprovação de outra pessoa com alçada para virar pedido.</p>
        )}

        <SubTabs value={tab} onChange={setTab} tabs={[['mapa', 'Mapa comparativo'], ['historico', 'Histórico']]} />
        {tab === 'historico' && <AuditList recordIds={[quote.id, ...items.map((i) => i.id), ...sups.map((s) => s.id)]} />}
        {tab === 'mapa' && (!loaded ? <Spinner /> : (
          <>
            {canEdit && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Convidar fornecedor" htmlFor="qt-add">
                  <select id="qt-add" value={adding} onChange={(e) => setAdding(e.target.value)} className={`${inputCls} min-w-[260px]`}>
                    <option value="">Escolha…</option>
                    {options.map((p) => <option key={p.id} value={p.id}>{p.name}{p.category ? ` · ${p.category}` : ''}</option>)}
                  </select>
                </Field>
                <Button variant="outline" disabled={!adding} onClick={addSup}><Plus className="h-4 w-4" /> Adicionar</Button>
                <div className="flex-1" />
                <Button variant="outline" disabled={!sups.length} onClick={autoBest}><Wand2 className="h-4 w-4" /> Vencedor = menor preço</Button>
              </div>
            )}
            {sups.length === 0 ? <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">Convide pelo menos um fornecedor para lançar os preços.</p> : (
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
                <table className="w-full text-sm" style={{ minWidth: 320 + sups.length * 220 }}>
                  <thead>
                    <tr className="border-b border-[var(--color-border-card)] align-top">
                      <th className={`${thCls} sticky left-0 bg-[var(--color-surface)]`}>Item</th>
                      {sups.map((s) => (
                        <th key={s.id} className="min-w-[210px] border-l border-[var(--color-border-soft)] px-3 py-2 text-left">
                          <div className="flex items-start justify-between gap-1">
                            <button type="button" className="text-left text-sm font-semibold text-[var(--color-text-primary)] hover:underline" onClick={() => onOpen('supplier', s.party_id)}>{partyName(s.party_id)}</button>
                            {canEdit && <button type="button" aria-label="Tirar da cotação" onClick={() => removeSup(s)} className="text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><Trash2 className="h-3.5 w-3.5" /></button>}
                          </div>
                          <div className="mt-1 grid grid-cols-2 gap-1 text-[11px] font-normal">
                            <select disabled={!canEdit} value={s.status} onChange={(e) => saveSup(s, { status: e.target.value as QuoteSupplier['status'] })} className="col-span-2 h-7 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1">
                              <option value="invited">Convidado</option><option value="responded">Respondeu</option><option value="no_response">Sem resposta</option><option value="declined">Recusou</option>
                            </select>
                            <label className="flex items-center gap-1">Prazo
                              <input disabled={!canEdit} type="number" min={0} defaultValue={s.lead_time_days ?? ''} onBlur={(e) => saveSup(s, { lead_time_days: e.target.value === '' ? null : Number(e.target.value) })}
                                className="h-7 w-12 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1" />d</label>
                            <label className="flex items-center gap-1">Frete
                              <input disabled={!canEdit} inputMode="numeric" defaultValue={s.freight_cents ? (s.freight_cents / 100).toFixed(2).replace('.', ',') : ''}
                                onBlur={(e) => saveSup(s, { freight_cents: Math.round(Number(e.target.value.replace(/\./g, '').replace(',', '.') || 0) * 100) })}
                                className="h-7 w-16 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-right" /></label>
                            <input disabled={!canEdit} placeholder="Condição de pagto." defaultValue={s.payment_terms ?? ''} onBlur={(e) => saveSup(s, { payment_terms: e.target.value.trim() || null })}
                              className="col-span-2 h-7 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1" />
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const m = minOf(it.id);
                      return (
                        <tr key={it.id} className="border-b border-[var(--color-border-soft)] align-top">
                          <td className={`${tdCls} sticky left-0 bg-[var(--color-surface)]`}>
                            <div className="font-medium">{it.description}</div>
                            <div className="text-xs text-[var(--color-text-muted)]">{qtyFmt(it.qty)} {it.unit}</div>
                            {it.winner_justification && <div className="mt-1 text-[11px] text-[var(--inbox-warn-text,#B45309)]">Justificativa: {it.winner_justification}</div>}
                          </td>
                          {sups.map((s) => {
                            const p = price(s.id, it.id);
                            const best = p !== undefined && p === m && valid(s);
                            const win = it.winner_supplier_id === s.id;
                            return (
                              <td key={s.id} className={cn('border-l border-[var(--color-border-soft)] px-3 py-2', win && 'bg-[rgba(34,197,94,0.08)]')}>
                                {canEdit && valid(s) ? (
                                  <div onBlur={() => { const v = prices.find((x) => x.quotation_supplier_id === s.id && x.quotation_item_id === it.id)?.unit_cents ?? 0; if (v !== (serverPrice(s.id, it.id) ?? 0)) void savePrice(s, it, v); }}>
                                    <MoneyInput cents={p ?? 0} onChange={(c) => setPrices((ps) => {
                                      const rest = ps.filter((x) => !(x.quotation_supplier_id === s.id && x.quotation_item_id === it.id));
                                      return c ? [...rest, { id: 'tmp', quotation_supplier_id: s.id, quotation_item_id: it.id, unit_cents: c }] : rest;
                                    })} />
                                  </div>
                                ) : <div className="tabular-nums">{p !== undefined ? formatBRL(p) : '—'}</div>}
                                <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
                                  <span className="tabular-nums text-[var(--color-text-secondary)]">{p !== undefined ? formatBRL(Math.round(Number(it.qty) * p)) : ''}</span>
                                  {best && <span className="font-semibold text-[var(--color-success)]">menor</span>}
                                </div>
                                {win ? <div className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-success)]"><Award className="h-3.5 w-3.5" /> Vencedor</div>
                                  : canEdit && p !== undefined && valid(s) && <Button size="sm" variant="outline" className="mt-1 h-7" onClick={() => pick(it, s)}>Escolher</Button>}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    <tr className="bg-[var(--color-fill-subtle)] text-xs">
                      <td className={`${tdCls} sticky left-0 bg-[var(--color-fill-subtle)] font-semibold`}>Total se comprar tudo</td>
                      {totals.map((t) => (
                        <td key={t.id} className="border-l border-[var(--color-border-soft)] px-3 py-2 tabular-nums">
                          <div className="font-semibold">{formatBRL(t.total)}</div>
                          <div className="text-[var(--color-text-muted)]">{t.complete ? 'todos os itens' : 'faltam preços'}</div>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-right text-sm">Total com os vencedores escolhidos: <b className="tabular-nums">{formatBRL(winnerTotal)}</b></p>
          </>
        ))}

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
          {['open', 'pending_approval', 'approved'].includes(quote.status) && perms.can('purchases.cancel') && <Button variant="ghost" disabled={busy} onClick={() => setReason('cancel')}>Cancelar cotação</Button>}
          {['pending_approval', 'approved'].includes(quote.status) && perms.can('purchases.quote') && <Button variant="outline" disabled={busy} onClick={() => setReason('reopen')}>Reabrir para ajustar</Button>}
          {canEdit && <Button disabled={busy} onClick={() => act('pur_quote_close', { p_id: quote.id }, 'Cotação fechada.')}><Lock className="h-4 w-4" /> Fechar cotação</Button>}
          {quote.status === 'pending_approval' && perms.can('purchases.approve') && (isCreator
            ? <span className="self-center text-xs text-[var(--color-text-muted)]">Quem montou a cotação não aprova o estouro.</span>
            : <Button variant="success" disabled={busy} onClick={() => setReason('approve')}><Check className="h-4 w-4" /> Aprovar estouro</Button>)}
          {quote.status === 'approved' && perms.can('purchases.order') && (
            <Button disabled={busy} onClick={() => act('pur_order_from_quote', { p_quote: quote.id }, 'Pedido(s) emitido(s): um por fornecedor vencedor.', (ids) => { const a = ids as string[]; if (a?.[0]) onOpen('order', a[0]); })}>
              <ShoppingBag className="h-4 w-4" /> Emitir pedido(s)
            </Button>
          )}
        </div>
      </div>
      {justify && (
        <ReasonDialog title="Vencedor fora do menor preço" confirmLabel="Escolher mesmo assim"
          description={`${partyName(justify.sup.party_id)} não tem o menor preço para “${justify.item.description}”. Explique por que (prazo, qualidade, garantia…).`}
          onClose={() => setJustify(null)} onConfirm={async (r) => { await choose(justify.item, justify.sup, r); setJustify(null); }} />
      )}
      {reason && (
        <ReasonDialog danger={reason === 'cancel'}
          title={reason === 'cancel' ? 'Cancelar cotação' : reason === 'reopen' ? 'Reabrir cotação' : 'Aprovar estouro de alçada'}
          description={reason === 'cancel' ? 'A requisição volta para “aprovada” e pode ser cotada de novo.' : reason === 'reopen' ? 'A cotação volta a aceitar preços e vencedores.' : `Total de ${formatBRL(quote.total_cents ?? 0)}. Registre o motivo da aprovação.`}
          confirmLabel={reason === 'cancel' ? 'Cancelar cotação' : reason === 'reopen' ? 'Reabrir' : 'Aprovar'}
          onClose={() => setReason(null)}
          onConfirm={async (r) => {
            if (reason === 'cancel') await act('pur_quote_cancel', { p_id: quote.id, p_reason: r }, 'Cotação cancelada.');
            else if (reason === 'reopen') await act('pur_quote_reopen', { p_id: quote.id, p_reason: r }, 'Cotação reaberta.');
            else await act('pur_quote_approve', { p_id: quote.id, p_reason: r }, 'Estouro aprovado. Já pode emitir o pedido.');
            setReason(null);
          }} />
      )}
    </Dialog>
  );
}
