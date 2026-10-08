import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { fmtDate, purError, qtyFmt, type InvItem, type InvLocation, type PurLookups } from './data';
import { Badge, EmptyRow, Field, inputCls, MoneyInput, SubTabs, TableWrap, tdCls, thCls } from './ui';
import { DataGrid, useGrid } from '@/components/ui/GridTable';
import { ChartPicker } from '../finance/ui';

interface Balance { item_id: string; item_name: string; unit: string; location_id: string; location_name: string; lot: string | null; expiry: string | null; qty: number }

// Base do estoque usada por Compras (itens, locais e saldo). O módulo Estoque completo vem depois.
export function CatalogTab({ lookups }: { lookups: PurLookups }) {
  const perms = usePermission();
  const can = perms.can('inventory.setup');
  const [sec, setSec] = useState<'itens' | 'locais' | 'saldo'>('itens');
  const [q, setQ] = useState('');
  const [editItem, setEditItem] = useState<InvItem | 'new' | null>(null);
  const [editLoc, setEditLoc] = useState<InvLocation | 'new' | null>(null);
  const [bal, setBal] = useState<Balance[] | null>(null);
  useEffect(() => {
    if (sec !== 'saldo') return;
    void getSupabase().from('inv_balances_v').select('*').order('item_name').then(({ data, error }) => { if (error) toast.error(purError(error)); setBal(((data ?? []) as Balance[]).filter((b) => Number(b.qty) !== 0)); });
  }, [sec]);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return lookups.items.filter((i) => !t || [i.name, i.code, i.gtin].some((x) => x?.toLowerCase().includes(t)));
  }, [lookups.items, q]);

  const grid = useGrid('megacrm_grid_inv_items', [
    { id: 'code', label: 'Código', width: 100, sortValue: (i: InvItem) => i.code ?? '', render: (i: InvItem) => i.code ?? '—' },
    { id: 'name', label: 'Item', width: 300, minWidth: 140, sortValue: (i: InvItem) => i.name, render: (i: InvItem) => <span className="block truncate">{i.name}{!i.is_active && <span className="ml-1"><Badge tone="muted">inativo</Badge></span>}</span> },
    { id: 'unit', label: 'Unid.', width: 70, sortValue: (i: InvItem) => i.unit, render: (i: InvItem) => i.unit },
    { id: 'ean', label: 'EAN / NCM', width: 180, sortValue: (i: InvItem) => i.gtin ?? i.ncm ?? '', exportValue: (i: InvItem) => [i.gtin, i.ncm].filter(Boolean).join(' · '), render: (i: InvItem) => <span className="text-xs">{[i.gtin, i.ncm].filter(Boolean).join(' · ') || '—'}</span> },
    { id: 'cost', label: 'Último custo', width: 120, align: 'right' as const, sortValue: (i: InvItem) => i.last_cost_cents ?? -1, render: (i: InvItem) => <span className="tabular-nums">{i.last_cost_cents !== null ? formatBRL(i.last_cost_cents) : '—'}</span> },
    { id: 'lot', label: 'Lote', width: 100, sortValue: (i: InvItem) => (i.requires_lot ? 1 : 0), exportValue: (i: InvItem) => (i.requires_lot ? 'exige lote' : ''), render: (i: InvItem) => (i.requires_lot ? <Badge tone="warn">exige lote</Badge> : '—') },
  ], items ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs value={sec} onChange={setSec} tabs={[['itens', `Itens (${lookups.items.length})`], ['locais', `Locais (${lookups.locations.length})`], ['saldo', 'Saldo atual']]} />
        {sec === 'itens' && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar item, código, EAN" className={`${inputCls} max-w-xs`} aria-label="Buscar" />}
        <div className="flex-1" />
        {can && sec === 'itens' && <Button onClick={() => setEditItem('new')}><Plus className="h-4 w-4" /> Novo item</Button>}
        {can && sec === 'locais' && <Button onClick={() => setEditLoc('new')}><Plus className="h-4 w-4" /> Novo local</Button>}
      </div>
      {sec === 'itens' && (
        <DataGrid grid={grid} rowKey={(r) => r.id} emptyText="Nenhum item cadastrado." actionsWidth={60} actions={can ? (i) => <Button size="sm" variant="ghost" onClick={() => setEditItem(i)} aria-label="Editar item"><Pencil className="h-3.5 w-3.5" /></Button> : undefined} />
      )}
      {sec === 'locais' && (
        <TableWrap minWidth={500}>
          <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Local</th><th className={thCls}>Empresa</th><th className={thCls}>Situação</th><th className={thCls}></th></tr></thead>
          <tbody>
            {lookups.locations.length === 0 && <EmptyRow cols={4} text="Cadastre ao menos um local (ex.: Almoxarifado, Cozinha, Casa de máquinas)." />}
            {lookups.locations.map((l) => (
              <tr key={l.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={tdCls}>{l.name}</td><td className={tdCls}>{lookups.companies.find((c) => c.id === l.company_id)?.name ?? 'Todas'}</td>
                <td className={tdCls}>{l.is_active ? 'Ativo' : <Badge tone="muted">inativo</Badge>}</td>
                <td className={`${tdCls} text-right`}>{can && <Button size="sm" variant="ghost" onClick={() => setEditLoc(l)}><Pencil className="h-3.5 w-3.5" /></Button>}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {sec === 'saldo' && (
        <TableWrap minWidth={700}>
          <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>Item</th><th className={thCls}>Local</th><th className={thCls}>Lote</th><th className={thCls}>Validade</th><th className={`${thCls} text-right`}>Saldo</th></tr></thead>
          <tbody>
            {bal?.length === 0 && <EmptyRow cols={5} text="Sem saldo ainda. O estoque entra pelos recebimentos e notas." />}
            {(bal ?? []).map((b, i) => (
              <tr key={i} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={tdCls}>{b.item_name}</td><td className={tdCls}>{b.location_name}</td><td className={tdCls}>{b.lot ?? '—'}</td><td className={tdCls}>{fmtDate(b.expiry)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(b.qty)} {b.unit}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {editItem && <ItemForm item={editItem === 'new' ? null : editItem} lookups={lookups} onClose={() => setEditItem(null)} />}
      {editLoc && <LocationForm loc={editLoc === 'new' ? null : editLoc} lookups={lookups} onClose={() => setEditLoc(null)} />}
    </div>
  );
}

function ItemForm({ item, lookups, onClose }: { item: InvItem | null; lookups: PurLookups; onClose: () => void }) {
  const [f, setF] = useState({ code: item?.code ?? '', name: item?.name ?? '', unit: item?.unit ?? 'UN', requires_lot: item?.requires_lot ?? false, ncm: item?.ncm ?? '', gtin: item?.gtin ?? '', chart_account_id: item?.chart_account_id ?? '', is_active: item?.is_active ?? true, last_cost_cents: item?.last_cost_cents ?? 0 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (f.name.trim().length < 2) { toast.error('Informe o nome do item.'); return; }
    setBusy(true);
    const row = { code: f.code.trim() || null, name: f.name.trim(), unit: f.unit.trim().toUpperCase() || 'UN', requires_lot: f.requires_lot, ncm: f.ncm.trim() || null, gtin: f.gtin.trim() || null, chart_account_id: f.chart_account_id || null, is_active: f.is_active, last_cost_cents: f.last_cost_cents || null };
    const sb = getSupabase();
    const { error } = item ? await sb.from('inv_items').update(row).eq('id', item.id) : await sb.from('inv_items').insert(row);
    setBusy(false);
    if (error) { toast.error(/duplicate|unique/i.test(error.message) ? 'Já existe um item com esse código.' : purError(error)); return; }
    toast.success('Item salvo.'); void lookups.reload(); onClose();
  };
  return (
    <Dialog open onClose={onClose} opaque title={item ? 'Editar item' : 'Novo item'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Código interno" htmlFor="it-code"><input id="it-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className={inputCls} /></Field>
        <Field label="Unidade" required htmlFor="it-unit"><input id="it-unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value.toUpperCase().slice(0, 6) })} className={inputCls} /></Field>
        <div className="sm:col-span-2"><Field label="Nome" required htmlFor="it-name"><input id="it-name" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} /></Field></div>
        <Field label="Código de barras (EAN)" htmlFor="it-gtin"><input id="it-gtin" value={f.gtin} onChange={(e) => setF({ ...f, gtin: e.target.value.replace(/\D/g, '') })} className={inputCls} /></Field>
        <Field label="NCM" htmlFor="it-ncm"><input id="it-ncm" value={f.ncm} onChange={(e) => setF({ ...f, ncm: e.target.value.replace(/\D/g, '').slice(0, 8) })} className={inputCls} /></Field>
        <Field label="Último custo" htmlFor="it-cost"><MoneyInput id="it-cost" cents={f.last_cost_cents} onChange={(c) => setF({ ...f, last_cost_cents: c })} /></Field>
        <Field label="Conta do plano" htmlFor="it-chart">
          <ChartPicker id="it-chart" chart={lookups.chart} kind="payable" value={f.chart_account_id} onChange={(v) => setF({ ...f, chart_account_id: v })} emptyLabel="—" />
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requires_lot} onChange={(e) => setF({ ...f, requires_lot: e.target.checked })} /> Exige lote e validade</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Ativo</label>
      </div>
      <div className="flex justify-end gap-2 pt-5"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button disabled={busy} onClick={save}>Salvar</Button></div>
    </Dialog>
  );
}

function LocationForm({ loc, lookups, onClose }: { loc: InvLocation | null; lookups: PurLookups; onClose: () => void }) {
  const [name, setName] = useState(loc?.name ?? '');
  const [companyId, setCompanyId] = useState(loc?.company_id ?? '');
  const [active, setActive] = useState(loc?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} opaque title={loc ? 'Editar local' : 'Novo local de estoque'}>
      <div className="space-y-3">
        <Field label="Nome" required htmlFor="lc-name"><input id="lc-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Ex.: Almoxarifado" /></Field>
        <Field label="Empresa" htmlFor="lc-co">
          <select id="lc-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            <option value="">Todas</option>{lookups.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativo</label>
      </div>
      <div className="flex justify-end gap-2 pt-5"><Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy || name.trim().length < 2} onClick={async () => {
          setBusy(true);
          const row = { name: name.trim(), company_id: companyId || null, is_active: active };
          const sb = getSupabase();
          const { error } = loc ? await sb.from('inv_locations').update(row).eq('id', loc.id) : await sb.from('inv_locations').insert(row);
          setBusy(false);
          if (error) { toast.error(purError(error)); return; }
          toast.success('Local salvo.'); void lookups.reload(); onClose();
        }}>Salvar</Button>
      </div>
    </Dialog>
  );
}
