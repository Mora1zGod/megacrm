import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Boxes, Check, CheckCircle2, ChevronDown, Clock, Loader2, MoreVertical, Package, PackagePlus, Pencil, Plus, Search, Unlink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatDoc } from '../finance/SetupTab';
import { fmtDate, purError, qtyFmt, rpc, type InvItem, type Invoice, type InvoiceItem, type PurLookups, type Tone } from './data';
import { Badge, inputCls, QtyInput, Spinner } from './ui';

// ============================================================================
// Conciliação de itens da nota (botão de estoque da lista de Notas de entrada).
// Tabela dos itens da nota à esquerda (seleção, busca, ações em lote, status por linha) e, à direita,
// os detalhes da linha marcada: busca no estoque, sugestões de itens parecidos, fator, lote e
// "cadastrar novo item". Rodapé com o valor vinculado × pendente. Salvar = pur_invoice_post só estoque.
// Nota ligada a pedido/recebimento: o estoque entra pelo recebimento (não lança em dobro).
// ============================================================================
const NO_RECON = new Set(['summary', 'ignored', 'canceled_sefaz']);

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

// Parecido com a linha da nota: mesmo código de barras vence; depois palavras em comum (inclusive
// abreviação: "ACR" casa com "acrilico") e o mesmo NCM.
function similarity(it: InvoiceItem, x: InvItem): number {
  if (it.gtin && x.gtin && it.gtin === x.gtin) return 100;
  const a = tokens(`${it.description} ${it.product_code ?? ''}`);
  const b = tokens(`${x.name} ${x.code ?? ''}`);
  if (!a.length || !b.length) return 0;
  let score = 0;
  for (const t of a) {
    if (b.includes(t)) score += t.length >= 4 ? 3 : 2;
    else if (t.length >= 3 && b.some((w) => w.startsWith(t) || t.startsWith(w) && w.length >= 3)) score += 1;
  }
  if (score > 0 && it.ncm && x.ncm && it.ncm === x.ncm) score += 2;
  return score;
}

type RowState = 'posted' | 'linked' | 'pending';
const STATE: Record<RowState, [string, Tone]> = { posted: ['Lançado', 'success'], linked: ['Vinculado', 'success'], pending: ['Pendente', 'warn'] };

// Menu flutuante (portal) — não fica cortado pela rolagem da tabela.
function FloatingMenu({ anchor, onClose, children }: { anchor: DOMRect; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', onClose, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', onClose, true); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="menu" style={{ position: 'fixed', top: anchor.bottom + 4, right: Math.max(8, window.innerWidth - anchor.right) }}
      className="z-[1000] min-w-[230px] rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1 shadow-[var(--shadow-lg)]">
      {children}
    </div>,
    document.body,
  );
}
function MenuBtn({ icon, children, onClick, disabled, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)] disabled:opacity-40', danger ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]')}>
      {icon}{children}
    </button>
  );
}

function Head({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 px-4 first:pl-0', className)}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-[var(--color-text-primary)]">{children}</div>
    </div>
  );
}

export function StockReconcileDialog({ inv, lookups, statusLabel, statusTone, onClose, onOpenNote, onChanged }: {
  inv: Invoice; lookups: PurLookups; statusLabel: string; statusTone: Tone;
  onClose: () => void; onOpenNote: () => void; onChanged: () => Promise<void>;
}) {
  const perms = usePermission();
  const can = perms.can('purchases.invoice') && !NO_RECON.has(inv.status) && !inv.stock_reconciled;
  const [items, setItems] = useState<InvoiceItem[] | null>(null);
  const [viaReceipt, setViaReceipt] = useState(false);
  const [marked, setMarked] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [lineSearch, setLineSearch] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loc, setLoc] = useState('');
  const [catalog, setCatalog] = useState(lookups.items);
  const [rowMenu, setRowMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [bulkMenu, setBulkMenu] = useState<DOMRect | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [i, l] = await Promise.all([
      sb.from('pur_invoice_items').select('*').eq('invoice_id', inv.id).order('line'),
      sb.from('pur_invoice_links').select('id').eq('invoice_id', inv.id),
    ]);
    const list = (i.data ?? []) as InvoiceItem[];
    setItems(list); setViaReceipt((l.data ?? []).length > 0);
    setMarked((m) => m ?? list.find((x) => !x.item_id)?.id ?? list[0]?.id ?? null);
    const locs = [...new Set(list.map((x) => x.location_id).filter(Boolean))];
    if (locs.length === 1) setLoc((v) => v || String(locs[0]));
  }, [inv.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { setSearch(''); }, [marked]);

  const save = async (it: InvoiceItem, patch: Partial<InvoiceItem>) => {
    setBusy(it.id);
    const { error } = await getSupabase().from('pur_invoice_items').update(patch).eq('id', it.id);
    setBusy(null);
    if (error) { toast.error(purError(error)); return false; }
    setItems((cur) => cur?.map((x) => (x.id === it.id ? { ...x, ...patch } : x)) ?? cur);
    return true;
  };
  const list = useMemo(() => items ?? [], [items]);
  const nextPending = (afterId: string) => list.find((x) => x.id !== afterId && !x.item_id && !x.stock_posted);
  const linkLine = async (it: InvoiceItem, itemId: string, advance = true) => {
    if (await save(it, { item_id: itemId }) && advance) {
      const next = nextPending(it.id);
      if (next) setMarked(next.id);
    }
  };
  const createItemFor = async (it: InvoiceItem): Promise<boolean> => {
    setBusy(it.id);
    const { data, error } = await getSupabase().from('inv_items').insert({ name: it.description.slice(0, 200), unit: (it.unit ?? 'UN').toUpperCase().slice(0, 6), ncm: it.ncm, gtin: it.gtin, code: null, last_cost_cents: it.unit_cents })
      .select('id, code, name, unit, requires_lot, ncm, gtin, chart_account_id, last_cost_cents, is_active').single();
    setBusy(null);
    if (error) { toast.error(purError(error)); return false; }
    setCatalog((c) => [...c, data as InvItem]);
    return await save(it, { item_id: String((data as InvItem).id) });
  };
  const applyLoc = async (v: string) => {
    setLoc(v);
    if (!v || !items) return;
    for (const it of items.filter((x) => !x.stock_posted && x.location_id !== v)) await save(it, { location_id: v });
  };

  const active = useMemo(() => catalog.filter((i) => i.is_active), [catalog]);
  const byId = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const stateOf = (it: InvoiceItem): RowState => (it.stock_posted ? 'posted' : it.item_id ? 'linked' : 'pending');
  const sel = list.find((x) => x.id === marked) ?? null;
  const selCat = sel?.item_id ? byId.get(sel.item_id) : undefined;
  const editSel = !!sel && can && !sel.stock_posted;

  const t = norm(search.trim());
  const found = t ? active.filter((i) => norm(`${i.code ?? ''} ${i.name} ${i.gtin ?? ''}`).includes(t)).slice(0, 40) : [];
  const suggestions = useMemo(() => {
    if (!sel) return [];
    return active.map((x) => ({ x, s: similarity(sel, x) })).filter((r) => r.s > 0 && r.x.id !== sel.item_id)
      .sort((a, b) => b.s - a.s).slice(0, 4).map((r) => r.x);
  }, [sel, active]);

  const lt = norm(lineSearch.trim());
  const shownLines = lt ? list.filter((x) => norm(`${x.description} ${x.product_code ?? ''} ${x.gtin ?? ''}`).includes(lt)) : list;
  const linked = list.filter((x) => x.item_id || x.stock_posted);
  const pending = list.filter((x) => !x.item_id && !x.stock_posted);
  const sum = (xs: InvoiceItem[]) => xs.reduce((a, x) => a + x.total_cents, 0);
  const totalLines = sum(list) || 1;
  const pctCount = list.length ? Math.round((linked.length / list.length) * 100) : 0;
  // Local escolhido no topo vale para as linhas que ainda estão sem local (aplicado ao salvar).
  const missingLoc = !loc && list.some((x) => !x.stock_posted && !x.location_id);
  const missingLot = list.filter((x) => !x.stock_posted && x.item_id && byId.get(x.item_id)?.requires_lot && !x.lot);
  const ready = viaReceipt || (list.length > 0 && pending.length === 0 && !missingLoc && missingLot.length === 0);
  const why = pending.length ? `Falta vincular ${pending.length} item(ns).` : missingLoc ? 'Escolha o local de entrada.' : missingLot.length ? `Informe o lote do item ${missingLot[0].line}.` : undefined;

  const checkedRows = list.filter((x) => checked.has(x.id) && !x.stock_posted);
  const allChecked = shownLines.length > 0 && shownLines.every((x) => checked.has(x.id));
  const runBulk = async (kind: 'suggest' | 'create' | 'unlink') => {
    setBulkMenu(null);
    const rows = checkedRows.length ? checkedRows : [];
    if (!rows.length) { toast.info('Marque as linhas na caixa à esquerda.'); return; }
    let n = 0;
    for (const it of rows) {
      if (kind === 'unlink') { if (it.item_id && await save(it, { item_id: null })) n++; continue; }
      if (it.item_id) continue;
      if (kind === 'create') { if (await createItemFor(it)) n++; continue; }
      const best = active.map((x) => ({ x, s: similarity(it, x) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 5 && await save(it, { item_id: best.x.id })) n++;
    }
    toast.success(kind === 'unlink' ? `${n} linha(s) desvinculada(s).` : kind === 'create' ? `${n} item(ns) cadastrado(s) e vinculado(s).` : n ? `${n} linha(s) vinculada(s) à sugestão mais parecida.` : 'Nenhuma sugestão forte o bastante — vincule à mão.');
    setChecked(new Set());
  };

  const savePost = async () => {
    setBusy('post');
    try {
      if (loc) for (const it of list.filter((x) => !x.stock_posted && !x.location_id)) {
        const { error } = await getSupabase().from('pur_invoice_items').update({ location_id: loc }).eq('id', it.id);
        if (error) throw new Error(purError(error));
      }
      await rpc('pur_invoice_post', { p_id: inv.id, p_finance: false, p_stock: true }); toast.success('Conciliação de itens salva: entrada feita no almoxarifado.'); await onChanged(); onClose(); }
    catch (e) { toast.error('Não foi possível dar entrada', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const locations = lookups.locations.filter((l) => l.is_active && (!l.company_id || l.company_id === inv.company_id));
  const rowMenuItem = rowMenu ? list.find((x) => x.id === rowMenu.id) : null;

  return (
    <Dialog open onClose={onClose} widthClass="max-w-[min(96vw,1480px)]" opaque>
      <div className="-mx-6 -mt-6 flex items-center gap-4 px-6 pb-4 pt-6 pr-16">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><Boxes className="h-6 w-6" /></div>
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Conciliação de itens da nota</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">Vincule cada item da nota ao item do seu estoque e dê entrada no almoxarifado.</p>
        </div>
      </div>

      <div className="max-h-[72vh] space-y-4 overflow-y-auto px-0.5 pb-1">
        {/* Cabeçalho da nota */}
        <div className="grid grid-cols-2 gap-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 sm:grid-cols-4 lg:grid-cols-[auto_1.6fr_auto_auto_auto_auto_1.4fr] lg:divide-x lg:divide-[var(--color-border-soft)]">
          <Head label="Número da nota"><b>{inv.number}{inv.series ? `/${inv.series}` : ''}</b></Head>
          <Head label="Fornecedor"><b className="line-clamp-2">{inv.party_name ?? inv.supplier_name ?? '—'}</b><div className="text-xs text-[var(--color-text-muted)]">{formatDoc(inv.supplier_doc)}</div></Head>
          <Head label="Data de emissão"><b>{fmtDate(inv.issue_date)}</b></Head>
          <Head label="Valor total"><b className="tabular-nums">{formatBRL(inv.total_cents)}</b></Head>
          <Head label="Status da nota"><Badge tone={statusTone}>{statusLabel}</Badge></Head>
          <Head label="Itens na nota"><b>{list.length}</b></Head>
          <Head label="Itens conciliados">
            <span className="text-sm">{viaReceipt ? 'Pelo recebimento' : `${linked.length} / ${list.length} (${pctCount}%)`}</span>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]"><div className="h-full rounded-full bg-[var(--accent-fill)] transition-all" style={{ width: `${viaReceipt ? 100 : pctCount}%` }} /></div>
          </Head>
        </div>

        {!items ? <Spinner /> : list.length === 0 ? (
          <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">{inv.status === 'summary' ? 'Os itens aparecem depois de baixar o XML completo (abra a nota e dê ciência).' : 'Documento sem itens (entrada manual): não há estoque a conciliar.'}</p>
        ) : viaReceipt ? (
          <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">Esta nota está ligada a pedido/recebimento: o estoque entra pela conferência do recebimento. Ao salvar, o sistema só marca o estoque como conciliado — <b>não lança em dobro</b>.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            {/* Itens da nota */}
            <div className="min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-base font-semibold text-[var(--color-text-primary)]">Itens da nota ({list.length})</div>
                  <p className="text-xs text-[var(--color-text-secondary)]">Confira e vincule os itens ao seu estoque.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative block w-56"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <input value={lineSearch} onChange={(e) => setLineSearch(e.target.value)} placeholder="Buscar item da nota..." className={cn(inputCls, 'h-10 pl-9')} /></label>
                  {can && (
                    <button type="button" onClick={(e) => setBulkMenu(bulkMenu ? null : e.currentTarget.getBoundingClientRect())} aria-haspopup="menu"
                      className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
                      Ações em lote{checkedRows.length ? ` (${checkedRows.length})` : ''} <ChevronDown className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-[var(--color-text-secondary)]">Local de entrada</span>
                <select value={loc} disabled={!can} onChange={(e) => void applyLoc(e.target.value)}
                  className={cn('h-9 w-56 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-sm disabled:opacity-60', can && missingLoc ? 'border-[var(--inbox-warn-text,#B45309)]' : 'border-[var(--color-border-card)]')}>
                  <option value="">Selecione…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {can && missingLoc && <span className="text-xs text-[var(--inbox-warn-text,#B45309)]">obrigatório para dar entrada</span>}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-separate border-spacing-y-1.5 text-sm">
                  <thead className="text-left text-xs text-[var(--color-text-secondary)]">
                    <tr className="bg-[var(--color-surface-hover)]">
                      <th className="w-9 rounded-l-lg px-2 py-2.5">{can && <input type="checkbox" aria-label="Marcar todos" checked={allChecked} onChange={(e) => setChecked(e.target.checked ? new Set(shownLines.map((x) => x.id)) : new Set())} />}</th>
                      <th className="w-8 px-2 py-2.5">#</th>
                      <th className="px-2 py-2.5">Descrição do item na nota</th>
                      <th className="px-2 py-2.5">Un.</th>
                      <th className="px-2 py-2.5 text-right">Qtd. nota</th>
                      <th className="px-2 py-2.5 text-right">Valor unit.</th>
                      <th className="px-2 py-2.5 text-right">Valor total</th>
                      <th className="px-2 py-2.5">Item do estoque</th>
                      <th className="px-2 py-2.5">Status</th>
                      <th className="w-9 rounded-r-lg px-2 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {shownLines.map((it) => {
                      const cat = it.item_id ? byId.get(it.item_id) : undefined;
                      const st = stateOf(it);
                      const edit = can && !it.stock_posted;
                      const isSel = marked === it.id;
                      const cell = cn('border-y px-2 py-3 first:rounded-l-xl first:border-l last:rounded-r-xl last:border-r',
                        st === 'pending' ? 'border-[rgba(245,158,11,0.45)] bg-[rgba(245,158,11,0.07)]' : 'border-[var(--color-border-soft)] bg-[var(--color-surface)]',
                        isSel && 'border-[var(--accent-primary)]');
                      return (
                        <tr key={it.id} onClick={() => setMarked(it.id)} className="cursor-pointer align-middle">
                          <td className={cell} onClick={(e) => e.stopPropagation()}>{can && <input type="checkbox" aria-label={`Marcar linha ${it.line}`} checked={checked.has(it.id)} disabled={it.stock_posted}
                            onChange={(e) => setChecked((c) => { const n = new Set(c); if (e.target.checked) n.add(it.id); else n.delete(it.id); return n; })} />}</td>
                          <td className={cn(cell, 'text-[var(--color-text-muted)]')}>{it.line}</td>
                          <td className={cn(cell, 'max-w-[240px]')}>
                            <div className="truncate font-semibold text-[var(--color-text-primary)]" title={it.description}>{it.description}</div>
                            <div className="text-xs text-[var(--color-text-muted)]">Código: {it.product_code || '—'}</div>
                          </td>
                          <td className={cell}>{it.unit ?? '—'}</td>
                          <td className={cn(cell, 'text-right tabular-nums')}>{qtyFmt(it.qty)}</td>
                          <td className={cn(cell, 'whitespace-nowrap text-right tabular-nums')}>{formatBRL(it.unit_cents)}</td>
                          <td className={cn(cell, 'whitespace-nowrap text-right font-semibold tabular-nums')}>{formatBRL(it.total_cents)}</td>
                          <td className={cell} onClick={(e) => e.stopPropagation()}>
                            {cat ? (
                              <div className="flex w-52 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2.5 py-1.5">
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setMarked(it.id); searchRef.current?.focus(); }} disabled={!edit}>
                                  <div className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">{cat.name}</div>
                                  <div className="text-[11px] text-[var(--color-text-muted)]">Cód. EST: {cat.code || '—'}</div>
                                </button>
                                {edit && <button type="button" aria-label="Desvincular" title="Desvincular" onClick={() => void save(it, { item_id: null })} className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><X className="h-3.5 w-3.5" /></button>}
                              </div>
                            ) : edit ? (
                              <button type="button" onClick={() => { setMarked(it.id); setTimeout(() => searchRef.current?.focus(), 0); }}
                                className="flex h-10 w-52 items-center justify-between gap-2 whitespace-nowrap rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-text-muted)] hover:border-[var(--accent-primary)]">
                                Selecionar um item... <ChevronDown className="h-4 w-4" />
                              </button>
                            ) : '—'}
                          </td>
                          <td className={cell}>
                            <Badge tone={STATE[st][1]}>{st === 'pending' ? <Clock className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />} {STATE[st][0]}</Badge>
                          </td>
                          <td className={cell} onClick={(e) => e.stopPropagation()}>
                            {edit && (
                              <button type="button" aria-label={`Ações da linha ${it.line}`} aria-haspopup="menu" onClick={(e) => setRowMenu(rowMenu?.id === it.id ? null : { id: it.id, rect: e.currentTarget.getBoundingClientRect() })}
                                className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><MoreVertical className="h-4 w-4" /></button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {shownLines.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-sm text-[var(--color-text-muted)]">Nenhum item da nota com “{lineSearch}”.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Detalhes do item selecionado */}
            <div className="h-fit space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
              <div className="text-base font-semibold text-[var(--color-text-primary)]">Detalhes do item selecionado</div>
              {!sel ? <p className="text-sm text-[var(--color-text-muted)]">Clique num item da nota.</p> : (
                <>
                  <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] p-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"><Package className="h-5 w-5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 font-semibold text-[var(--color-text-primary)]">{sel.description}</div>
                      <div className="text-xs text-[var(--color-text-secondary)]">Item {sel.line} da nota</div>
                    </div>
                    <Badge tone={STATE[stateOf(sel)][1]}>{STATE[stateOf(sel)][0]}</Badge>
                  </div>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><dt className="text-[var(--color-text-secondary)]">Quantidade na nota</dt><dd className="tabular-nums">{qtyFmt(sel.qty)} {sel.unit ?? ''}</dd></div>
                    <div className="flex justify-between"><dt className="text-[var(--color-text-secondary)]">Valor unitário</dt><dd className="tabular-nums">{formatBRL(sel.unit_cents)}</dd></div>
                    <div className="flex justify-between"><dt className="text-[var(--color-text-secondary)]">Valor total</dt><dd className="font-semibold tabular-nums">{formatBRL(sel.total_cents)}</dd></div>
                    {selCat && <div className="flex justify-between gap-3"><dt className="text-[var(--color-text-secondary)]">No estoque</dt><dd className="truncate text-right">{selCat.name} ({selCat.unit})</dd></div>}
                  </dl>

                  {editSel && selCat && (
                    <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-border-soft)] pt-3 text-sm">
                      <label className="col-span-2 flex items-center justify-between gap-2">
                        <span className="text-[var(--color-text-secondary)]" title="Quantas unidades do estoque vêm em 1 unidade da nota (ex.: caixa com 12)">Fator de conversão</span>
                        <span className="w-20 [&_input]:h-9 [&_input]:w-20 [&_input]:px-2 [&_input]:text-right"><QtyInput value={Number(sel.conversion_factor)} onChange={(n) => n > 0 && void save(sel, { conversion_factor: n })} /></span>
                      </label>
                      <div className="col-span-2 text-xs text-[var(--color-text-muted)]">Entra {qtyFmt(Number(sel.qty) * Number(sel.conversion_factor))} {selCat.unit} · custo {formatBRL(Number(sel.conversion_factor) > 0 ? Math.round(sel.unit_cents / Number(sel.conversion_factor)) : sel.unit_cents)} por {selCat.unit}</div>
                      {selCat.requires_lot && (
                        <>
                          <input key={`lot-${sel.id}`} placeholder="Lote (obrigatório)" defaultValue={sel.lot ?? ''} onBlur={(e) => (e.target.value.trim() || null) !== sel.lot && void save(sel, { lot: e.target.value.trim() || null })} className={cn(inputCls, 'h-9', !sel.lot && 'border-[var(--inbox-warn-text,#B45309)]')} />
                          <input key={`exp-${sel.id}`} type="date" aria-label="Validade" defaultValue={sel.expiry ?? ''} onBlur={(e) => (e.target.value || null) !== sel.expiry && void save(sel, { expiry: e.target.value || null })} className={cn(inputCls, 'h-9')} />
                        </>
                      )}
                    </div>
                  )}

                  {editSel && (
                    <>
                      <div className="space-y-2 border-t border-[var(--color-border-soft)] pt-3">
                        <div className="font-semibold text-[var(--color-text-primary)]">{selCat ? 'Trocar o item do estoque' : 'Vincular ao item do estoque'}</div>
                        <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, código ou código de barras..." className={cn(inputCls, 'h-10 pl-9')} /></label>
                        {t && (
                          <ul className="max-h-56 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--color-border-soft)]">
                            {found.length === 0 && <li className="px-3 py-3 text-sm text-[var(--color-text-muted)]">Nenhum item encontrado.</li>}
                            {found.map((x) => <CatalogRow key={x.id} x={x} current={x.id === sel.item_id} disabled={!!busy} onPick={() => void linkLine(sel, x.id)} />)}
                          </ul>
                        )}
                      </div>
                      {!t && (
                        <div className="space-y-2">
                          <div className="font-semibold text-[var(--color-text-primary)]">Sugestões de itens semelhantes</div>
                          {suggestions.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhum item parecido no estoque. Busque acima ou cadastre um novo.</p> : (
                            <ul className="space-y-1.5">{suggestions.map((x) => <CatalogRow key={x.id} x={x} boxed disabled={!!busy} onPick={() => void linkLine(sel, x.id)} />)}</ul>
                          )}
                        </div>
                      )}
                      {!selCat && (
                        <button type="button" disabled={!!busy} onClick={async () => { if (await createItemFor(sel)) { toast.success('Item cadastrado no estoque e vinculado.'); const n = nextPending(sel.id); if (n) setMarked(n.id); } }}
                          className="flex h-11 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--accent-primary)] text-sm font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)] disabled:opacity-50">
                          {busy === sel.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Cadastrar novo item no estoque
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Rodapé */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-4">
        <div className="flex flex-wrap items-center gap-3">
          {list.length > 0 && !viaReceipt && (
            <>
              <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-[rgba(34,197,94,0.10)] px-4 py-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(34,197,94,0.18)] text-[#15803d]"><CheckCircle2 className="h-4 w-4" /></span>
                <div><div className="text-sm font-semibold text-[#15803d]">{linked.length} {linked.length === 1 ? 'item vinculado' : 'itens vinculados'}</div>
                  <div className="text-xs text-[var(--color-text-secondary)] tabular-nums">{formatBRL(sum(linked))} ({(sum(linked) / totalLines * 100).toFixed(1).replace('.', ',')}%)</div></div>
              </div>
              <div className={cn('flex items-center gap-3 rounded-[var(--radius-card)] px-4 py-2.5', pending.length ? 'bg-[rgba(245,158,11,0.10)]' : 'bg-[var(--color-surface-hover)]')}>
                <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', pending.length ? 'bg-[rgba(245,158,11,0.18)] text-[var(--inbox-warn-text,#B45309)]' : 'text-[var(--color-text-muted)]')}><Clock className="h-4 w-4" /></span>
                <div><div className={cn('text-sm font-semibold', pending.length ? 'text-[var(--inbox-warn-text,#B45309)]' : 'text-[var(--color-text-secondary)]')}>{pending.length} {pending.length === 1 ? 'item pendente' : 'itens pendentes'}</div>
                  <div className="text-xs text-[var(--color-text-secondary)] tabular-nums">{formatBRL(sum(pending))} ({(sum(pending) / totalLines * 100).toFixed(1).replace('.', ',')}%)</div></div>
              </div>
            </>
          )}
          <button type="button" onClick={onOpenNote} className="inline-flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]"><Pencil className="h-3.5 w-3.5" /> Abrir a nota</button>
        </div>
        <div className="flex items-center gap-2">
          {can && !ready && why && <span className="text-xs text-[var(--color-text-muted)]">{why}</span>}
          <Button variant="outline" className="h-11 px-6" onClick={onClose}>{can ? 'Cancelar' : 'Fechar'}</Button>
          {can && list.length > 0 && (
            <Button className="h-11 px-6" disabled={!!busy || !ready} title={why} onClick={() => void savePost()}>
              {busy === 'post' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Salvar conciliação
            </Button>
          )}
        </div>
      </div>

      {rowMenu && rowMenuItem && (
        <FloatingMenu anchor={rowMenu.rect} onClose={() => setRowMenu(null)}>
          <MenuBtn icon={<Search className="h-4 w-4" />} onClick={() => { setMarked(rowMenuItem.id); setRowMenu(null); setTimeout(() => searchRef.current?.focus(), 0); }}>{rowMenuItem.item_id ? 'Trocar o item do estoque' : 'Buscar item no estoque'}</MenuBtn>
          <MenuBtn icon={<PackagePlus className="h-4 w-4" />} disabled={!!rowMenuItem.item_id || !!busy} onClick={async () => { setRowMenu(null); if (await createItemFor(rowMenuItem)) toast.success('Item cadastrado no estoque e vinculado.'); }}>Cadastrar como item novo</MenuBtn>
          <MenuBtn icon={<Unlink className="h-4 w-4" />} danger disabled={!rowMenuItem.item_id} onClick={() => { setRowMenu(null); void save(rowMenuItem, { item_id: null }); }}>Desvincular</MenuBtn>
        </FloatingMenu>
      )}
      {bulkMenu && (
        <FloatingMenu anchor={bulkMenu} onClose={() => setBulkMenu(null)}>
          <div className="px-2.5 py-1.5 text-xs text-[var(--color-text-muted)]">{checkedRows.length ? `${checkedRows.length} linha(s) marcada(s)` : 'Marque as linhas primeiro'}</div>
          <MenuBtn icon={<CheckCircle2 className="h-4 w-4" />} disabled={!checkedRows.length || !!busy} onClick={() => void runBulk('suggest')}>Vincular à sugestão mais parecida</MenuBtn>
          <MenuBtn icon={<PackagePlus className="h-4 w-4" />} disabled={!checkedRows.length || !!busy} onClick={() => void runBulk('create')}>Cadastrar como itens novos</MenuBtn>
          <MenuBtn icon={<Unlink className="h-4 w-4" />} danger disabled={!checkedRows.length || !!busy} onClick={() => void runBulk('unlink')}>Desvincular</MenuBtn>
        </FloatingMenu>
      )}
    </Dialog>
  );
}

function CatalogRow({ x, onPick, disabled, current, boxed }: { x: InvItem; onPick: () => void; disabled?: boolean; current?: boolean; boxed?: boolean }) {
  return (
    <li className={cn('flex items-center gap-3 px-3 py-2', boxed ? 'rounded-[var(--radius-control)] border border-[var(--color-border-soft)]' : 'border-b border-[var(--color-border-soft)] last:border-0')}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"><Package className="h-4 w-4" /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">{x.name}</div>
        <div className="text-[11px] text-[var(--color-text-muted)]">Cód. EST: {x.code || '—'} · {x.unit}</div>
      </div>
      <button type="button" disabled={disabled || current} onClick={onPick}
        className="h-8 shrink-0 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 text-xs font-semibold text-[var(--accent-primary)] hover:border-[var(--accent-primary)] disabled:opacity-50">
        {current ? 'Atual' : 'Vincular'}
      </button>
    </li>
  );
}
