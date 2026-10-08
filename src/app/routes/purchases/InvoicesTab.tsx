import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { useMyDefaultCompany } from '@/hooks/useMyDefaultCompany';
import { Ban, Boxes, CheckCircle2, CloudDownload, DollarSign, KeyRound, Download, Eye, FileSpreadsheet, FileText, FileUp, Link2, Loader2, PackagePlus, Pencil, Plus, RotateCcw, Save, Search, Trash2, Unlink, Wallet, XCircle } from 'lucide-react';
import { DataGrid, GridReset, gridExportRows, useGrid, type GridColumn } from '@/components/ui/GridTable';
import { exportExcel, exportPdf } from '@/lib/table-export';
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
import { Badge, Card, Field, inputCls, KV, MoneyInput, QtyInput, ReasonDialog, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, Trace, useDebounced, useOpenDoc } from './ui';
import { ChartPicker } from '../finance/ui';


type YesNo = '' | 'yes' | 'no';
const NO_RECON = new Set(['summary', 'ignored', 'canceled_sefaz']);

// Status como a equipe fala: pendente vira "Aguardando conferência" (nada feito) ou "Aguardando lançamento" (meio feito).
function displayStatus(n: Invoice): [string, 'warn' | 'accent' | 'success' | 'muted' | 'error'] {
  if (n.status === 'pending') return n.fin_reconciled || n.stock_reconciled ? ['Aguardando lançamento', 'warn'] : ['Aguardando conferência', 'accent'];
  return INVOICE_STATUS[n.status];
}

export function InvoicesTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const perms = usePermission();
  const [from, setFrom] = useState(monthStart(addDays(todaySP(), -95))); // a SEFAZ guarda ~3 meses
  const [to, setTo] = useState(todaySP());
  const [by, setBy] = useState<'entry' | 'issue' | 'created'>('entry');
  const [companyId, setCompanyId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [status, setStatus] = useState<'' | InvoiceStatus>('');
  const [source, setSource] = useState('');
  const [finRec, setFinRec] = useState<YesNo>('');
  const [stockRec, setStockRec] = useState<YesNo>('');
  const [text, setText] = useState('');
  const q = useDebounced(text);
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [manual, setManual] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncCompany, setSyncCompany] = useState('');
  const [finFor, setFinFor] = useState<Invoice | null>(null);
  const [stockFor, setStockFor] = useState<Invoice | null>(null);
  const [delFor, setDelFor] = useState<Invoice | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const myCompany = useMyDefaultCompany();
  useEffect(() => { if (myCompany && !syncCompany && lookups.companies.some((c) => c.id === myCompany)) setSyncCompany(myCompany); }, [myCompany, syncCompany, lookups.companies]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [certInfo, setCertInfo] = useState<{ any: boolean; loaded: boolean }>({ any: true, loaded: false });
  useEffect(() => {
    if (!perms.can('purchases.invoice')) return;
    sefazApi<{ companies: Array<{ has_cert: boolean }> }>('cert_status')
      .then((r) => setCertInfo({ any: r.companies.some((c) => c.has_cert), loaded: true }))
      .catch(() => setCertInfo({ any: true, loaded: true }));
  }, [perms]);
  const navigate = useNavigate();
  const goCert = () => {
    const cid = syncCompany || lookups.companies.find((c) => c.is_default)?.id;
    navigate(cid ? `/configuracoes/empresas/${cid}?aba=certificados` : '/configuracoes/empresas');
  };

  const load = useCallback(async () => {
    const col = by === 'issue' ? 'issue_date' : by === 'created' ? 'created_at' : 'effective_date';
    let query = getSupabase().from('pur_invoices_v').select('*').order(col, { ascending: false, nullsFirst: false }).limit(2000);
    if (by === 'created') {
      if (from) query = query.gte('created_at', `${from}T00:00:00-05:00`);
      if (to) query = query.lte('created_at', `${to}T23:59:59-05:00`);
    } else {
      if (from) query = query.gte(col, from);
      if (to) query = query.lte(col, to);
    }
    if (companyId) query = query.eq('company_id', companyId);
    if (partyId) query = query.eq('party_id', partyId);
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (finRec) query = query.eq('fin_reconciled', finRec === 'yes');
    if (stockRec) query = query.eq('stock_reconciled', stockRec === 'yes');
    const t = q.trim().replace(/[,()]/g, ' ');
    if (t) {
      const d = t.replace(/\D/g, '');
      query = query.or([`number.ilike.%${t}%`, `supplier_name.ilike.%${t}%`, `party_name.ilike.%${t}%`, d.length >= 4 ? `access_key.ilike.%${d}%` : '', d.length >= 4 ? `supplier_doc.ilike.%${d}%` : ''].filter(Boolean).join(','));
    }
    const { data, error } = await query;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Invoice[]);
  }, [from, to, by, companyId, partyId, status, source, finRec, stockRec, q]);
  useEffect(() => { void load(); }, [load]);
  const current = useOpenDoc('pur_invoices_v', openId, rows);

  // Busca contínua: cada chamada traz algumas centenas de documentos; repete enquanto a SEFAZ tiver mais.
  const syncSefaz = async () => {
    const cid = syncCompany || lookups.companies.find((c) => c.is_default)?.id;
    if (!cid) return;
    setSyncing(true);
    const tid = toast.loading('Buscando notas na SEFAZ…');
    let notas = 0; let falhas = 0; let minIssue: string | null = null; const erros: string[] = [];
    type SyncResp = { message: string; notas?: number; completas?: number; falhas?: number; erros?: string[]; min_issue?: string | null; more?: boolean; waiting?: boolean; last_nsu?: string | null; max_nsu?: string | null };
    try {
      for (let i = 0; i < 20; i++) {
        const r = await sefazApi<SyncResp>('sync', { company_id: cid });
        notas += (r.notas ?? 0) + (r.completas ?? 0); falhas += r.falhas ?? 0; erros.push(...(r.erros ?? []));
        if (r.min_issue && (!minIssue || r.min_issue < minIssue)) minIssue = r.min_issue;
        const left = r.max_nsu && r.last_nsu ? Math.max(0, Number(r.max_nsu) - Number(r.last_nsu)) : null;
        if (!r.more) {
          toast.dismiss(tid);
          const head = notas ? `${notas} nota(s) recebida(s) da SEFAZ.` : '';
          if (r.waiting && !notas) toast.info(r.message);
          else toast.success(head || 'Nenhuma nota nova na SEFAZ.', { description: r.waiting ? r.message : 'Tudo em dia com a SEFAZ (ela guarda só os últimos 3 meses).' });
          break;
        }
        toast.loading(`Buscando notas na SEFAZ… ${notas} recebida(s)${left !== null ? ` · faltam ~${left} documento(s)` : ''}`, { id: tid });
      }
      if (falhas) toast.error(`${falhas} documento(s) não entraram`, { description: erros.slice(0, 3).join(' · ') });
      if (minIssue && from && minIssue < from) setFrom(minIssue);
      void load();
    } catch (e) { toast.dismiss(tid); toast.error('Busca na SEFAZ', { description: e instanceof Error ? e.message : String(e) }); void load(); }
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

  const list = rows ?? [];
  const live = list.filter((n) => n.status !== 'ignored' && n.status !== 'canceled_sefaz');
  const finPend = list.filter((n) => !NO_RECON.has(n.status) && !n.fin_reconciled);
  const stockPend = list.filter((n) => !NO_RECON.has(n.status) && !n.stock_reconciled);
  const summaries = list.filter((n) => n.status === 'summary').length;
  const sumOf = (a: Invoice[]) => a.reduce((s, n) => s + n.total_cents, 0);
  const canRemove = (n: Invoice) => perms.can('purchases.invoice') && !n.fin_entry_id && !n.stock_reconciled && n.status !== 'posted';

  const columns = useMemo<GridColumn<Invoice>[]>(() => [
    { id: 'number', label: 'Número', width: 110, sortValue: (n) => n.number, exportValue: (n) => `${n.number}${n.series ? `/${n.series}` : ''}`,
      render: (n) => <span className="font-semibold">{n.doc_type !== 'nfe' && <span className="mr-1 text-xs font-normal text-[var(--color-text-muted)]">{DOC_TYPE[n.doc_type]}</span>}{n.number}{n.series ? `/${n.series}` : ''}</span> },
    { id: 'supplier', label: 'Fornecedor', width: 250, minWidth: 140, sortValue: (n) => n.party_name ?? n.supplier_name ?? '',
      render: (n) => <span className="block truncate" title={n.party_name ?? n.supplier_name ?? ''}>{n.party_name ?? n.supplier_name ?? '—'}</span> },
    { id: 'doc', label: 'CNPJ/CPF', width: 145, sortValue: (n) => n.supplier_doc ?? '', exportValue: (n) => formatDoc(n.supplier_doc),
      render: (n) => <span className="whitespace-nowrap tabular-nums text-[var(--color-text-secondary)]">{formatDoc(n.supplier_doc)}</span> },
    { id: 'company', label: 'Empresa', width: 110, sortValue: (n) => n.company_name ?? '', render: (n) => <span className="block truncate text-[var(--color-text-secondary)]">{n.company_name}</span> },
    { id: 'total', label: 'Valor total', width: 115, align: 'right', sortValue: (n) => n.total_cents, exportValue: (n) => n.total_cents / 100,
      render: (n) => <span className="tabular-nums">{formatBRL(n.total_cents)}</span> },
    { id: 'entry', label: 'Entrada', width: 92, sortValue: (n) => n.entry_date ?? '', exportValue: (n) => fmtDate(n.entry_date), render: (n) => fmtDate(n.entry_date) },
    { id: 'issue', label: 'Emissão', width: 92, sortValue: (n) => n.issue_date ?? '', exportValue: (n) => fmtDate(n.issue_date), render: (n) => fmtDate(n.issue_date) },
    { id: 'created', label: 'Cadastro', width: 92, sortValue: (n) => n.created_at, exportValue: (n) => fmtDate(n.created_at.slice(0, 10)), render: (n) => fmtDate(n.created_at.slice(0, 10)) },
    { id: 'source', label: 'Tipo', width: 70, sortValue: (n) => SOURCE[n.source], exportValue: (n) => SOURCE[n.source], render: (n) => <span className="text-[var(--color-text-secondary)]">{SOURCE[n.source]}</span> },
    { id: 'fin', label: 'Conc. Fin.', width: 88, align: 'center', sortValue: (n) => (NO_RECON.has(n.status) ? '' : n.fin_reconciled ? 'Sim' : 'Não'),
      render: (n) => (NO_RECON.has(n.status) ? '—' : <YesNoPill on={n.fin_reconciled} title={n.fin_diff_accepted ? 'Conciliado com diferença aceita' : undefined} />) },
    { id: 'stock', label: 'Conc. Estoq.', width: 98, align: 'center', sortValue: (n) => (NO_RECON.has(n.status) ? '' : n.stock_reconciled ? 'Sim' : 'Não'),
      render: (n) => (NO_RECON.has(n.status) ? '—' : <YesNoPill on={n.stock_reconciled} />) },
    { id: 'status', label: 'Status', width: 168, sortValue: (n) => displayStatus(n)[0], exportValue: (n) => displayStatus(n)[0],
      render: (n) => {
        const [l, tone] = displayStatus(n);
        return <span className="inline-flex items-center gap-1"><Badge tone={tone}>{l}</Badge>{n.sefaz_situation === 'cancelada' && n.status !== 'canceled_sefaz' && <Badge tone="error">cancelada!</Badge>}</span>;
      } },
  ], []);
  const grid = useGrid('megacrm_grid_nfe_entrada', columns, list);

  const doExport = async (kind: 'xlsx' | 'pdf') => {
    setExportOpen(false);
    const { header, rows: data } = gridExportRows(grid);
    const title = 'Notas de entrada';
    const period = `${by === 'issue' ? 'Emissão' : by === 'created' ? 'Cadastro' : 'Entrada'} de ${from ? fmtDate(from) : '—'} até ${to ? fmtDate(to) : '—'} · ${list.length} nota(s)`;
    if (kind === 'xlsx') { try { await exportExcel(`notas-de-entrada-${todaySP()}`, title, header, data); } catch (e) { toast.error('Não foi possível gerar o Excel', { description: e instanceof Error ? e.message : String(e) }); } return; }
    const ti = grid.cols.findIndex((c) => c.id === 'total');
    exportPdf(title, period, header, data.map((r) => r.map((c, i) => (i === ti && typeof c === 'number' ? formatBRL(Math.round(c * 100)) : c))),
      { rightCols: ti >= 0 ? [ti] : [], footer: grid.cols.map((c, i) => (c.id === 'total' ? formatBRL(sumOf(list)) : i === 0 ? 'Total' : '')) });
  };

  const iconBtn = 'inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border-card)] disabled:hover:text-[var(--color-text-secondary)]';
  const kpi = (label: string, value: string, hint: string, tone?: 'warn', onClick?: () => void, active?: boolean) => (
    <button type="button" onClick={onClick} disabled={!onClick} aria-pressed={active}
      className={cn('border-[var(--color-border-soft)] px-5 py-4 text-left transition-colors lg:border-l lg:first:border-l-0', onClick && 'hover:bg-[var(--color-surface-hover)]', active && 'bg-[var(--color-accent-subtle)]')}>
      <div className="text-xs text-[var(--color-text-secondary)]">{label}</div>
      <div className={cn('mt-0.5 text-xl font-bold tabular-nums', tone === 'warn' ? 'text-[#C2410C]' : 'text-[var(--color-text-primary)]')}>{value}</div>
      <div className={cn('text-[11px]', tone === 'warn' ? 'text-[#C2410C]' : 'text-[var(--color-text-muted)]')}>{hint}</div>
    </button>
  );
  const radio = (v: typeof by, l: string) => (
    <label className={cn('inline-flex h-9 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 text-xs font-medium',
      by === v ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
      <input type="radio" name="nf-by" checked={by === v} onChange={() => setBy(v)} className="accent-[var(--accent-fill)]" />{l}
    </label>
  );
  const activeCompanies = lookups.companies.filter((c) => c.is_active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Notas de entrada</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">Gerencie as notas fiscais de entrada e acompanhe as conciliações financeira e de estoque.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GridReset grid={grid} />
          <div className="relative">
            <Button variant="outline" disabled={!list.length} onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}><Download className="h-4 w-4" /> Exportar</Button>
            {exportOpen && (
              <div className="absolute right-0 z-[var(--z-popover,60)] mt-1 w-44 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1 shadow-[var(--shadow-lg)]">
                <button type="button" onClick={() => void doExport('xlsx')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"><FileSpreadsheet className="h-4 w-4 text-[#16a34a]" /> Excel (.xlsx)</button>
                <button type="button" onClick={() => void doExport('pdf')} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-surface-hover)]"><FileText className="h-4 w-4 text-[#dc2626]" /> PDF</button>
              </div>
            )}
          </div>
          {perms.can('purchases.invoice') && (<>
            {activeCompanies.length > 1 && (
              <select value={syncCompany} onChange={(e) => setSyncCompany(e.target.value)} className={cn(inputCls, 'w-40')} aria-label="Empresa para buscar na SEFAZ">
                {activeCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <Button variant="outline" disabled={syncing} onClick={syncSefaz}>{syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />} Buscar na SEFAZ</Button>
            <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" multiple hidden onChange={(e) => importFiles(e.target.files)} />
            <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Importar NF-e</Button>
            <Button onClick={() => setManual(true)}><Plus className="h-4 w-4" /> Nova entrada</Button>
          </>)}
        </div>
      </div>

      {certInfo.loaded && !certInfo.any && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] p-3 text-sm">
          <span className="flex items-center gap-2"><KeyRound className="h-4 w-4 shrink-0" /> Para puxar as notas da SEFAZ automaticamente, envie o <b>certificado digital A1</b> (.pfx) da empresa.</span>
          {perms.can('purchases.setup') ? <Button size="sm" onClick={goCert}><KeyRound className="h-4 w-4" /> Enviar certificado</Button>
            : <span className="text-xs text-[var(--color-text-muted)]">Peça a quem configura Compras.</span>}
        </div>
      )}

      <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-[var(--color-text-secondary)]">Período por</span>
          {radio('entry', 'Data de entrada')}{radio('issue', 'Data de emissão')}{radio('created', 'Data de cadastro')}
        </div>
        <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5', lookups.companies.length > 1 ? 'xl:grid-cols-10' : 'xl:grid-cols-9')}>
          <div className="sm:col-span-2 lg:col-span-2"><Field label="Período" htmlFor="nf-from">
            <div className="flex items-center gap-1.5">
              <input id="nf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} aria-label="De" />
              <span className="text-[var(--color-text-muted)]">–</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} aria-label="Até" />
            </div>
          </Field></div>
          <Field label="Número" htmlFor="nf-q"><input id="nf-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Número, chave ou fornecedor" className={inputCls} /></Field>
          <Field label="Fornecedor" htmlFor="nf-party">
            <select id="nf-party" value={partyId} onChange={(e) => setPartyId(e.target.value)} className={inputCls}>
              <option value="">Todos os fornecedores</option>
              {lookups.suppliers.filter((p) => p.kind !== 'customer').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Conciliação financeira" htmlFor="nf-fin">
            <select id="nf-fin" value={finRec} onChange={(e) => setFinRec(e.target.value as YesNo)} className={inputCls}><option value="">Todas</option><option value="yes">Conciliadas</option><option value="no">Pendentes</option></select>
          </Field>
          <Field label="Conciliação estoque" htmlFor="nf-stk">
            <select id="nf-stk" value={stockRec} onChange={(e) => setStockRec(e.target.value as YesNo)} className={inputCls}><option value="">Todas</option><option value="yes">Conciliadas</option><option value="no">Pendentes</option></select>
          </Field>
          <Field label="Tipo de entrada" htmlFor="nf-src">
            <select id="nf-src" value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
              <option value="">Todas</option>{Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Situação" htmlFor="nf-st">
            <select id="nf-st" value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className={inputCls}>
              <option value="">Todas</option>{Object.entries(INVOICE_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {lookups.companies.length > 1 && (
            <Field label="Empresa" htmlFor="nf-co">
              <select id="nf-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
                <option value="">Todas</option>{lookups.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] sm:grid-cols-2 lg:grid-cols-4">
        {kpi('Total de entradas', String(list.length), 'Notas no filtro')}
        {kpi('Valor total das notas', formatBRL(sumOf(live)), 'Sem canceladas nem ignoradas')}
        {kpi('Pendente conciliação financeira', formatBRL(sumOf(finPend)), `${finPend.length} nota(s) pendente(s)`, finPend.length ? 'warn' : undefined,
          () => setFinRec(finRec === 'no' ? '' : 'no'), finRec === 'no')}
        {kpi('Pendente conciliação de estoque', formatBRL(sumOf(stockPend)), `${stockPend.length} nota(s) pendente(s)`, stockPend.length ? 'warn' : undefined,
          () => setStockRec(stockRec === 'no' ? '' : 'no'), stockRec === 'no')}
      </div>
      {summaries > 0 && (
        <button type="button" onClick={() => setStatus(status === 'summary' ? '' : 'summary')}
          className="flex w-full items-center gap-2 rounded-[var(--radius-card)] border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] px-4 py-2.5 text-left text-sm hover:bg-[rgba(245,158,11,0.1)]">
          <Eye className="h-4 w-4 shrink-0 text-[#B45309]" /> <span><b>{summaries}</b> nota(s) vieram só como resumo da SEFAZ e precisam de <b>ciência</b> para baixar o XML. {status === 'summary' ? 'Mostrar todas.' : 'Ver só elas.'}</span>
        </button>
      )}

      {!rows ? <Spinner /> : (
        <DataGrid grid={grid} rowKey={(n) => n.id} onRowClick={(n) => onOpen('invoice', n.id)} emptyText="Nenhuma nota com esses filtros."
          rowClassName={(n) => (n.status === 'ignored' || n.status === 'canceled_sefaz') && 'opacity-60'}
          footer={{ number: `${list.length} nota(s)`, total: formatBRL(sumOf(list)) }} actionsWidth={156}
          actions={(n) => (
            <div className="flex justify-end gap-1">
              <button type="button" className={iconBtn} title="Abrir / editar a nota" aria-label="Abrir a nota" onClick={() => onOpen('invoice', n.id)}><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" className={iconBtn} title={NO_RECON.has(n.status) ? 'Sem conciliação para esta nota' : 'Conciliação financeira'} aria-label="Conciliação financeira" disabled={NO_RECON.has(n.status)} onClick={() => setFinFor(n)}><DollarSign className="h-3.5 w-3.5" /></button>
              <button type="button" className={iconBtn} title={NO_RECON.has(n.status) ? 'Sem conciliação para esta nota' : 'Conciliação de estoque'} aria-label="Conciliação de estoque" disabled={NO_RECON.has(n.status)} onClick={() => setStockFor(n)}><Boxes className="h-3.5 w-3.5" /></button>
              <button type="button" className={cn(iconBtn, 'hover:border-[var(--color-error)] hover:text-[var(--color-error)]')} disabled={!canRemove(n)}
                title={canRemove(n) ? 'Excluir a nota' : 'Nota com lançamento não se exclui (use Ignorar dentro da nota)'} aria-label="Excluir a nota" onClick={() => setDelFor(n)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          )} />
      )}

      {manual && <ManualDialog lookups={lookups} onClose={() => setManual(false)} onSaved={(id) => { setManual(false); void load(); onOpen('invoice', id); }} />}
      {openId && current && <InvoiceDetail inv={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} />}
      {finFor && <FinanceReconcileDialog inv={rows?.find((r) => r.id === finFor.id) ?? finFor} lookups={lookups} onClose={() => setFinFor(null)} onOpenNote={() => { const id = finFor.id; setFinFor(null); onOpen('invoice', id); }} onChanged={load} />}
      {stockFor && <StockReconcileDialog inv={rows?.find((r) => r.id === stockFor.id) ?? stockFor} lookups={lookups} onClose={() => setStockFor(null)} onOpenNote={() => { const id = stockFor.id; setStockFor(null); onOpen('invoice', id); }} onChanged={load} />}
      {delFor && (
        <Dialog open onClose={() => setDelFor(null)} opaque title="Excluir nota" description={`Nota ${delFor.number} de ${delFor.party_name ?? delFor.supplier_name ?? ''} (${formatBRL(delFor.total_cents)}). Se ela vier de novo da SEFAZ, entra outra vez.`}>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDelFor(null)}>Cancelar</Button>
            <Button className="bg-[var(--color-error)] hover:opacity-90" onClick={async () => {
              const { error } = await getSupabase().from('pur_invoices').delete().eq('id', delFor.id);
              if (error) { toast.error(purError(error)); return; }
              toast.success('Nota excluída.'); setDelFor(null); void load();
            }}><Trash2 className="h-4 w-4" /> Excluir</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function YesNoPill({ on, title }: { on: boolean; title?: string }) {
  return <span title={title} className={cn('inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold', on ? 'bg-[rgba(34,197,94,0.14)] text-[#15803d]' : 'bg-[rgba(239,68,68,0.12)] text-[#dc2626]')}>{on ? 'Sim' : 'Não'}</span>;
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

// ============================================================================
// Conciliações separadas (botões $ e estoque da lista): dá para fazer uma sem a outra.
// ============================================================================
type Due = { id: string; number: string | null; due_date: string; amount_cents: number };

function NoteHead({ inv, extra }: { inv: Invoice; extra?: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
      <KV label="Número da nota"><b>{inv.number}{inv.series ? `/${inv.series}` : ''}</b></KV>
      <KV label="Fornecedor"><span className="line-clamp-2">{inv.party_name ?? inv.supplier_name ?? '—'}</span></KV>
      <KV label="CNPJ/CPF">{formatDoc(inv.supplier_doc)}</KV>
      <KV label="Valor total"><b className="tabular-nums">{formatBRL(inv.total_cents)}</b></KV>
      {extra}
      <KV label="Data de emissão">{fmtDate(inv.issue_date)}</KV>
      <KV label="Data de entrada">{fmtDate(inv.entry_date)}</KV>
    </div>
  );
}

function FinanceReconcileDialog({ inv, lookups, onClose, onOpenNote, onChanged }: { inv: Invoice; lookups: PurLookups; onClose: () => void; onOpenNote: () => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const can = perms.can('purchases.invoice') && !NO_RECON.has(inv.status);
  const canSeeFin = perms.can('financial.ledger_view');
  const [tab, setTab] = useState<'resumo' | 'pagamentos' | 'historico'>('resumo');
  const [dues, setDues] = useState<Due[]>([]);
  const [inst, setInst] = useState<InstallmentRow[] | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const supplier = lookups.suppliers.find((s) => s.id === inv.party_id);
  const [chart, setChart] = useState(supplier?.default_chart_account_id ?? '');
  const [cc, setCc] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSupabase().from('pur_invoice_dues').select('*').eq('invoice_id', inv.id).order('due_date').then(({ data }) => setDues((data ?? []) as Due[]));
    if (inv.fin_entry_id && canSeeFin) void getSupabase().from('fin_installments_v').select('*').eq('entry_id', inv.fin_entry_id).order('number').then(({ data }) => setInst((data ?? []) as InstallmentRow[]));
    else setInst([]);
    if (!inv.fin_entry_id && can) rpc<Candidate[]>('pur_invoice_fin_candidates', { p_id: inv.id }).then(setCands).catch(() => setCands([]));
  }, [inv.id, inv.fin_entry_id, can, canSeeFin]);

  const run = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await rpc(fn, args); toast.success(ok); await onChanged(); return true; }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); return false; }
    finally { setBusy(false); }
  };
  const dueTotal = dues.reduce((s, d) => s + d.amount_cents, 0);
  const linked = inv.fin_total_cents ?? (inv.fin_entry_id ? inst?.reduce((s, i) => s + i.amount_cents, 0) ?? null : 0);
  const finDone = inv.fin_reconciled && inv.status === 'posted';

  return (
    <Dialog open onClose={onClose} widthClass="max-w-3xl" opaque title="Conciliação financeira da nota" description="Veja a nota e amarre-a à conta a pagar — a que já existe ou uma nova.">
      <div className="space-y-4">
        <NoteHead inv={inv} extra={<KV label="Conciliação financeira">{inv.fin_reconciled ? <Badge tone="success">Conciliada{inv.fin_diff_accepted ? ' (dif.)' : ''}</Badge> : <Badge tone="warn">Pendente</Badge>}</KV>} />
        <SubTabs value={tab} onChange={setTab} tabs={[['resumo', 'Resumo'], ['pagamentos', 'Pagamentos'], ['historico', 'Histórico']]} />

        {tab === 'resumo' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="font-semibold text-[var(--color-text-primary)]">Lançamentos financeiros (contas a pagar)</h4>
                <p className="text-xs text-[var(--color-text-secondary)]">Vincule a conta a pagar desta nota. O valor conciliado deve ser igual ao total da nota.</p>
              </div>
              {can && !inv.fin_entry_id && inv.status !== 'summary' && <Button variant="outline" onClick={() => setCreating((c) => !c)}><Plus className="h-4 w-4" /> Criar novo lançamento</Button>}
            </div>
            {inv.status === 'summary' && <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">Esta nota é só o resumo da SEFAZ. Abra a nota e dê ciência para baixar o XML antes de conciliar.</p>}
            {creating && !inv.fin_entry_id && (
              <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
                <div className="grid items-end gap-3 sm:grid-cols-[2fr_1fr]">
                  <Field label="Plano de contas" required htmlFor="fr-ch"><ChartPicker id="fr-ch" chart={lookups.chart} kind="payable" value={chart} onChange={setChart} /></Field>
                  <Field label="Centro de custo" htmlFor="fr-cc">
                    <select id="fr-cc" value={cc} onChange={(e) => setCc(e.target.value)} className={inputCls}>
                      <option value="">—</option>{lookups.costCenters.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </Field>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">Mesma empresa e fornecedor da nota, com {dues.length > 1 && dueTotal === inv.total_cents ? `${dues.length} parcelas nas datas das duplicatas` : 'vencimento único'}.</p>
                <div className="flex justify-end"><Button disabled={busy || !chart} onClick={async () => { if (await run('pur_invoice_fin_create', { p_id: inv.id, p_chart: chart, p_cost_center: cc || null }, 'Conta a pagar criada com os vencimentos da nota.')) setCreating(false); }}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Criar conta a pagar</Button></div>
              </div>
            )}
            {inv.fin_entry_id ? (
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3 text-sm">
                <b>Conta a pagar vinculada.</b> {canSeeFin && inst ? `${inst.length} parcela(s).` : ''} Veja as parcelas na aba Pagamentos.
              </div>
            ) : can && inv.status !== 'summary' && (
              !cands ? <Spinner /> : cands.length === 0 ? (
                <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm text-[var(--color-text-secondary)]">Nenhuma conta a pagar parecida com esta nota (mesmo fornecedor, valor ou data próxima). Use <b>Criar novo lançamento</b>.</p>
              ) : (
                <ul className="space-y-1.5">
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
              )
            )}
            <div className="flex flex-wrap items-center gap-6 rounded-[var(--radius-card)] bg-[var(--color-surface-hover)] px-4 py-3 text-sm">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(34,197,94,0.14)] text-[#15803d]"><DollarSign className="h-4 w-4" /></span>
              <KV label="Valor total da nota"><b className="tabular-nums">{formatBRL(inv.total_cents)}</b></KV>
              <KV label="Valor conciliado"><b className="tabular-nums">{linked === null ? '—' : formatBRL(linked)}</b></KV>
              <span className="text-[var(--color-text-secondary)]">{inv.fin_entry_id ? (linked !== null && linked !== inv.total_cents ? `Diferença de ${formatBRL(Math.abs(inv.total_cents - linked))}${inv.fin_diff_accepted ? ' (aceita)' : ''}.` : 'Valores batem.') : 'Nenhuma conta vinculada ainda.'}</span>
            </div>
          </div>
        )}

        {tab === 'pagamentos' && (
          <div className="space-y-3">
            <Card title="Vencimentos da nota">
              {dues.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">A nota não trouxe duplicatas: a conta sai com vencimento único.</p> : (
                <ul className="grid gap-2 sm:grid-cols-3">{dues.map((d) => <li key={d.id} className="rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm"><b>{d.number ?? '—'}</b> · {fmtDate(d.due_date)} · <span className="tabular-nums">{formatBRL(d.amount_cents)}</span></li>)}</ul>
              )}
            </Card>
            <Card title="Parcelas da conta a pagar">
              {!inv.fin_entry_id ? <p className="text-sm text-[var(--color-text-muted)]">Ainda sem conta a pagar.</p> : !canSeeFin ? <p className="text-sm text-[var(--color-text-muted)]">Seu perfil não vê o Financeiro.</p> : !inst ? <Spinner /> : (
                <TableWrap minWidth={520}>
                  <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Parcela</th><th className={thCls}>Vencimento</th><th className={`${thCls} text-right`}>Valor</th><th className={`${thCls} text-right`}>Pago</th><th className={thCls}>Situação</th></tr></thead>
                  <tbody>{inst.map((i) => (
                    <tr key={i.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                      <td className={tdCls}>{i.number}/{i.installments_count}</td><td className={tdCls}>{fmtDate(i.due_date)}</td>
                      <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.amount_cents)}</td><td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.paid_cents)}</td>
                      <td className={tdCls}><StatusBadge status={i.status} partial={i.is_partial} /></td>
                    </tr>
                  ))}</tbody>
                </TableWrap>
              )}
            </Card>
          </div>
        )}
        {tab === 'historico' && <AuditList recordIds={[inv.id, ...dues.map((d) => d.id)]} />}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-4">
          <Button variant="outline" onClick={onOpenNote}><Pencil className="h-4 w-4" /> Abrir a nota</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Fechar</Button>
            {can && <Button disabled={busy || !inv.fin_entry_id || finDone} title={!inv.fin_entry_id ? 'Vincule ou crie a conta a pagar antes.' : finDone ? 'Já está lançada no Financeiro.' : undefined}
              onClick={async () => { if (await run('pur_invoice_post', { p_id: inv.id, p_finance: true, p_stock: false }, 'Conciliação financeira salva: nota lançada no Financeiro.')) onClose(); }}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {finDone ? 'Conciliação salva' : 'Salvar conciliação'}
            </Button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function StockReconcileDialog({ inv, lookups, onClose, onOpenNote, onChanged }: { inv: Invoice; lookups: PurLookups; onClose: () => void; onOpenNote: () => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const can = perms.can('purchases.invoice') && !NO_RECON.has(inv.status) && !inv.stock_reconciled;
  const [items, setItems] = useState<InvoiceItem[] | null>(null);
  const [viaReceipt, setViaReceipt] = useState(false);
  const [marked, setMarked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loc, setLoc] = useState('');
  const [catalog, setCatalog] = useState(lookups.items);

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

  const save = async (it: InvoiceItem, patch: Partial<InvoiceItem>) => {
    setBusy(it.id);
    const { error } = await getSupabase().from('pur_invoice_items').update(patch).eq('id', it.id);
    setBusy(null);
    if (error) { toast.error(purError(error)); return false; }
    setItems((cur) => cur?.map((x) => (x.id === it.id ? { ...x, ...patch } : x)) ?? cur);
    return true;
  };
  const linkTo = async (itemId: string) => {
    const it = items?.find((x) => x.id === marked);
    if (!it) { toast.info('Clique numa linha da nota primeiro.'); return; }
    if (await save(it, { item_id: itemId })) {
      const next = items?.find((x) => x.id !== it.id && !x.item_id);
      if (next) setMarked(next.id);
    }
  };
  const createFromMarked = async () => {
    const it = items?.find((x) => x.id === marked);
    if (!it) { toast.info('Clique numa linha da nota primeiro.'); return; }
    setBusy(it.id);
    const { data, error } = await getSupabase().from('inv_items').insert({ name: it.description.slice(0, 200), unit: (it.unit ?? 'UN').toUpperCase().slice(0, 6), ncm: it.ncm, gtin: it.gtin, code: null, last_cost_cents: it.unit_cents })
      .select('id, code, name, unit, requires_lot, ncm, gtin, chart_account_id, last_cost_cents, is_active').single();
    setBusy(null);
    if (error) { toast.error(purError(error)); return; }
    setCatalog((c) => [...c, data as typeof c[number]]);
    await linkTo(String(data.id));
    toast.success('Item cadastrado no estoque e ligado à linha.');
  };
  const applyLoc = async (v: string) => {
    setLoc(v);
    if (!v || !items) return;
    for (const it of items.filter((x) => !x.stock_posted && x.location_id !== v)) await save(it, { location_id: v });
  };

  const list = items ?? [];
  const done = list.filter((x) => x.item_id).length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  const active = catalog.filter((i) => i.is_active);
  const t = search.trim().toLowerCase();
  const found = (t ? active.filter((i) => `${i.code ?? ''} ${i.name} ${i.gtin ?? ''}`.toLowerCase().includes(t)) : active).slice(0, 60);
  const ready = viaReceipt || (list.length > 0 && list.every((x) => x.stock_posted || (x.item_id && x.location_id && (!catalog.find((c) => c.id === x.item_id)?.requires_lot || x.lot))));
  const [statusLabel, statusTone] = displayStatus(inv);

  const sel = 'h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm disabled:opacity-60';
  return (
    <Dialog open onClose={onClose} widthClass="max-w-7xl" opaque title="Conciliação de itens da nota" description="Vincule cada item da nota ao item do seu estoque e dê entrada no almoxarifado.">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 sm:grid-cols-3 lg:grid-cols-6">
          <KV label="Número da nota"><b>{inv.number}{inv.series ? `/${inv.series}` : ''}</b></KV>
          <KV label="Fornecedor"><b className="line-clamp-2">{inv.party_name ?? inv.supplier_name ?? '—'}</b><div className="text-xs text-[var(--color-text-muted)]">{formatDoc(inv.supplier_doc)}</div></KV>
          <KV label="Valor total"><b className="tabular-nums">{formatBRL(inv.total_cents)}</b></KV>
          <KV label="Status da nota"><Badge tone={statusTone}>{statusLabel}</Badge><div className="text-xs text-[var(--color-text-muted)]">Emissão {fmtDate(inv.issue_date)}</div></KV>
          <KV label="Itens na nota"><b>{list.length}</b></KV>
          <KV label="Progresso da conciliação">
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]"><div className="h-full bg-[var(--accent-fill)] transition-all" style={{ width: `${viaReceipt ? 100 : pct}%` }} /></div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">{viaReceipt ? 'Entrada pelo recebimento' : `${done} de ${list.length} itens vinculados · ${pct}%`}</div>
          </KV>
        </div>

        {!items ? <Spinner /> : list.length === 0 ? (
          <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">{inv.status === 'summary' ? 'Os itens aparecem depois de baixar o XML completo (abra a nota e dê ciência).' : 'Documento sem itens (entrada manual): não há estoque a conciliar.'}</p>
        ) : viaReceipt ? (
          <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">Esta nota está ligada a pedido/recebimento: o estoque entra pela conferência do recebimento. Ao salvar, o sistema só marca o estoque como conciliado — <b>não lança em dobro</b>.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <div className="font-semibold text-[var(--color-text-primary)]">Itens da nota ({list.length})</div>
                  <p className="text-xs text-[var(--color-text-secondary)]">Clique numa linha e escolha o item do estoque ao lado — ou direto na lista da linha.</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">Local de entrada
                  <select value={loc} disabled={!can} onChange={(e) => void applyLoc(e.target.value)} className={cn(sel, 'w-48')}>
                    <option value="">Selecione…</option>{lookups.locations.filter((l) => l.is_active && (!l.company_id || l.company_id === inv.company_id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
                <table className="w-full min-w-[920px] text-sm">
                  <thead className="bg-[var(--color-surface-hover)] text-left text-[11px] text-[var(--color-text-muted)]">
                    <tr><th className="px-2 py-2">#</th><th className="px-2 py-2">Item da nota</th><th className="px-2 py-2">Un.</th><th className="px-2 py-2 text-right">Qtde</th><th className="px-2 py-2 text-right">Valor total</th>
                      <th className="px-2 py-2">Fator</th><th className="px-2 py-2">Item do estoque</th><th className="px-2 py-2 text-right">Custo</th><th className="px-2 py-2">Status</th></tr>
                  </thead>
                  <tbody>
                    {list.map((it) => {
                      const cat = catalog.find((c) => c.id === it.item_id);
                      const edit = can && !it.stock_posted;
                      const ok = it.stock_posted || (it.item_id && it.location_id && (!cat?.requires_lot || it.lot));
                      return (
                        <tr key={it.id} onClick={() => setMarked(it.id)} className={cn('cursor-pointer border-t border-[var(--color-border-soft)] align-middle', marked === it.id ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-surface-hover)]')}>
                          <td className="px-2 py-1.5 text-[var(--color-text-muted)]">{it.line}</td>
                          <td className="max-w-[260px] px-2 py-1.5"><div className="truncate font-medium" title={it.description}>{it.description}</div>
                            {cat?.requires_lot && edit && (
                              <div className="mt-1 flex gap-1" onClick={(e) => e.stopPropagation()}>
                                <input placeholder="Lote (obrigatório)" defaultValue={it.lot ?? ''} onBlur={(e) => (e.target.value.trim() || null) !== it.lot && void save(it, { lot: e.target.value.trim() || null })} className="h-7 w-32 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-xs" />
                                <input type="date" defaultValue={it.expiry ?? ''} onBlur={(e) => (e.target.value || null) !== it.expiry && void save(it, { expiry: e.target.value || null })} className="h-7 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-xs" aria-label="Validade" />
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5">{it.unit ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{qtyFmt(it.qty)}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatBRL(it.total_cents)}</td>
                          <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>{edit ? <div className="w-16 [&_input]:h-9 [&_input]:w-16 [&_input]:px-2 [&_input]:text-right"><QtyInput value={Number(it.conversion_factor)} onChange={(n) => n > 0 && void save(it, { conversion_factor: n })} /></div> : qtyFmt(it.conversion_factor)}</td>
                          <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                            {edit ? (
                              <select value={it.item_id ?? ''} disabled={busy === it.id} onChange={(e) => void save(it, { item_id: e.target.value || null })} className={cn(sel, 'w-48')}>
                                <option value="">Selecione um item</option>
                                {active.map((x) => <option key={x.id} value={x.id}>{x.code ? `${x.code} · ` : ''}{x.name} ({x.unit})</option>)}
                              </select>
                            ) : cat ? `${cat.name} (${cat.unit})` : '—'}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatBRL(Number(it.conversion_factor) > 0 ? Math.round(it.unit_cents / Number(it.conversion_factor)) : it.unit_cents)}</td>
                          <td className="px-2 py-1.5">{it.stock_posted ? <Badge tone="success">Lançado</Badge> : ok ? <Badge tone="accent">Pronto</Badge> : <Badge tone="warn">Pendente</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            {can && (
              <div className="h-fit space-y-2 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
                <div className="font-semibold text-[var(--color-text-primary)]">Itens do estoque</div>
                <p className="text-xs text-[var(--color-text-secondary)]">Busque e toque no + para vincular à linha marcada{marked ? ` (linha ${list.find((x) => x.id === marked)?.line ?? ''})` : ''}.</p>
                <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Digite para pesquisar…" className={cn(inputCls, 'pl-9')} /></label>
                <ul className="max-h-[360px] overflow-y-auto">
                  {found.length === 0 && <li className="py-3 text-sm text-[var(--color-text-muted)]">Nenhum item encontrado.</li>}
                  {found.map((x) => (
                    <li key={x.id} className="flex items-center gap-2 border-b border-[var(--color-border-soft)] py-2 text-sm last:border-0">
                      <span className="min-w-0 flex-1">{x.name}{x.code && <span className="ml-1 text-xs text-[var(--color-text-muted)]">{x.code}</span>}</span>
                      <span className="text-xs text-[var(--color-text-muted)]">{x.unit}</span>
                      <button type="button" aria-label={`Vincular ${x.name}`} disabled={!marked || !!busy} onClick={() => void linkTo(x.id)} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border-card)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] disabled:opacity-40"><Plus className="h-3.5 w-3.5" /></button>
                    </li>
                  ))}
                </ul>
                <button type="button" disabled={!marked || !!busy} onClick={() => void createFromMarked()} className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">
                  <PackagePlus className="h-4 w-4" /> Cadastrar a linha marcada como item novo
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-4">
          <Button variant="outline" onClick={onOpenNote}><Pencil className="h-4 w-4" /> Abrir a nota</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{can ? 'Cancelar' : 'Fechar'}</Button>
            {can && list.length > 0 && (
              <Button disabled={!!busy || !ready} title={ready ? undefined : 'Ligue todas as linhas a um item, escolha o local (e o lote quando o item exigir).'}
                onClick={async () => {
                  setBusy('post');
                  try { await rpc('pur_invoice_post', { p_id: inv.id, p_finance: false, p_stock: true }); toast.success('Conciliação de estoque salva: entrada feita no almoxarifado.'); await onChanged(); onClose(); }
                  catch (e) { toast.error('Não foi possível dar entrada', { description: e instanceof Error ? e.message : String(e) }); }
                  finally { setBusy(null); }
                }}>
                {busy === 'post' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar conciliação
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
