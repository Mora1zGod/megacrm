import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';
import { Ban, CloudDownload, KeyRound, Download, Eye, FilePlus2, FileUp, Link2, Loader2, PackagePlus, RotateCcw, Trash2, Unlink, Wallet, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import { formatDoc } from '../finance/SetupTab';
import { STATUS_LABEL, type InstallmentRow } from '../finance/data';
import { StatusBadge } from '../finance/ui';
import {
  addDays, DOC_TYPE, fmtDate, fmtDateTime, INVOICE_STATUS, monthStart, purError, qtyFmt, rpc, sefazApi, SOURCE, todaySP,
  type Invoice, type InvoiceItem, type InvoiceStatus, type PurLookups, type TabProps,
} from './data';
import { Badge, Card, EmptyRow, Field, inputCls, KV, Metric, MoneyInput, QtyInput, ReasonDialog, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, Trace, useDebounced, useOpenDoc } from './ui';
import { ChartPicker } from '../finance/ui';

interface Summary { count: number; total_cents: number; prev_total_cents: number; fin_pending_count: number; fin_pending_cents: number; stock_pending_count: number; stock_pending_cents: number; summary_count: number }
type Quick = '' | 'fin' | 'stock' | 'summary';

export function InvoicesTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const perms = usePermission();
  const [from, setFrom] = useState(monthStart(addDays(todaySP(), -60)));
  const [to, setTo] = useState(todaySP());
  const [by, setBy] = useState<'entry' | 'issue' | 'created'>('entry');
  const [companyId, setCompanyId] = useState('');
  const [status, setStatus] = useState<'' | InvoiceStatus>('');
  const [source, setSource] = useState('');
  const [quick, setQuick] = useState<Quick>('');
  const [text, setText] = useState('');
  const q = useDebounced(text);
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [manual, setManual] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncCompany, setSyncCompany] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [, setParams] = useSearchParams();
  const [certInfo, setCertInfo] = useState<{ any: boolean; loaded: boolean }>({ any: true, loaded: false });
  useEffect(() => {
    if (!perms.can('purchases.invoice')) return;
    sefazApi<{ companies: Array<{ has_cert: boolean }> }>('cert_status')
      .then((r) => setCertInfo({ any: r.companies.some((c) => c.has_cert), loaded: true }))
      .catch(() => setCertInfo({ any: true, loaded: true }));
  }, [perms]);
  const goCert = () => setParams((p) => { p.set('tab', 'config'); p.delete('doc'); return p; });

  const load = useCallback(async () => {
    const col = by === 'issue' ? 'issue_date' : by === 'created' ? 'created_at' : 'effective_date';
    let query = getSupabase().from('pur_invoices_v').select('*').order(col, { ascending: false, nullsFirst: false }).limit(1000);
    query = by === 'created' ? query.gte('created_at', `${from}T00:00:00-03:00`).lte('created_at', `${to}T23:59:59-03:00`) : query.gte(col, from).lte(col, to);
    if (companyId) query = query.eq('company_id', companyId);
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (quick === 'fin') query = query.eq('fin_reconciled', false).not('status', 'in', '(summary,ignored,canceled_sefaz)');
    if (quick === 'stock') query = query.eq('stock_reconciled', false).not('status', 'in', '(summary,ignored,canceled_sefaz)');
    if (quick === 'summary') query = query.eq('status', 'summary');
    const t = q.trim().replace(/[,()]/g, ' ');
    if (t) {
      const d = t.replace(/\D/g, '');
      query = query.or([`number.ilike.%${t}%`, `supplier_name.ilike.%${t}%`, `party_name.ilike.%${t}%`, d.length >= 4 ? `access_key.ilike.%${d}%` : '', d.length >= 4 ? `supplier_doc.ilike.%${d}%` : ''].filter(Boolean).join(','));
    }
    const [{ data, error }, s] = await Promise.all([query, rpc<Summary>('pur_invoice_summary', { p_from: from, p_to: to, p_by: by }).catch(() => null)]);
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Invoice[]); setSum(s);
  }, [from, to, by, companyId, status, source, quick, q]);
  useEffect(() => { void load(); }, [load]);
  const current = useOpenDoc('pur_invoices_v', openId, rows);

  const syncSefaz = async () => {
    const cid = syncCompany || lookups.companies.find((c) => c.is_default)?.id;
    if (!cid) return;
    setSyncing(true);
    try { const r = await sefazApi<{ message: string }>('sync', { company_id: cid }); toast.success(r.message); void load(); }
    catch (e) { toast.error('Busca na SEFAZ', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setSyncing(false); }
  };
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        const xml = await f.text();
        const r = await sefazApi<{ id: string; number: string; supplier: string }>('import_xml', { xml });
        ok++;
        if (files.length === 1) { toast.success(`Nota ${r.number} importada (${r.supplier}).`); onOpen('invoice', r.id); }
      } catch (e) { toast.error(`${f.name}`, { description: e instanceof Error ? e.message : String(e) }); }
    }
    if (files.length > 1) toast.success(`${ok} de ${files.length} XML importado(s).`);
    if (fileRef.current) fileRef.current.value = '';
    void load();
  };

  const diff = sum && sum.prev_total_cents ? Math.round(((sum.total_cents - sum.prev_total_cents) / sum.prev_total_cents) * 100) : null;
  const card = (k: Quick, label: string, value: React.ReactNode, hint: React.ReactNode, tone?: 'error' | 'warn') => (
    <button type="button" onClick={() => setQuick(quick === k ? '' : k)} aria-pressed={quick === k}
      className={cn('rounded-[var(--radius-card)] text-left ring-[var(--accent-primary)]', quick === k && 'ring-1')}>
      <Metric label={label} value={value} hint={hint} tone={tone} />
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {card('', 'Notas no período', sum ? formatBRL(sum.total_cents) : '—', sum ? `${sum.count} nota(s)${diff !== null ? ` · ${diff >= 0 ? '+' : ''}${diff}% vs. período anterior` : ''}` : '')}
        {card('fin', 'Falta conciliar no Financeiro', sum ? formatBRL(sum.fin_pending_cents) : '—', sum ? `${sum.fin_pending_count} nota(s)` : '', sum?.fin_pending_count ? 'warn' : undefined)}
        {card('stock', 'Falta dar entrada no estoque', sum ? formatBRL(sum.stock_pending_cents) : '—', sum ? `${sum.stock_pending_count} nota(s)` : '', sum?.stock_pending_count ? 'warn' : undefined)}
        {card('summary', 'Resumos da SEFAZ', sum ? String(sum.summary_count) : '—', 'precisam de ciência para baixar o XML', sum?.summary_count ? 'error' : undefined)}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Período por" htmlFor="nf-by">
          <select id="nf-by" value={by} onChange={(e) => setBy(e.target.value as typeof by)} className={inputCls}>
            <option value="entry">Data de entrada</option><option value="issue">Data de emissão</option><option value="created">Data de cadastro</option>
          </select>
        </Field>
        <Field label="De" htmlFor="nf-from"><input id="nf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} /></Field>
        <Field label="Até" htmlFor="nf-to"><input id="nf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} /></Field>
        <Field label="Empresa" htmlFor="nf-co">
          <select id="nf-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            <option value="">Todas</option>{lookups.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Situação" htmlFor="nf-st">
          <select id="nf-st" value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className={inputCls}>
            <option value="">Todas</option>{Object.entries(INVOICE_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Origem" htmlFor="nf-src">
          <select id="nf-src" value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
            <option value="">Todas</option>{Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Buscar" htmlFor="nf-q"><input id="nf-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Número, fornecedor, CNPJ, chave" className={`${inputCls} min-w-[220px]`} /></Field>
      </div>

      {certInfo.loaded && !certInfo.any && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] p-3 text-sm">
          <span className="flex items-center gap-2"><KeyRound className="h-4 w-4 shrink-0" /> Para puxar as notas da SEFAZ automaticamente, envie o <b>certificado digital A1</b> (.pfx) da empresa.</span>
          {perms.can('purchases.setup') ? <Button size="sm" onClick={goCert}><KeyRound className="h-4 w-4" /> Enviar certificado</Button>
            : <span className="text-xs text-[var(--color-text-muted)]">Peça a quem configura Compras.</span>}
        </div>
      )}

      {perms.can('purchases.invoice') && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56"><select value={syncCompany} onChange={(e) => setSyncCompany(e.target.value)} className={inputCls} aria-label="Empresa para buscar na SEFAZ">
            {lookups.companies.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
          <Button variant="outline" disabled={syncing} onClick={syncSefaz}>{syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />} Buscar na SEFAZ</Button>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" multiple hidden onChange={(e) => importFiles(e.target.files)} />
          <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Importar XML</Button>
          <Button variant="outline" onClick={() => setManual(true)}><FilePlus2 className="h-4 w-4" /> Lançamento manual</Button>
          {perms.can('purchases.setup') && <Button variant="ghost" onClick={goCert}><KeyRound className="h-4 w-4" /> Certificado digital</Button>}
        </div>
      )}

      {!rows ? <Spinner /> : (
        <TableWrap minWidth={1200}>
          <thead><tr className="border-b border-[var(--color-border-card)]">
            <th className={thCls}>Nº / série</th><th className={thCls}>Fornecedor</th><th className={thCls}>Empresa</th><th className={thCls}>Emissão</th>
            <th className={thCls}>Entrada</th><th className={`${thCls} text-right`}>Valor</th><th className={thCls}>Origem</th><th className={thCls}>Financeiro</th>
            <th className={thCls}>Estoque</th><th className={thCls}>Situação</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <EmptyRow cols={10} text="Nenhuma nota com esses filtros." />}
            {rows.map((n) => (
              <tr key={n.id} onClick={() => onOpen('invoice', n.id)} className="cursor-pointer border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]">
                <td className={`${tdCls} font-semibold`}>{n.doc_type !== 'nfe' && <span className="mr-1 text-xs text-[var(--color-text-muted)]">{DOC_TYPE[n.doc_type]}</span>}{n.number}{n.series ? `/${n.series}` : ''}</td>
                <td className={tdCls}><div className="max-w-[260px] truncate">{n.party_name ?? n.supplier_name ?? '—'}</div><div className="text-xs text-[var(--color-text-muted)]">{formatDoc(n.supplier_doc)}</div></td>
                <td className={tdCls}>{n.company_name}</td>
                <td className={tdCls}>{fmtDate(n.issue_date)}</td>
                <td className={tdCls}>{fmtDate(n.entry_date)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(n.total_cents)}</td>
                <td className={tdCls}>{SOURCE[n.source]}</td>
                <td className={tdCls}>{n.status === 'summary' || n.status === 'ignored' || n.status === 'canceled_sefaz' ? '—' : n.fin_reconciled ? <Badge tone="success">Conciliado{n.fin_diff_accepted ? ' (dif.)' : ''}</Badge> : <Badge tone="warn">Pendente</Badge>}</td>
                <td className={tdCls}>{n.status === 'summary' || n.status === 'ignored' || n.status === 'canceled_sefaz' ? '—' : n.stock_reconciled ? <Badge tone="success">Lançado</Badge> : <Badge tone="warn">Pendente</Badge>}</td>
                <td className={tdCls}><StatusPill map={INVOICE_STATUS} status={n.status} />{n.sefaz_situation === 'cancelada' && n.status !== 'canceled_sefaz' && <span className="ml-1"><Badge tone="error">cancelada na SEFAZ!</Badge></span>}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {manual && <ManualDialog lookups={lookups} onClose={() => setManual(false)} onSaved={(id) => { setManual(false); void load(); onOpen('invoice', id); }} />}
      {openId && current && <InvoiceDetail inv={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} />}
    </div>
  );
}

function ManualDialog({ lookups, onClose, onSaved }: { lookups: PurLookups; onClose: () => void; onSaved: (id: string) => void }) {
  const [docType, setDocType] = useState('recibo');
  const [number, setNumber] = useState('');
  const [partyId, setPartyId] = useState('');
  const [companyId, setCompanyId] = useState(lookups.companies.find((c) => c.is_default)?.id ?? '');
  const [issue, setIssue] = useState(todaySP());
  const [due, setDue] = useState('');
  const [total, setTotal] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} widthClass="max-w-2xl" opaque title="Lançamento manual" description="Para recibo, boleto, contrato ou nota que não veio por XML. O motivo é obrigatório e fica registrado.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo de documento" required htmlFor="mn-t">
          <select id="mn-t" value={docType} onChange={(e) => setDocType(e.target.value)} className={inputCls}>{Object.entries(DOC_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Número" required htmlFor="mn-n"><input id="mn-n" value={number} onChange={(e) => setNumber(e.target.value.slice(0, 40))} className={inputCls} /></Field>
        <Field label="Fornecedor" required htmlFor="mn-p">
          <select id="mn-p" value={partyId} onChange={(e) => setPartyId(e.target.value)} className={inputCls}>
            <option value="">Escolha…</option>{lookups.suppliers.filter((p) => p.is_active && p.kind !== 'customer').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Empresa" required htmlFor="mn-c">
          <select id="mn-c" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>{lookups.companies.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </Field>
        <Field label="Emissão" required htmlFor="mn-i"><input id="mn-i" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className={inputCls} /></Field>
        <Field label="Vencimento" htmlFor="mn-d"><input id="mn-d" type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} /></Field>
        <Field label="Valor" required htmlFor="mn-v"><MoneyInput id="mn-v" cents={total} onChange={setTotal} /></Field>
      </div>
      <div className="mt-3"><Field label="Motivo da entrada manual" required htmlFor="mn-r"><textarea id="mn-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} className={`${inputCls} h-auto py-2`} placeholder="Ex.: prestador sem nota fiscal" /></Field></div>
      <div className="flex justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const id = await rpc<string>('pur_invoice_manual', { p: { doc_type: docType, number, party_id: partyId || null, company_id: companyId || null, issue_date: issue, due_date: due || null, total_cents: total, manual_reason: reason } });
            toast.success('Documento lançado.'); onSaved(id);
          } catch (e) { toast.error('Não foi possível lançar', { description: e instanceof Error ? e.message : String(e) }); }
          finally { setBusy(false); }
        }}>Lançar</Button>
      </div>
    </Dialog>
  );
}

interface Link { id: string; order_id: string | null; receipt_id: string | null; pur_orders: { number: string | null } | null; pur_receipts: { number: string | null } | null }
interface Suggestion { order_id: string; number: string; party_name: string; total_cents: number; status: string; score: number }
interface Candidate { entry_id: string; description: string; party_name: string | null; total_cents: number; competence_date: string; first_due: string | null; score: number }

function InvoiceDetail({ inv, lookups, onClose, onOpen, onChanged }: { inv: Invoice; lookups: PurLookups; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const can = perms.can('purchases.invoice');
  const [tab, setTab] = useState<'resumo' | 'estoque' | 'pagamentos' | 'historico'>('resumo');
  const [items, setItems] = useState<InvoiceItem[] | null>(null);
  const [dues, setDues] = useState<Array<{ id: string; number: string | null; due_date: string; amount_cents: number }>>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<null | 'ignore' | 'cancel'>(null);
  const closed = inv.status === 'ignored' || inv.status === 'canceled_sefaz';

  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [i, d, l] = await Promise.all([
      sb.from('pur_invoice_items').select('*').eq('invoice_id', inv.id).order('line'),
      sb.from('pur_invoice_dues').select('*').eq('invoice_id', inv.id).order('due_date'),
      sb.from('pur_invoice_links').select('*, pur_orders(number), pur_receipts(number)').eq('invoice_id', inv.id),
    ]);
    setItems((i.data ?? []) as InvoiceItem[]); setDues((d.data ?? []) as typeof dues); setLinks((l.data ?? []) as Link[]);
    if (!inv.stock_reconciled && !closed) rpc<Suggestion[]>('pur_invoice_suggest_orders', { p_id: inv.id }).then(setSugs).catch(() => setSugs([]));
  }, [inv.id, inv.stock_reconciled, closed]);
  useEffect(() => { void reload(); }, [reload, inv.status, inv.fin_entry_id]);

  const act = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await rpc(fn, args); toast.success(ok); await onChanged(); void reload(); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const sefaz = async (action: 'manifest' | 'fetch_by_key') => {
    setBusy(true);
    try { const r = await sefazApi<{ message: string }>(action, { invoice_id: inv.id }); toast.success(r.message); await onChanged(); void reload(); }
    catch (e) { toast.error('SEFAZ', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const downloadXml = async () => {
    if (!inv.xml_path) return;
    const { data, error } = await getSupabase().storage.from('whatsapp-hub-purchases').createSignedUrl(inv.xml_path, 120, { download: `NFe-${inv.access_key ?? inv.number}.xml` });
    if (error || !data) { toast.error('Não foi possível baixar o XML.'); return; }
    window.open(data.signedUrl, '_blank');
  };
  const remove = async () => {
    const { error } = await getSupabase().from('pur_invoices').delete().eq('id', inv.id);
    if (error) { toast.error(purError(error)); return; }
    toast.success('Nota excluída.'); onClose(); void onChanged();
  };
  const viaReceipt = links.length > 0;

  return (
    <Dialog open onClose={onClose} widthClass="max-w-6xl" opaque title={`${DOC_TYPE[inv.doc_type] ?? 'Nota'} ${inv.number}${inv.series ? `/${inv.series}` : ''}`}
      description={`${inv.party_name ?? inv.supplier_name ?? ''} · ${formatBRL(inv.total_cents)} · ${SOURCE[inv.source]}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill map={INVOICE_STATUS} status={inv.status} />
          {inv.sefaz_situation && <Badge tone={inv.sefaz_situation === 'cancelada' ? 'error' : 'muted'}>SEFAZ: {inv.sefaz_situation}</Badge>}
          <Trace kind="invoice" id={inv.id} onOpen={onOpen} />
        </div>
        {inv.sefaz_situation === 'cancelada' && inv.status !== 'canceled_sefaz' && (
          <p className="rounded-lg border border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">O emitente cancelou esta nota na SEFAZ, mas ela já tem lançamento. Cancele a conta a pagar no Financeiro e marque a nota como cancelada.</p>
        )}
        <SubTabs value={tab} onChange={setTab} tabs={[['resumo', 'Resumo'], ['estoque', 'Itens e estoque'], ['pagamentos', 'Pagamentos'], ['historico', 'Histórico']]} />

        {tab === 'resumo' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <KV label="Fornecedor"><button type="button" className="hover:underline" onClick={() => inv.party_id && onOpen('supplier', inv.party_id)}>{inv.party_name ?? inv.supplier_name}</button></KV>
              <KV label="CNPJ/CPF">{formatDoc(inv.supplier_doc)}</KV>
              <KV label="Empresa">{inv.company_name}</KV>
              <KV label="Emissão">{fmtDate(inv.issue_date)}</KV>
              <KV label="Produtos">{inv.products_cents !== null ? formatBRL(inv.products_cents) : '—'}</KV>
              <KV label="Frete">{inv.freight_cents !== null ? formatBRL(inv.freight_cents) : '—'}</KV>
              <KV label="Desconto">{inv.discount_cents !== null ? formatBRL(inv.discount_cents) : '—'}</KV>
              <KV label="Total">{formatBRL(inv.total_cents)}</KV>
              <KV label="Cadastrada">{fmtDateTime(inv.created_at)}</KV>
              <KV label="Ciência SEFAZ">{inv.manifested_at ? fmtDateTime(inv.manifested_at) : '—'}</KV>
              <KV label="Lançada">{inv.posted_at ? fmtDateTime(inv.posted_at) : '—'}</KV>
              {can && !closed && inv.status !== 'posted' ? (
                <Field label="Data de entrada" htmlFor="nf-ed">
                  <input id="nf-ed" type="date" defaultValue={inv.entry_date ?? ''} className={inputCls}
                    onBlur={(e) => e.target.value !== (inv.entry_date ?? '') && act('pur_invoice_set', { p_id: inv.id, p: { entry_date: e.target.value } }, 'Data de entrada salva.')} />
                </Field>
              ) : <KV label="Entrada">{fmtDate(inv.entry_date)}</KV>}
            </div>
            {inv.access_key && <p className="break-all font-mono text-xs text-[var(--color-text-secondary)]">Chave: {inv.access_key.replace(/(\d{4})/g, '$1 ').trim()}</p>}
            {inv.manual_reason && <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm"><b>Entrada manual:</b> {inv.manual_reason}</p>}
            {inv.ignored_reason && <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm"><b>Ignorada:</b> {inv.ignored_reason}</p>}
            {inv.status === 'summary' && (
              <p className="rounded-lg border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] p-3 text-sm">A SEFAZ mandou só o resumo. Para ver os itens e lançar, dê <b>ciência da operação</b>: o sistema registra na SEFAZ e baixa o XML completo.</p>
            )}

            <Card title="Pedido / recebimento" actions={null}>
              {links.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Sem vínculo. Notas sem pedido dão entrada no estoque pela própria nota (aba Itens e estoque).</p> : (
                <ul className="flex flex-wrap gap-2">
                  {links.map((l) => (
                    <li key={l.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-card)] px-2 py-0.5 text-sm">
                      <button type="button" className="hover:underline" onClick={() => l.order_id ? onOpen('order', l.order_id) : l.receipt_id && onOpen('receipt', l.receipt_id)}>
                        {l.order_id ? `Pedido ${l.pur_orders?.number ?? ''}` : `Recebimento ${l.pur_receipts?.number ?? ''}`}
                      </button>
                      {can && !inv.stock_reconciled && <button type="button" aria-label="Desvincular" onClick={() => act('pur_invoice_link', { p_id: inv.id, p_order: l.order_id, p_receipt: l.receipt_id, p_remove: true }, 'Vínculo removido.')} className="text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><Unlink className="h-3.5 w-3.5" /></button>}
                    </li>
                  ))}
                </ul>
              )}
              {can && !inv.stock_reconciled && !closed && sugs.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-semibold text-[var(--color-text-secondary)]">Pedidos prováveis</div>
                  <ul className="space-y-1">
                    {sugs.map((s) => (
                      <li key={s.order_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border-soft)] px-3 py-1.5 text-sm">
                        <span><b>{s.number}</b> · {s.party_name} · {formatBRL(s.total_cents)} <span className="text-xs text-[var(--color-text-muted)]">({s.score}% de chance)</span></span>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => act('pur_invoice_link', { p_id: inv.id, p_order: s.order_id, p_receipt: null }, 'Pedido vinculado.')}><Link2 className="h-3.5 w-3.5" /> Vincular</Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'estoque' && <StockTab inv={inv} items={items} lookups={lookups} viaReceipt={viaReceipt} canEdit={can && !closed && !inv.stock_reconciled} onSaved={reload} />}
        {tab === 'pagamentos' && <PaymentsTab inv={inv} dues={dues} lookups={lookups} canEdit={can && !closed} onDone={async () => { await onChanged(); void reload(); }} />}
        {tab === 'historico' && <AuditList recordIds={[inv.id, ...(items ?? []).map((i) => i.id), ...dues.map((d) => d.id), ...links.map((l) => l.id)]} />}

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
          {can && !inv.fin_entry_id && !inv.stock_reconciled && inv.status !== 'posted' && <Button variant="ghost" disabled={busy} onClick={remove}><Trash2 className="h-4 w-4" /> Excluir</Button>}
          {can && inv.status !== 'posted' && !closed && <Button variant="ghost" disabled={busy} onClick={() => setReason('ignore')}><Ban className="h-4 w-4" /> Ignorar</Button>}
          {can && inv.status === 'ignored' && <Button variant="outline" disabled={busy} onClick={() => act('pur_invoice_unignore', { p_id: inv.id }, 'Nota reativada.')}><RotateCcw className="h-4 w-4" /> Reativar</Button>}
          {can && inv.status !== 'canceled_sefaz' && <Button variant="ghost" disabled={busy} onClick={() => setReason('cancel')}><XCircle className="h-4 w-4" /> Cancelada na SEFAZ</Button>}
          {inv.xml_path && <Button variant="outline" onClick={downloadXml}><Download className="h-4 w-4" /> Baixar XML</Button>}
          {can && inv.status === 'summary' && <Button disabled={busy} onClick={() => sefaz('manifest')}><Eye className="h-4 w-4" /> Dar ciência e baixar XML</Button>}
          {can && inv.status === 'summary' && inv.manifested_at && <Button variant="outline" disabled={busy} onClick={() => sefaz('fetch_by_key')}><CloudDownload className="h-4 w-4" /> Tentar baixar de novo</Button>}
          {can && !closed && inv.status !== 'summary' && (!inv.fin_reconciled || !inv.stock_reconciled) && (
            <PostButtons inv={inv} busy={busy} onPost={(fin, stock) => act('pur_invoice_post', { p_id: inv.id, p_finance: fin, p_stock: stock }, fin && stock ? 'Nota lançada no Financeiro e no Estoque.' : fin ? 'Nota lançada no Financeiro.' : 'Nota lançada no Estoque.')} />
          )}
        </div>
      </div>
      {reason && (
        <ReasonDialog danger={reason === 'cancel'} title={reason === 'ignore' ? 'Ignorar nota' : 'Marcar como cancelada na SEFAZ'}
          description={reason === 'ignore' ? 'A nota sai das pendências (fica guardada). Use para notas que não são compras da empresa.' : 'O registro é preservado; só muda a situação.'}
          confirmLabel={reason === 'ignore' ? 'Ignorar' : 'Marcar cancelada'} onClose={() => setReason(null)}
          onConfirm={async (r) => {
            await act(reason === 'ignore' ? 'pur_invoice_ignore' : 'pur_invoice_mark_canceled', { p_id: inv.id, p_reason: r }, reason === 'ignore' ? 'Nota ignorada.' : 'Nota marcada como cancelada.');
            setReason(null);
          }} />
      )}
    </Dialog>
  );
}

function PostButtons({ inv, busy, onPost }: { inv: Invoice; busy: boolean; onPost: (fin: boolean, stock: boolean) => void }) {
  const needFin = !inv.fin_reconciled || inv.status !== 'posted';
  return (
    <>
      {!inv.stock_reconciled && <Button variant="outline" disabled={busy} onClick={() => onPost(false, true)}>Lançar só no Estoque</Button>}
      {needFin && inv.fin_entry_id && <Button variant="outline" disabled={busy} onClick={() => onPost(true, false)}>Lançar só no Financeiro</Button>}
      <Button disabled={busy || !inv.fin_entry_id} title={inv.fin_entry_id ? undefined : 'Faça a conciliação financeira antes (aba Pagamentos).'} onClick={() => onPost(true, !inv.stock_reconciled)}>
        <Wallet className="h-4 w-4" /> Lançar {inv.stock_reconciled ? 'no Financeiro' : 'Financeiro + Estoque'}
      </Button>
    </>
  );
}

function StockTab({ inv, items, lookups, viaReceipt, canEdit, onSaved }: { inv: Invoice; items: InvoiceItem[] | null; lookups: PurLookups; viaReceipt: boolean; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [allLoc, setAllLoc] = useState('');
  if (!items) return <Spinner />;
  if (items.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">{inv.status === 'summary' ? 'Os itens aparecem depois de baixar o XML completo.' : 'Documento sem itens (entrada manual).'}</p>;
  const save = async (it: InvoiceItem, patch: Partial<InvoiceItem>) => {
    setBusyLine(it.id);
    const { error } = await getSupabase().from('pur_invoice_items').update(patch).eq('id', it.id);
    setBusyLine(null);
    if (error) toast.error(purError(error)); else void onSaved();
  };
  const createItem = async (it: InvoiceItem) => {
    setBusyLine(it.id);
    const sb = getSupabase();
    const { data, error } = await sb.from('inv_items').insert({ name: it.description.slice(0, 200), unit: (it.unit ?? 'UN').toUpperCase().slice(0, 6), ncm: it.ncm, gtin: it.gtin, code: null, last_cost_cents: it.unit_cents }).select('id').single();
    if (error) { setBusyLine(null); toast.error(purError(error)); return; }
    await save(it, { item_id: data.id as string });
    toast.success('Item cadastrado no catálogo e ligado à nota.');
  };
  const applyLoc = async () => {
    if (!allLoc) return;
    for (const it of items.filter((x) => !x.stock_posted)) await getSupabase().from('pur_invoice_items').update({ location_id: allLoc }).eq('id', it.id);
    void onSaved();
  };
  const active = lookups.items.filter((i) => i.is_active);
  return (
    <div className="space-y-3">
      {viaReceipt
        ? <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm">Esta nota está ligada a pedido/recebimento: o estoque já entrou (ou vai entrar) pela conferência do recebimento. Ao lançar, o sistema só marca o estoque como conciliado — <b>não lança em dobro</b>.</p>
        : <p className="text-sm text-[var(--color-text-secondary)]">Sem pedido vinculado: ligue cada linha a um item do catálogo (ou cadastre como novo), escolha o local e, se precisar, o fator de conversão (ex.: 1 CX = 12 UN).</p>}
      {canEdit && !viaReceipt && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Local para todas as linhas" htmlFor="st-all">
            <select id="st-all" value={allLoc} onChange={(e) => setAllLoc(e.target.value)} className={`${inputCls} min-w-[200px]`}>
              <option value="">Escolha…</option>{lookups.locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Button variant="outline" disabled={!allLoc} onClick={applyLoc}>Aplicar</Button>
        </div>
      )}
      <TableWrap minWidth={1200}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>#</th><th className={thCls}>Produto na nota</th><th className={`${thCls} text-right`}>Qtd.</th><th className={`${thCls} text-right`}>Valor</th>
          {!viaReceipt && <><th className={thCls}>Item do catálogo</th><th className={thCls}>Fator</th><th className={thCls}>Local</th><th className={thCls}>Lote / validade</th></>}
          <th className={thCls}>Estoque</th>
        </tr></thead>
        <tbody>
          {items.map((it) => {
            const cat = lookups.items.find((x) => x.id === it.item_id);
            const edit = canEdit && !viaReceipt && !it.stock_posted;
            return (
              <tr key={it.id} className="border-b border-[var(--color-border-soft)] align-top last:border-0">
                <td className={tdCls}>{it.line}</td>
                <td className={tdCls}><div className="font-medium">{it.description}</div><div className="text-xs text-[var(--color-text-muted)]">{[it.product_code && `cód. ${it.product_code}`, it.ncm && `NCM ${it.ncm}`, it.cfop && `CFOP ${it.cfop}`, it.gtin && `EAN ${it.gtin}`].filter(Boolean).join(' · ')}</div></td>
                <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(it.qty)} {it.unit}<div className="text-xs text-[var(--color-text-muted)]">{formatBRL(it.unit_cents)}/un.</div></td>
                <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(it.total_cents)}</td>
                {!viaReceipt && (<>
                  <td className={tdCls}>
                    {edit ? (
                      <div className="flex flex-col gap-1">
                        <select value={it.item_id ?? ''} disabled={busyLine === it.id} onChange={(e) => save(it, { item_id: e.target.value || null })} className="h-8 max-w-[240px] rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-sm">
                          <option value="">— ligar a um item —</option>
                          {active.map((x) => <option key={x.id} value={x.id}>{x.code ? `${x.code} · ` : ''}{x.name} ({x.unit})</option>)}
                        </select>
                        {!it.item_id && <button type="button" disabled={busyLine === it.id} onClick={() => createItem(it)} className="inline-flex items-center gap-1 text-left text-xs text-[var(--accent-primary)] hover:underline"><PackagePlus className="h-3.5 w-3.5" /> Cadastrar como item novo</button>}
                      </div>
                    ) : cat ? `${cat.name} (${cat.unit})` : '—'}
                  </td>
                  <td className={tdCls}>{edit ? <QtyInput value={Number(it.conversion_factor)} onChange={(n) => n > 0 && save(it, { conversion_factor: n })} /> : qtyFmt(it.conversion_factor)}
                    {cat && Number(it.conversion_factor) !== 1 && <div className="text-[11px] text-[var(--color-text-muted)]">= {qtyFmt(Number(it.qty) * Number(it.conversion_factor))} {cat.unit}</div>}</td>
                  <td className={tdCls}>{edit ? (
                    <select value={it.location_id ?? ''} onChange={(e) => save(it, { location_id: e.target.value || null })} className="h-8 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-sm">
                      <option value="">—</option>{lookups.locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>) : lookups.locations.find((l) => l.id === it.location_id)?.name ?? '—'}</td>
                  <td className={tdCls}>{edit ? (
                    <div className="flex flex-col gap-1">
                      <input placeholder={cat?.requires_lot ? 'Lote (obrigatório)' : 'Lote'} defaultValue={it.lot ?? ''} onBlur={(e) => (e.target.value || null) !== it.lot && save(it, { lot: e.target.value.trim() || null })} className="h-8 w-32 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                      <input type="date" defaultValue={it.expiry ?? ''} onBlur={(e) => (e.target.value || null) !== it.expiry && save(it, { expiry: e.target.value || null })} className="h-8 w-32 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                    </div>) : `${it.lot ?? '—'}${it.expiry ? ` · ${fmtDate(it.expiry)}` : ''}`}</td>
                </>)}
                <td className={tdCls}>{it.stock_posted || inv.stock_reconciled ? <Badge tone="success">Lançado</Badge> : <Badge tone="warn">Pendente</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </div>
  );
}

function PaymentsTab({ inv, dues, lookups, canEdit, onDone }: { inv: Invoice; dues: Array<{ id: string; number: string | null; due_date: string; amount_cents: number }>; lookups: PurLookups; canEdit: boolean; onDone: () => Promise<void> }) {
  const perms = usePermission();
  const [inst, setInst] = useState<InstallmentRow[] | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const supplier = lookups.suppliers.find((s) => s.id === inv.party_id);
  const [chart, setChart] = useState(supplier?.default_chart_account_id ?? '');
  const [cc, setCc] = useState('');
  const [busy, setBusy] = useState(false);
  const canSeeFin = perms.can('financial.ledger_view');

  useEffect(() => {
    if (inv.fin_entry_id && canSeeFin) {
      void getSupabase().from('fin_installments_v').select('*').eq('entry_id', inv.fin_entry_id).order('number').then(({ data }) => setInst((data ?? []) as InstallmentRow[]));
    } else setInst([]);
    if (!inv.fin_entry_id && canEdit && inv.status !== 'summary') rpc<Candidate[]>('pur_invoice_fin_candidates', { p_id: inv.id }).then(setCands).catch(() => setCands([]));
  }, [inv.id, inv.fin_entry_id, inv.status, canEdit, canSeeFin]);

  const dueTotal = dues.reduce((s, d) => s + d.amount_cents, 0);
  const run = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await rpc(fn, args); toast.success(ok); await onDone(); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card title="Vencimentos da nota">
        {dues.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">A nota não trouxe duplicatas. A conta a pagar sai com vencimento único (data de entrada/emissão).</p> : (
          <ul className="grid gap-2 sm:grid-cols-3">
            {dues.map((d) => <li key={d.id} className="rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm"><b>{d.number ?? '—'}</b> · {fmtDate(d.due_date)} · <span className="tabular-nums">{formatBRL(d.amount_cents)}</span></li>)}
          </ul>
        )}
        {dues.length > 0 && dueTotal !== inv.total_cents && <p className="mt-2 text-xs text-[var(--inbox-warn-text,#B45309)]">A soma das duplicatas ({formatBRL(dueTotal)}) difere do total da nota: a conta sai com vencimento único.</p>}
      </Card>

      {inv.fin_entry_id ? (
        <Card title={<span className="inline-flex items-center gap-2">Conta a pagar vinculada {inv.fin_diff_accepted && <Badge tone="warn">diferença aceita</Badge>}</span>}>
          {!canSeeFin ? <p className="text-sm text-[var(--color-text-muted)]">Conciliada. Seu perfil não vê o Financeiro.</p> : !inst ? <Spinner /> : (
            <TableWrap minWidth={600}>
              <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Parcela</th><th className={thCls}>Vencimento</th><th className={`${thCls} text-right`}>Valor</th><th className={`${thCls} text-right`}>Pago</th><th className={thCls}>Situação</th></tr></thead>
              <tbody>
                {inst.map((i) => (
                  <tr key={i.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                    <td className={tdCls}>{i.number}/{i.installments_count}</td><td className={tdCls}>{fmtDate(i.due_date)}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.amount_cents)}</td><td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.paid_cents)}</td>
                    <td className={tdCls}><StatusBadge status={i.status} partial={i.is_partial} /> <span className="sr-only">{STATUS_LABEL[i.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      ) : inv.status === 'summary' ? (
        <p className="text-sm text-[var(--color-text-muted)]">Baixe o XML completo (ciência) antes de conciliar.</p>
      ) : canEdit ? (
        <>
          <Card title="Criar conta a pagar a partir da nota">
            <div className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_auto]">
              <Field label="Plano de contas" required htmlFor="pf-ch">
                <ChartPicker id="pf-ch" chart={lookups.chart} kind="payable" value={chart} onChange={setChart} />
              </Field>
              <Field label="Centro de custo" htmlFor="pf-cc">
                <select id="pf-cc" value={cc} onChange={(e) => setCc(e.target.value)} className={inputCls}>
                  <option value="">—</option>{lookups.costCenters.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Button disabled={busy || !chart} onClick={() => run('pur_invoice_fin_create', { p_id: inv.id, p_chart: chart, p_cost_center: cc || null }, 'Conta a pagar criada com os vencimentos da nota.')}>Criar conta a pagar</Button>
            </div>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">Mesma empresa e fornecedor da nota, com {dues.length > 1 && dueTotal === inv.total_cents ? `${dues.length} parcelas nas datas das duplicatas` : 'vencimento único'}.</p>
          </Card>
          <Card title="…ou vincular uma conta a pagar que já existe">
            {!cands ? <Spinner /> : cands.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhuma conta a pagar parecida (mesma empresa, sem nota).</p> : (
              <ul className="space-y-1">
                {cands.map((c) => {
                  const differs = c.total_cents !== inv.total_cents;
                  return (
                    <li key={c.entry_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm">
                      <span><b>{c.description}</b> · {c.party_name ?? 'sem fornecedor'} · {formatBRL(c.total_cents)} · venc. {fmtDate(c.first_due)} <span className="text-xs text-[var(--color-text-muted)]">({c.score}%)</span></span>
                      <span className="flex items-center gap-2">
                        {differs && <label className="flex items-center gap-1 text-xs text-[var(--inbox-warn-text,#B45309)]"><input type="checkbox" checked={!!accept[c.entry_id]} onChange={(e) => setAccept((a) => ({ ...a, [c.entry_id]: e.target.checked }))} /> aceito a diferença de {formatBRL(Math.abs(c.total_cents - inv.total_cents))}</label>}
                        <Button size="sm" variant="outline" disabled={busy || (differs && !accept[c.entry_id])} onClick={() => run('pur_invoice_fin_link', { p_id: inv.id, p_entry: c.entry_id, p_accept_diff: !!accept[c.entry_id] }, 'Conta a pagar vinculada.')}><Link2 className="h-3.5 w-3.5" /> Vincular</Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      ) : <p className="text-sm text-[var(--color-text-muted)]">Sem conta a pagar vinculada.</p>}
    </div>
  );
}
