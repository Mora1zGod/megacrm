import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Building2, Mail, Pencil, Phone, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import { formatCEP, formatDoc, formatPhone } from '@/lib/format';
import { type InstallmentRow } from '../finance/data';
import { StatusBadge } from '../finance/ui';
import {
  fmtDate, fmtDateTime, INVOICE_STATUS, ORDER_STATUS, purError, qtyFmt, rpc,
  type Invoice, type Order, type PurLookups, type Supplier, type TabProps,
} from './data';
import { SupplierForm } from './SupplierForm';
import { Badge, Card, EmptyRow, Field, inputCls, KV, Metric, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, useDebounced } from './ui';
import { DataGrid, useGrid } from '@/components/ui/GridTable';

interface Dash {
  can_finance: boolean; can_purchases: boolean;
  invoices?: { count: number; total_cents: number; total_12m_cents: number; count_12m: number; avg_cents: number; first_date: string | null; last_date: string | null; pending_fin: number; pending_stock: number };
  monthly?: Array<{ month: string; total_cents: number }>;
  orders?: { count: number; open_count: number; open_cents: number; received_count: number; canceled_count: number; total_cents: number; last_at: string | null };
  quotes?: { invited: number; responded: number; won: number };
  deliveries?: { receipts: number; with_divergence: number; late: number };
  top_items?: Array<{ description: string; unit: string | null; qty: number; total_cents: number; last_unit_cents: number }>;
  payables?: { open_cents: number; open_count: number; overdue_cents: number; overdue_count: number; next_due: string | null; paid_12m_cents: number };
}

export function canEditSuppliers(can: (k: string) => boolean) {
  return can('purchases.suppliers') || can('financial.setup');
}

export function SuppliersTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const perms = usePermission();
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [text, setText] = useState('');
  const q = useDebounced(text);
  const [category, setCategory] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<'name' | 'total' | 'last'>('name');

  const load = useCallback(async () => {
    let query = getSupabase().from('pur_suppliers_v').select('*').in('kind', ['supplier', 'both']).limit(2000);
    if (onlyActive) query = query.eq('is_active', true);
    if (category) query = query.eq('category', category);
    const t = q.trim().replace(/[,()]/g, ' ');
    if (t) {
      const d = t.replace(/\D/g, '');
      query = query.or([`name.ilike.%${t}%`, `trade_name.ilike.%${t}%`, `city.ilike.%${t}%`, d.length >= 3 ? `doc.ilike.%${d}%` : ''].filter(Boolean).join(','));
    }
    query = order === 'total' ? query.order('invoices_12m_cents', { ascending: false, nullsFirst: false })
      : order === 'last' ? query.order('last_invoice_date', { ascending: false, nullsFirst: false }) : query.order('name');
    const { data, error } = await query;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Supplier[]);
  }, [q, category, onlyActive, order]);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(() => Array.from(new Set(lookups.suppliers.map((s) => s.category).filter((c): c is string => !!c))).sort(), [lookups.suppliers]);
  const current = openId ? lookups.suppliers.find((s) => s.id === openId) ?? rows?.find((s) => s.id === openId) ?? null : null;
  const totals = useMemo(() => (rows ?? []).reduce((a, r) => ({ open: a.open + (r.open_payable_cents ?? 0), overdue: a.overdue + (r.overdue_cents ?? 0), y: a.y + (r.invoices_12m_cents ?? 0) }), { open: 0, overdue: 0, y: 0 }), [rows]);
  const changed = async () => { await lookups.reload(); await load(); };

  const grid = useGrid('megacrm_grid_pur_suppliers', [
    { id: 'name', label: 'Fornecedor', width: 260, minWidth: 140, sortValue: (s: Supplier) => s.trade_name || s.name, render: (s: Supplier) => <div className="min-w-0"><div className="truncate font-semibold">{s.trade_name || s.name}</div>{s.trade_name && <div className="truncate text-xs text-[var(--color-text-muted)]">{s.name}</div>}{!s.is_active && <Badge tone="muted">inativo</Badge>}</div> },
    { id: 'doc', label: 'CNPJ/CPF', width: 150, sortValue: (s: Supplier) => s.doc ?? '', exportValue: (s: Supplier) => formatDoc(s.doc), render: (s: Supplier) => <span className="whitespace-nowrap tabular-nums">{formatDoc(s.doc)}</span> },
    { id: 'cat', label: 'Categoria', width: 140, sortValue: (s: Supplier) => s.category ?? '', render: (s: Supplier) => <span className="block truncate">{s.category ?? '—'}</span> },
    { id: 'city', label: 'Cidade', width: 140, sortValue: (s: Supplier) => s.city ?? '', render: (s: Supplier) => <span className="block truncate">{s.city ? `${s.city}${s.state ? `/${s.state}` : ''}` : '—'}</span> },
    { id: 'contact', label: 'Contato', width: 170, sortValue: (s: Supplier) => s.contact_name ?? '', render: (s: Supplier) => <div className="min-w-0"><div className="truncate">{s.contact_name ?? ''}</div><div className="truncate text-xs text-[var(--color-text-muted)]">{formatPhone(s.whatsapp || s.phone) || s.email || ''}</div></div> },
    { id: 'buy', label: 'Compras 12m', width: 120, align: 'right' as const, sortValue: (s: Supplier) => s.invoices_12m_cents ?? 0, exportValue: (s: Supplier) => (s.invoices_12m_cents ?? 0) / 100, render: (s: Supplier) => <span className="tabular-nums">{formatBRL(s.invoices_12m_cents ?? 0)}</span> },
    { id: 'last', label: 'Última nota', width: 105, sortValue: (s: Supplier) => s.last_invoice_date ?? '', render: (s: Supplier) => fmtDate(s.last_invoice_date) },
    { id: 'orders', label: 'Pedidos abertos', width: 140, align: 'right' as const, sortValue: (s: Supplier) => s.open_orders_cents ?? 0, render: (s: Supplier) => <span className="tabular-nums">{s.open_orders_count ? `${s.open_orders_count} · ${formatBRL(s.open_orders_cents ?? 0)}` : '—'}</span> },
    { id: 'pay', label: 'A pagar', width: 115, align: 'right' as const, sortValue: (s: Supplier) => s.open_payable_cents ?? 0, exportValue: (s: Supplier) => (s.open_payable_cents ?? 0) / 100, render: (s: Supplier) => <span className="tabular-nums">{s.open_payable_cents ? <span className={s.overdue_cents ? 'text-[var(--color-error)]' : ''}>{formatBRL(s.open_payable_cents)}</span> : '—'}</span> },
  ], rows ?? []);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Fornecedores" value={rows?.length ?? '—'} hint={onlyActive ? 'ativos' : 'todos'} />
        <Metric label="Compras em 12 meses" value={formatBRL(totals.y)} hint="notas de entrada" />
        <Metric label="A pagar" value={formatBRL(totals.open)} hint="parcelas em aberto" />
        <Metric label="Vencido" value={formatBRL(totals.overdue)} tone={totals.overdue ? 'error' : undefined} hint="parcelas vencidas" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Buscar" htmlFor="sp-q"><input id="sp-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome, fantasia, CNPJ, cidade" className={`${inputCls} min-w-[260px]`} /></Field>
        <Field label="Categoria" htmlFor="sp-c">
          <select id="sp-c" value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            <option value="">Todas</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Ordenar" htmlFor="sp-o">
          <select id="sp-o" value={order} onChange={(e) => setOrder(e.target.value as typeof order)} className={inputCls}>
            <option value="name">Nome</option><option value="total">Mais comprado (12 meses)</option><option value="last">Última nota</option>
          </select>
        </Field>
        <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Só ativos</label>
        <div className="flex-1" />
        {canEditSuppliers(perms.can) && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Novo fornecedor</Button>}
      </div>
      {!rows ? <Spinner /> : (
        <DataGrid grid={grid} rowKey={(r) => r.id} onRowClick={(r) => onOpen('supplier', r.id)} emptyText="Nenhum fornecedor." />
      )}
      {creating && <SupplierForm lookups={lookups} supplier={null} categories={categories} onClose={() => setCreating(false)} onSaved={async (id) => { setCreating(false); await changed(); onOpen('supplier', id); }} />}
      {current && !creating && <SupplierDetail supplier={current} lookups={lookups} categories={categories} onClose={onCloseDoc} onOpen={onOpen} onChanged={changed} />}
    </div>
  );
}

function SupplierDetail({ supplier: s, lookups, categories, onClose, onOpen, onChanged }: { supplier: Supplier; lookups: PurLookups; categories: string[]; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void> }) {
  const perms = usePermission();
  const [tab, setTab] = useState<'painel' | 'dados' | 'notas' | 'pedidos' | 'pagar' | 'historico'>('painel');
  const [dash, setDash] = useState<Dash | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [inst, setInst] = useState<InstallmentRow[] | null>(null);
  const [editing, setEditing] = useState(false);
  const canFin = perms.can('financial.ledger_view');

  useEffect(() => {
    let off = false;
    setDash(null);
    rpc<Dash>('pur_supplier_dashboard', { p_party: s.id }).then((d) => { if (!off) setDash(d); }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    const sb = getSupabase();
    void sb.from('pur_invoices_v').select('*').eq('party_id', s.id).order('effective_date', { ascending: false, nullsFirst: false }).limit(300).then(({ data }) => { if (!off) setInvoices((data ?? []) as Invoice[]); });
    void sb.from('pur_orders_v').select('*').eq('party_id', s.id).order('created_at', { ascending: false }).limit(300).then(({ data }) => { if (!off) setOrders((data ?? []) as Order[]); });
    if (canFin) void sb.from('fin_installments_v').select('*').eq('party_id', s.id).eq('kind', 'payable').order('due_date', { ascending: false }).limit(300).then(({ data }) => { if (!off) setInst((data ?? []) as InstallmentRow[]); });
    return () => { off = true; };
  }, [s.id, canFin]);

  const addr = [s.street, s.street_number, s.complement, s.district].filter(Boolean).join(', ');
  const chart = lookups.chart.find((c) => c.id === s.default_chart_account_id);
  const chartData = (dash?.monthly ?? []).map((m) => ({ mes: `${m.month.slice(5)}/${m.month.slice(2, 4)}`, valor: m.total_cents / 100 }));

  return (
    <Dialog open onClose={onClose} widthClass="max-w-6xl" opaque title={s.trade_name || s.name}
      description={`${s.trade_name ? `${s.name} · ` : ''}${formatDoc(s.doc)}${s.category ? ` · ${s.category}` : ''}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-text-secondary)]">
          {!s.is_active && <Badge tone="muted">inativo</Badge>}
          {(s.whatsapp || s.phone) && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {formatPhone(s.whatsapp || s.phone)}</span>}
          {s.email && <a href={`mailto:${s.email}`} className="inline-flex items-center gap-1 hover:underline"><Mail className="h-3.5 w-3.5" /> {s.email}</a>}
          {s.city && <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {s.city}{s.state ? `/${s.state}` : ''}</span>}
          <div className="flex-1" />
          {canEditSuppliers(perms.can) && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Editar cadastro</Button>}
        </div>
        <SubTabs value={tab} onChange={setTab} tabs={[
          ['painel', 'Painel'], ['dados', 'Cadastro'], ['notas', `Notas (${invoices?.length ?? '…'})`], ['pedidos', `Pedidos (${orders?.length ?? '…'})`],
          ...(canFin ? [['pagar', 'Contas a pagar'] as ['pagar', string]] : []), ['historico', 'Histórico'],
        ]} />

        {tab === 'painel' && (!dash ? <Spinner /> : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Compras em 12 meses" value={formatBRL(dash.invoices?.total_12m_cents ?? 0)} hint={`${dash.invoices?.count_12m ?? 0} nota(s) · ticket médio ${formatBRL(dash.invoices?.avg_cents ?? 0)}`} />
              <Metric label="Total histórico" value={formatBRL(dash.invoices?.total_cents ?? 0)} hint={dash.invoices?.first_date ? `desde ${fmtDate(dash.invoices.first_date)} · última ${fmtDate(dash.invoices.last_date)}` : 'sem notas'} />
              <Metric label="Pedidos em aberto" value={formatBRL(dash.orders?.open_cents ?? 0)} hint={`${dash.orders?.open_count ?? 0} aberto(s) · ${dash.orders?.received_count ?? 0} recebido(s)`} />
              {dash.payables
                ? <Metric label="A pagar" value={formatBRL(dash.payables.open_cents)} tone={dash.payables.overdue_cents ? 'error' : undefined}
                    hint={dash.payables.overdue_cents ? `${formatBRL(dash.payables.overdue_cents)} vencido` : dash.payables.next_due ? `próximo venc. ${fmtDate(dash.payables.next_due)}` : 'nada em aberto'} />
                : <Metric label="A pagar" value="—" hint="sem acesso ao Financeiro" />}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Cotações" value={`${dash.quotes?.won ?? 0} ganha(s)`} hint={`de ${dash.quotes?.invited ?? 0} convite(s) · ${dash.quotes?.responded ?? 0} resposta(s)`} />
              <Metric label="Entregas" value={dash.deliveries?.receipts ?? 0} hint={`${dash.deliveries?.with_divergence ?? 0} com divergência · ${dash.deliveries?.late ?? 0} atrasada(s)`} tone={dash.deliveries?.with_divergence ? 'warn' : undefined} />
              <Metric label="Notas pendentes" value={(dash.invoices?.pending_fin ?? 0) + (dash.invoices?.pending_stock ?? 0)} hint={`${dash.invoices?.pending_fin ?? 0} no financeiro · ${dash.invoices?.pending_stock ?? 0} no estoque`} />
              {dash.payables ? <Metric label="Pago em 12 meses" value={formatBRL(dash.payables.paid_12m_cents)} tone="success" /> : <Metric label="Condição habitual" value={s.payment_terms ?? '—'} />}
            </div>
            <Card title="Compras por mês (notas de entrada)">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ left: 8, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-soft)" />
                    <XAxis dataKey="mes" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                    <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                    <Tooltip formatter={(v: number) => formatBRL(Math.round(v * 100))} />
                    <Bar dataKey="valor" name="Compras" fill="var(--accent-fill)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="O que mais compramos dele">
              {(dash.top_items ?? []).length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Sem itens de nota ainda.</p> : (
                <TableWrap minWidth={600}>
                  <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Produto</th><th className={`${thCls} text-right`}>Quantidade</th><th className={`${thCls} text-right`}>Último preço</th><th className={`${thCls} text-right`}>Total</th></tr></thead>
                  <tbody>{dash.top_items!.map((t, i) => (
                    <tr key={i} className="border-b border-[var(--color-border-soft)] last:border-0">
                      <td className={tdCls}>{t.description}</td><td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(t.qty)} {t.unit ?? ''}</td>
                      <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(t.last_unit_cents)}</td><td className={`${tdCls} text-right tabular-nums`}>{formatBRL(t.total_cents)}</td>
                    </tr>))}</tbody>
                </TableWrap>
              )}
            </Card>
          </div>
        ))}

        {tab === 'dados' && (
          <div className="space-y-4">
            <Card title="Identificação"><div className="grid gap-3 sm:grid-cols-4">
              <KV label="Razão social">{s.name}</KV><KV label="Nome fantasia">{s.trade_name}</KV><KV label="CNPJ/CPF">{formatDoc(s.doc)}</KV><KV label="Categoria">{s.category}</KV>
              <KV label="Inscr. estadual">{s.state_registration}</KV><KV label="Inscr. municipal">{s.municipal_registration}</KV>
              <KV label="Tipo">{s.kind === 'both' ? 'Fornecedor e cliente' : s.kind === 'customer' ? 'Cliente' : 'Fornecedor'}</KV><KV label="Desde">{fmtDateTime(s.created_at)}</KV>
            </div></Card>
            {(s.legal_status || s.main_activity || s.founded_on) && (
              <Card title={<span className="flex items-center gap-2">Receita Federal {s.legal_status && <Badge tone={/ATIVA/i.test(s.legal_status) ? 'success' : 'error'}>{s.legal_status}</Badge>}</span>}>
                <div className="grid gap-3 sm:grid-cols-4">
                  <KV label="Abertura">{fmtDate(s.founded_on)}</KV><KV label="Atividade principal">{s.main_activity}</KV>
                  <KV label="Porte">{s.company_size}</KV><KV label="Natureza jurídica">{s.legal_nature}</KV>
                  <KV label="Simples / MEI">{s.simples_nacional === null || s.simples_nacional === undefined ? '—' : `${s.simples_nacional ? 'Optante do Simples' : 'Fora do Simples'}${s.mei ? ' · MEI' : ''}`}</KV>
                  <KV label="Capital social">{s.share_capital_cents !== null && s.share_capital_cents !== undefined ? formatBRL(s.share_capital_cents) : null}</KV>
                  <KV label="Matriz / filial">{s.headquarters}</KV><KV label="Consultado em">{s.cnpj_checked_at ? fmtDateTime(s.cnpj_checked_at) : null}</KV>
                </div>
                {(s.cnpj_data?.qsa?.length ?? 0) > 0 && (
                  <div className="mt-3 text-sm"><span className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">Sócios: </span>
                    {s.cnpj_data!.qsa!.map((q) => `${q.nome_socio}${q.qualificacao_socio ? ` (${q.qualificacao_socio})` : ''}`).join(' · ')}</div>
                )}
              </Card>
            )}
            <Card title="Contato"><div className="grid gap-3 sm:grid-cols-4">
              <KV label="Contato">{s.contact_name}</KV><KV label="Telefone">{formatPhone(s.phone) || null}</KV><KV label="WhatsApp">{formatPhone(s.whatsapp) || null}</KV><KV label="E-mail">{s.email}</KV>
              <KV label="Site">{s.website}</KV>
            </div></Card>
            <Card title="Endereço"><div className="grid gap-3 sm:grid-cols-4">
              <KV label="Endereço">{addr || null}</KV><KV label="Cidade">{s.city ? `${s.city}${s.state ? `/${s.state}` : ''}` : null}</KV><KV label="CEP">{s.zip_code ? formatCEP(s.zip_code) : null}</KV>
            </div></Card>
            <Card title="Pagamento"><div className="grid gap-3 sm:grid-cols-4">
              <KV label="Banco">{s.bank_name}</KV><KV label="Agência / conta">{[s.bank_agency, s.bank_account].filter(Boolean).join(' / ') || null}</KV><KV label="Pix">{s.pix_key}</KV>
              <KV label="Condição habitual">{s.payment_terms}</KV><KV label="Conta do plano">{chart ? `${chart.code} ${chart.name}` : null}</KV>
            </div></Card>
            {s.notes && <Card title="Observações"><p className="whitespace-pre-wrap text-sm">{s.notes}</p></Card>}
          </div>
        )}

        {tab === 'notas' && (!invoices ? <Spinner /> : (
          <TableWrap minWidth={800}>
            <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Nº</th><th className={thCls}>Emissão</th><th className={thCls}>Entrada</th><th className={thCls}>Empresa</th><th className={`${thCls} text-right`}>Valor</th><th className={thCls}>Financeiro</th><th className={thCls}>Situação</th></tr></thead>
            <tbody>
              {invoices.length === 0 && <EmptyRow cols={7} text="Nenhuma nota deste fornecedor." />}
              {invoices.map((n) => (
                <tr key={n.id} onClick={() => onOpen('invoice', n.id)} className="cursor-pointer border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]">
                  <td className={`${tdCls} font-semibold`}>{n.number}{n.series ? `/${n.series}` : ''}</td><td className={tdCls}>{fmtDate(n.issue_date)}</td><td className={tdCls}>{fmtDate(n.entry_date)}</td>
                  <td className={tdCls}>{n.company_name}</td><td className={`${tdCls} text-right tabular-nums`}>{formatBRL(n.total_cents)}</td>
                  <td className={tdCls}>{n.fin_reconciled ? <Badge tone="success">ok</Badge> : <Badge tone="warn">pendente</Badge>}</td>
                  <td className={tdCls}><StatusPill map={INVOICE_STATUS} status={n.status} /></td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ))}

        {tab === 'pedidos' && (!orders ? <Spinner /> : (
          <TableWrap minWidth={700}>
            <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Pedido</th><th className={thCls}>Emitido</th><th className={thCls}>Previsão</th><th className={`${thCls} text-right`}>Total</th><th className={thCls}>Situação</th></tr></thead>
            <tbody>
              {orders.length === 0 && <EmptyRow cols={5} text="Nenhum pedido para este fornecedor." />}
              {orders.map((o) => (
                <tr key={o.id} onClick={() => onOpen('order', o.id)} className="cursor-pointer border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-hover)]">
                  <td className={`${tdCls} font-semibold`}>{o.number ?? 'rascunho'}</td><td className={tdCls}>{o.issued_at ? fmtDateTime(o.issued_at) : '—'}</td><td className={tdCls}>{fmtDate(o.expected_date)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(o.total_cents)}</td><td className={tdCls}><StatusPill map={ORDER_STATUS} status={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ))}

        {tab === 'pagar' && canFin && (!inst ? <Spinner /> : (
          <TableWrap minWidth={800}>
            <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Vencimento</th><th className={thCls}>Descrição</th><th className={thCls}>Empresa</th><th className={`${thCls} text-right`}>Valor</th><th className={`${thCls} text-right`}>Pago</th><th className={thCls}>Situação</th></tr></thead>
            <tbody>
              {inst.length === 0 && <EmptyRow cols={6} text="Nenhuma conta a pagar para este fornecedor." />}
              {inst.map((i) => (
                <tr key={i.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className={tdCls}>{fmtDate(i.due_date)}</td><td className={tdCls}>{i.description}{i.installments_count > 1 ? ` (${i.number}/${i.installments_count})` : ''}</td><td className={tdCls}>{i.company_name}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.amount_cents)}</td><td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.paid_cents)}</td>
                  <td className={tdCls}><StatusBadge status={i.status} partial={i.is_partial} /></td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ))}

        {tab === 'historico' && <AuditList recordIds={[s.id]} tables={['fin_parties']} />}
      </div>
      {editing && <SupplierForm lookups={lookups} supplier={s} categories={categories} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onChanged(); }} />}
    </Dialog>
  );
}
