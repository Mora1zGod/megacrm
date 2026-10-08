import { Link } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Search, Star } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatBRL } from '@/lib/money';
import { chartTree, friendlyError, NATURE_LABEL, type Account, type ChartAccount, type Company, type CostCenter, type Lookups, type Nature, type Party } from './data';
import { EmptyRow, Field, inputCls, MoneyInput, SubTabs, TableWrap, tdCls, thCls } from './ui';
import { formatDoc, formatPhone, maskCNPJ, onlyDigits } from '@/lib/format';
import { SupplierFormDialog } from '../purchases/SupplierForm';

type Sec = 'empresas' | 'bancos' | 'plano' | 'centros' | 'pessoas';

export function SetupTab({ lookups }: { lookups: Lookups }) {
  const [sec, setSec] = useState<Sec>('empresas');
  return (
    <div className="space-y-4">
      <SubTabs<Sec> value={sec} onChange={setSec} tabs={[['empresas', 'Empresas do grupo'], ['bancos', 'Bancos e caixas'], ['plano', 'Plano de contas'], ['centros', 'Centros de custo'], ['pessoas', 'Fornecedores e clientes']]} />
      {sec === 'empresas' && <Companies lookups={lookups} />}
      {sec === 'bancos' && <Accounts lookups={lookups} />}
      {sec === 'plano' && <Chart lookups={lookups} />}
      {sec === 'centros' && <CostCenters lookups={lookups} />}
      {sec === 'pessoas' && <Parties lookups={lookups} />}
    </div>
  );
}

async function save(table: string, id: string | null, row: Record<string, unknown>): Promise<boolean> {
  const sb = getSupabase();
  const { error } = id ? await sb.from(table).update(row).eq('id', id) : await sb.from(table).insert(row);
  if (error) { toast.error('Não foi possível salvar', { description: friendlyError(error) }); return false; }
  toast.success('Salvo.');
  return true;
}

function FormDialog({ title, onClose, onSave, children }: { title: string; onClose: () => void; onSave: () => Promise<boolean>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title={title}>
      <div className="space-y-3">{children}</div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={async () => { setBusy(true); try { if (await onSave()) onClose(); } finally { setBusy(false); } }}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
        </Button>
      </div>
    </Dialog>
  );
}

function Header({ text, onNew }: { text: string; onNew?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-[var(--color-text-secondary)]">{text}</p>
      {onNew && <Button onClick={onNew}><Plus className="h-4 w-4" /> Novo</Button>}
    </div>
  );
}

function Active({ on }: { on: boolean }) {
  return <span className={cn('text-xs font-semibold', on ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]')}>{on ? 'Ativo' : 'Inativo'}</span>;
}

// ------------------------------------------------------------------ empresas
function Companies({ lookups }: { lookups: Lookups }) {
  const can = usePermission().can('financial.setup');
  const [edit, setEdit] = useState<Company | 'new' | null>(null);
  return (
    <>
      <Header text="As empresas do grupo. Uma é a padrão (RH e associados lançam nela). Empresa não se exclui — só desativa. O cadastro completo (fiscal, certificados, padrões) fica em Configurações → Empresas." onNew={can ? () => setEdit('new') : undefined} />
      <TableWrap minWidth={600}>
        <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Nome</th><th className={thCls}>CNPJ</th><th className={thCls}>Situação</th><th className={thCls} /></tr></thead>
        <tbody>
          {lookups.companies.length === 0 && <EmptyRow cols={4} text="Nenhuma empresa." />}
          {lookups.companies.map((c) => (
            <tr key={c.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls}><b>{c.name}</b>{c.is_default && <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-primary)]"><Star className="h-3 w-3" /> padrão</span>}</td>
              <td className={tdCls}>{formatDoc(c.cnpj)}</td>
              <td className={tdCls}><Active on={c.is_active} /></td>
              <td className={cn(tdCls, 'text-right')}><Link to={`/configuracoes/empresas/${c.id}`} className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 text-xs font-semibold hover:bg-[var(--color-surface-hover)]"><Pencil className="h-3.5 w-3.5" /> {can ? 'Editar cadastro' : 'Ver cadastro'}</Link></td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {edit && <CompanyForm company={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => void lookups.reload()} />}
    </>
  );
}

function CompanyForm({ company, onClose, onSaved }: { company: Company | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(company?.name ?? '');
  const [cnpj, setCnpj] = useState(maskCNPJ(company?.cnpj));
  const [active, setActive] = useState(company?.is_active ?? true);
  const [isDefault, setIsDefault] = useState(company?.is_default ?? false);
  return (
    <FormDialog title={company ? 'Editar empresa' : 'Nova empresa'} onClose={onClose}
      onSave={async () => {
        const ok = await save('fin_companies', company?.id ?? null, { name: name.trim(), cnpj: onlyDigits(cnpj) || null, is_active: active, is_default: isDefault });
        if (ok) onSaved();
        return ok;
      }}>
      <Field label="Nome" required htmlFor="co-name"><input id="co-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
      <Field label="CNPJ" htmlFor="co-cnpj"><input id="co-cnpj" value={cnpj} inputMode="numeric" onChange={(e) => setCnpj(maskCNPJ(e.target.value))} className={inputCls} placeholder="00.000.000/0000-00" /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativa</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} disabled={company?.is_default} onChange={(e) => setIsDefault(e.target.checked)} /> Empresa padrão</label>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ bancos e caixas
function Accounts({ lookups }: { lookups: Lookups }) {
  const can = usePermission().can('financial.setup');
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  return (
    <>
      <Header text="Contas bancárias e caixas de cada empresa. Quem tem movimento não troca de empresa nem é excluído." onNew={can ? () => setEdit('new') : undefined} />
      <TableWrap minWidth={860}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Nome</th><th className={thCls}>Tipo</th><th className={thCls}>Empresa</th><th className={thCls}>Banco · Agência · Conta</th>
          <th className={cn(thCls, 'text-right')}>Saldo inicial</th><th className={cn(thCls, 'text-right')}>Saldo atual</th><th className={thCls}>Situação</th><th className={thCls} />
        </tr></thead>
        <tbody>
          {lookups.accounts.length === 0 && <EmptyRow cols={8} text="Nenhuma conta." />}
          {lookups.accounts.map((a) => (
            <tr key={a.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls}><b>{a.name}</b></td>
              <td className={tdCls}>{a.kind === 'cash' ? 'Caixa' : 'Banco'}</td>
              <td className={tdCls}>{a.company_name}</td>
              <td className={cn(tdCls, 'text-xs text-[var(--color-text-secondary)]')}>{[a.bank_name, a.agency, a.account_number].filter(Boolean).join(' · ') || '—'}</td>
              <td className={cn(tdCls, 'text-right tabular-nums')}>{formatBRL(a.opening_balance_cents)}</td>
              <td className={cn(tdCls, 'text-right font-semibold tabular-nums')}>{formatBRL(a.balance_cents)}</td>
              <td className={tdCls}><Active on={a.is_active} /></td>
              <td className={cn(tdCls, 'text-right')}>{can && <Button size="sm" variant="outline" onClick={() => setEdit(a)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {edit && <AccountForm account={edit === 'new' ? null : edit} lookups={lookups} onClose={() => setEdit(null)} />}
    </>
  );
}

function AccountForm({ account, lookups, onClose }: { account: Account | null; lookups: Lookups; onClose: () => void }) {
  const locked = Boolean(account && account.movements_count > 0);
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<'bank' | 'cash'>(account?.kind ?? 'bank');
  const [company, setCompany] = useState(account?.company_id ?? lookups.companies.find((c) => c.is_default)?.id ?? '');
  const [bank, setBank] = useState(account?.bank_name ?? '');
  const [agency, setAgency] = useState(account?.agency ?? '');
  const [number, setNumber] = useState(account?.account_number ?? '');
  const [opening, setOpening] = useState(account?.opening_balance_cents ?? 0);
  const [active, setActive] = useState(account?.is_active ?? true);
  return (
    <FormDialog title={account ? 'Editar banco/caixa' : 'Novo banco/caixa'} onClose={onClose}
      onSave={async () => {
        const row: Record<string, unknown> = { name: name.trim(), kind, bank_name: bank || null, agency: agency || null, account_number: number || null, is_active: active };
        if (!locked) { row.company_id = company; row.opening_balance_cents = opening; }
        const ok = await save('fin_accounts', account?.id ?? null, row);
        if (ok) void lookups.reload();
        return ok;
      }}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nome" required htmlFor="ac-name"><input id="ac-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Ex.: Sicredi AMAI" /></Field>
        <Field label="Tipo" required htmlFor="ac-kind">
          <select id="ac-kind" value={kind} onChange={(e) => setKind(e.target.value as 'bank' | 'cash')} className={inputCls}><option value="bank">Banco</option><option value="cash">Caixa</option></select>
        </Field>
      </div>
      <Field label="Empresa dona" required htmlFor="ac-company" hint={locked ? 'Já tem movimento: a empresa não muda.' : undefined}>
        <select id="ac-company" disabled={locked} value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls}>
          {lookups.companies.filter((c) => c.is_active || c.id === company).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {kind === 'bank' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Banco" htmlFor="ac-bank"><input id="ac-bank" value={bank} onChange={(e) => setBank(e.target.value)} className={inputCls} /></Field>
          <Field label="Agência" htmlFor="ac-ag"><input id="ac-ag" value={agency} onChange={(e) => setAgency(e.target.value)} className={inputCls} /></Field>
          <Field label="Conta" htmlFor="ac-num"><input id="ac-num" value={number} onChange={(e) => setNumber(e.target.value)} className={inputCls} /></Field>
        </div>
      )}
      <Field label="Saldo inicial" htmlFor="ac-open" hint={locked ? 'Já tem movimento: o saldo inicial não muda.' : undefined}>
        <MoneyInput id="ac-open" cents={opening} onChange={setOpening} disabled={locked} />
      </Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativa</label>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ plano de contas
const NATURES = Object.keys(NATURE_LABEL) as Nature[];

function Chart({ lookups }: { lookups: Lookups }) {
  const can = usePermission().can('financial.setup');
  const [edit, setEdit] = useState<ChartAccount | 'new' | null>(null);
  const [q, setQ] = useState('');
  const all = chartTree(lookups.chart);
  // Busca: mostra as contas que batem e as agrupadoras acima delas.
  const tree = (() => {
    const t = q.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!t) return all;
    const hit = new Set(all.filter((c) => `${c.code} ${c.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(t)).map((c) => c.id));
    const byId = new Map(all.map((c) => [c.id, c]));
    for (const id of Array.from(hit)) { let p = byId.get(id)?.parent_id; while (p) { hit.add(p); p = byId.get(p)?.parent_id ?? null; } }
    return all.filter((c) => hit.has(c.id));
  })();
  return (
    <>
      <Header text="Sintética agrupa; só analítica recebe lançamento. Conta a pagar usa despesas e deduções; a receber, só receitas." onNew={can ? () => setEdit('new') : undefined} />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar conta por código ou nome…" aria-label="Pesquisar no plano de contas" className={cn(inputCls, 'pl-9')} />
      </div>
      <TableWrap minWidth={760}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Código / Nome</th><th className={thCls}>Tipo</th><th className={thCls}>Natureza</th><th className={thCls}>Nível</th><th className={thCls}>Situação</th><th className={thCls} />
        </tr></thead>
        <tbody>
          {tree.length === 0 && <EmptyRow cols={6} text="Plano de contas vazio." />}
          {tree.map((c) => (
            <tr key={c.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls} style={{ paddingLeft: 12 + c.depth * 18 }}>
                <span className={cn('tabular-nums', c.is_synthetic && 'font-bold')}>{c.code}</span> <span className={c.is_synthetic ? 'font-bold' : ''}>{c.name}</span>
              </td>
              <td className={tdCls}>{c.type === 'revenue' ? 'Receita' : 'Despesa'}</td>
              <td className={cn(tdCls, 'text-xs')}>{NATURE_LABEL[c.nature]}</td>
              <td className={cn(tdCls, 'text-xs')}>{c.is_synthetic ? 'Sintética' : 'Analítica'}</td>
              <td className={tdCls}><Active on={c.is_active} /></td>
              <td className={cn(tdCls, 'text-right')}>{can && <Button size="sm" variant="outline" onClick={() => setEdit(c)}><Pencil className="h-3.5 w-3.5" /></Button>}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {edit && <ChartForm item={edit === 'new' ? null : edit} lookups={lookups} onClose={() => setEdit(null)} />}
    </>
  );
}

function ChartForm({ item, lookups, onClose }: { item: ChartAccount | null; lookups: Lookups; onClose: () => void }) {
  const [parent, setParent] = useState(item?.parent_id ?? '');
  const parentRow = lookups.chart.find((c) => c.id === parent);
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [type, setType] = useState<'revenue' | 'expense'>(item?.type ?? 'expense');
  const [nature, setNature] = useState<Nature>(item?.nature ?? 'operating_expense');
  const [synthetic, setSynthetic] = useState(item?.is_synthetic ?? false);
  const [active, setActive] = useState(item?.is_active ?? true);
  const pickParent = (id: string) => {
    setParent(id);
    const p = lookups.chart.find((c) => c.id === id);
    if (p) {
      setType(p.type); setNature(p.nature);
      if (!item) {
        const kids = lookups.chart.filter((c) => c.parent_id === p.id).length;
        setCode(`${p.code}.${String(kids + 1).padStart(2, '0')}`);
      }
    }
  };
  return (
    <FormDialog title={item ? 'Editar conta' : 'Nova conta'} onClose={onClose}
      onSave={async () => {
        const ok = await save('fin_chart_accounts', item?.id ?? null, { parent_id: parent || null, code: code.trim(), name: name.trim(), type, nature, is_synthetic: synthetic, is_active: active });
        if (ok) void lookups.reload();
        return ok;
      }}>
      <Field label="Conta-pai (agrupadora)" htmlFor="ch-parent">
        <select id="ch-parent" value={parent} onChange={(e) => pickParent(e.target.value)} className={inputCls}>
          <option value="">— nível principal —</option>
          {chartTree(lookups.chart).filter((c) => c.is_synthetic && c.id !== item?.id).map((c) => <option key={c.id} value={c.id}>{'· '.repeat(c.depth)}{c.code} {c.name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-[140px_1fr] gap-3">
        <Field label="Código" required htmlFor="ch-code"><input id="ch-code" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} placeholder="4.07" /></Field>
        <Field label="Nome" required htmlFor="ch-name"><input id="ch-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tipo" required htmlFor="ch-type">
          <select id="ch-type" disabled={Boolean(parentRow)} value={type} onChange={(e) => setType(e.target.value as 'revenue' | 'expense')} className={inputCls}>
            <option value="revenue">RECEITA</option><option value="expense">DESPESA</option>
          </select>
        </Field>
        <Field label="Natureza" required htmlFor="ch-nat">
          <select id="ch-nat" value={nature} onChange={(e) => setNature(e.target.value as Nature)} className={inputCls}>
            {NATURES.map((n) => <option key={n} value={n}>{NATURE_LABEL[n]}</option>)}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} /> Sintética (só agrupa, não recebe lançamento)</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativa</label>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ centros de custo
function CostCenters({ lookups }: { lookups: Lookups }) {
  const can = usePermission().can('financial.setup');
  const [edit, setEdit] = useState<CostCenter | 'new' | null>(null);
  const byParent = (p: string | null): CostCenter[] => lookups.costCenters.filter((c) => (c.parent_id ?? null) === p);
  const flat: Array<CostCenter & { depth: number }> = [];
  const walk = (p: string | null, d: number) => { for (const c of byParent(p)) { flat.push({ ...c, depth: d }); walk(c.id, d + 1); } };
  walk(null, 0);
  return (
    <>
      <Header text="Hierárquicos e opcionais no lançamento. Aparecem no relatório de Custos." onNew={can ? () => setEdit('new') : undefined} />
      <TableWrap minWidth={520}>
        <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Centro de custo</th><th className={thCls}>Situação</th><th className={thCls} /></tr></thead>
        <tbody>
          {flat.length === 0 && <EmptyRow cols={3} text="Nenhum centro de custo." />}
          {flat.map((c) => (
            <tr key={c.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls} style={{ paddingLeft: 12 + c.depth * 18 }}>{c.code && <span className="mr-1 tabular-nums text-[var(--color-text-muted)]">{c.code}</span>}{c.name}</td>
              <td className={tdCls}><Active on={c.is_active} /></td>
              <td className={cn(tdCls, 'text-right')}>{can && <Button size="sm" variant="outline" onClick={() => setEdit(c)}><Pencil className="h-3.5 w-3.5" /></Button>}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {edit && <CostCenterForm item={edit === 'new' ? null : edit} lookups={lookups} onClose={() => setEdit(null)} />}
    </>
  );
}

function CostCenterForm({ item, lookups, onClose }: { item: CostCenter | null; lookups: Lookups; onClose: () => void }) {
  const [parent, setParent] = useState(item?.parent_id ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  return (
    <FormDialog title={item ? 'Editar centro de custo' : 'Novo centro de custo'} onClose={onClose}
      onSave={async () => {
        const ok = await save('fin_cost_centers', item?.id ?? null, { parent_id: parent || null, code: code.trim() || null, name: name.trim(), is_active: active });
        if (ok) void lookups.reload();
        return ok;
      }}>
      <Field label="Pertence a" htmlFor="cc-parent">
        <select id="cc-parent" value={parent} onChange={(e) => setParent(e.target.value)} className={inputCls}>
          <option value="">— nível principal —</option>
          {lookups.costCenters.filter((c) => c.id !== item?.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <Field label="Código" htmlFor="cc-code"><input id="cc-code" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} /></Field>
        <Field label="Nome" required htmlFor="cc-name"><input id="cc-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Ex.: Parque aquático" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativo</label>
    </FormDialog>
  );
}

// ------------------------------------------------------------------ pessoas
function Parties({ lookups }: { lookups: Lookups }) {
  const perms = usePermission();
  const can = perms.can('financial.setup') || perms.can('financial.ledger_create');
  const [edit, setEdit] = useState<Party | 'new' | null>(null);
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const digits = t.replace(/\D/g, '');
  const list = lookups.parties.filter((p) => !t || p.name.toLowerCase().includes(t) || (digits && (p.doc ?? '').includes(digits)));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou CPF/CNPJ" className={cn(inputCls, 'pl-9')} />
        </label>
        {can && <Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Novo</Button>}
      </div>
      <TableWrap minWidth={760}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Nome</th><th className={thCls}>Tipo</th><th className={thCls}>CPF/CNPJ</th><th className={thCls}>Contato</th><th className={thCls}>Situação</th><th className={thCls} />
        </tr></thead>
        <tbody>
          {list.length === 0 && <EmptyRow cols={6} text="Ninguém encontrado." />}
          {list.slice(0, 500).map((p) => (
            <tr key={p.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls}><b>{p.name}</b></td>
              <td className={cn(tdCls, 'text-xs')}>{{ supplier: 'Fornecedor', customer: 'Cliente', both: 'Fornecedor e cliente' }[p.kind]}</td>
              <td className={cn(tdCls, 'tabular-nums')}>{formatDoc(p.doc)}</td>
              <td className={cn(tdCls, 'text-xs text-[var(--color-text-secondary)]')}>{[p.email, formatPhone(p.phone)].filter(Boolean).join(' · ') || '—'}</td>
              <td className={tdCls}><Active on={p.is_active} /></td>
              <td className={cn(tdCls, 'text-right')}>{can && <Button size="sm" variant="outline" onClick={() => setEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {edit && <SupplierFormDialog supplierId={edit === 'new' ? null : edit.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void lookups.reload(); }} />}
    </>
  );
}

export { formatDoc };


