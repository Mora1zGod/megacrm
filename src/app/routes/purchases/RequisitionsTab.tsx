import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, FileSearch, Pencil, Plus, Send, Trash2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { useAuth } from '@/app/providers/AuthProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuditList } from '../finance/AuditList';
import {
  fmtDate, fmtDateTime, personName, purError, qtyFmt, REQ_STATUS, rpc, todaySP, URGENCY,
  type PurLookups, type ReqItem, type ReqStatus, type Requisition, type TabProps,
} from './data';
import { Badge, Field, inputCls, KV, MoneyInput, QtyInput, ReasonDialog, Spinner, StatusPill, SubTabs, TableWrap, tdCls, thCls, Trace, useOpenDoc } from './ui';
import { DataGrid, useGrid } from '@/components/ui/GridTable';

export function RequisitionsTab({ lookups, openId, onOpen, onCloseDoc }: TabProps) {
  const perms = usePermission();
  const { user } = useAuth();
  const [rows, setRows] = useState<Requisition[] | null>(null);
  const [status, setStatus] = useState<'' | ReqStatus | 'pending'>('');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Requisition | 'new' | null>(null);

  const load = useCallback(async () => {
    let query = getSupabase().from('pur_requisitions_v').select('*').order('created_at', { ascending: false }).limit(500);
    if (status === 'pending') query = query.eq('status', 'submitted');
    else if (status) query = query.eq('status', status);
    if (mine && user) query = query.eq('requested_by', user.id);
    const { data, error } = await query;
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Requisition[]);
  }, [status, mine, user]);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !rows) return rows;
    return rows.filter((r) => [r.number, r.justification, r.team_name, r.cost_center_name, personName(lookups.people, r.requested_by)].some((x) => x?.toLowerCase().includes(t)));
  }, [rows, q, lookups.people]);
  const pendingCount = rows?.filter((r) => r.status === 'submitted').length ?? 0;
  const current = useOpenDoc('pur_requisitions_v', openId, rows);

  const grid = useGrid('megacrm_grid_pur_req', [
    { id: 'number', label: 'Número', width: 110, sortValue: (r: Requisition) => r.number ?? '', render: (r: Requisition) => <span className="font-semibold">{r.number ?? <span className="font-normal text-[var(--color-text-muted)]">rascunho</span>}</span> },
    { id: 'created', label: 'Criada', width: 140, sortValue: (r: Requisition) => r.created_at, render: (r: Requisition) => fmtDateTime(r.created_at) },
    { id: 'by', label: 'Solicitante', width: 160, sortValue: (r: Requisition) => personName(lookups.people, r.requested_by), render: (r: Requisition) => <span className="block truncate">{personName(lookups.people, r.requested_by)}</span> },
    { id: 'team', label: 'Setor / C. custo', width: 180, sortValue: (r: Requisition) => [r.team_name, r.cost_center_name].filter(Boolean).join(' · '), render: (r: Requisition) => <span className="block truncate">{[r.team_name, r.cost_center_name].filter(Boolean).join(' · ') || '—'}</span> },
    { id: 'items', label: 'Itens', width: 70, align: 'right' as const, sortValue: (r: Requisition) => r.items_count, render: (r: Requisition) => <span className="tabular-nums">{r.items_count}</span> },
    { id: 'est', label: 'Estimado', width: 120, align: 'right' as const, sortValue: (r: Requisition) => r.estimated_cents, exportValue: (r: Requisition) => r.estimated_cents / 100, render: (r: Requisition) => <span className="tabular-nums">{formatBRL(r.estimated_cents)}</span> },
    { id: 'urg', label: 'Urgência', width: 100, sortValue: (r: Requisition) => ['low', 'normal', 'high', 'urgent'].indexOf(r.urgency), render: (r: Requisition) => (r.urgency === 'urgent' || r.urgency === 'high' ? <Badge tone={r.urgency === 'urgent' ? 'error' : 'warn'}>{URGENCY[r.urgency]}</Badge> : URGENCY[r.urgency]) },
    { id: 'need', label: 'Precisa até', width: 110, sortValue: (r: Requisition) => r.needed_by ?? '', render: (r: Requisition) => fmtDate(r.needed_by) },
    { id: 'status', label: 'Situação', width: 170, sortValue: (r: Requisition) => REQ_STATUS[r.status][0], render: (r: Requisition) => <StatusPill map={REQ_STATUS} status={r.status} /> },
  ], filtered ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <SubTabs value={status} onChange={setStatus} tabs={[
          ['', 'Todas'], ['draft', 'Rascunhos'], ['pending', `Aguardando aprovação${pendingCount && !status ? ` (${pendingCount})` : ''}`],
          ['approved', 'Aprovadas'], ['quoting', 'Em cotação'], ['ordered', 'Com pedido'], ['done', 'Concluídas'], ['canceled', 'Canceladas'],
        ]} />
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Só as minhas
        </label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar número, justificativa, setor…" className={`${inputCls} max-w-xs`} aria-label="Buscar" />
        <div className="flex-1" />
        {perms.can('purchases.request') && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova requisição</Button>}
      </div>

      {!filtered ? <Spinner /> : (
        <DataGrid grid={grid} rowKey={(r) => r.id} onRowClick={(r) => onOpen('requisition', r.id)} emptyText="Nenhuma requisição por aqui." />
      )}

      {editing && (
        <ReqForm lookups={lookups} req={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); void load(); onOpen('requisition', id); }} />
      )}
      {openId && current && !editing && (
        <ReqDetail req={current} lookups={lookups} onClose={onCloseDoc} onOpen={onOpen} onChanged={load} onEdit={() => setEditing(current)} />
      )}
    </div>
  );
}

interface Line { key: string; item_id: string | null; description: string; qty: number; unit: string; est_unit_cents: number }
const newLine = (): Line => ({ key: Math.random().toString(36).slice(2), item_id: null, description: '', qty: 1, unit: 'UN', est_unit_cents: 0 });

function ReqForm({ lookups, req, onClose, onSaved }: { lookups: PurLookups; req: Requisition | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [companyId, setCompanyId] = useState(req?.company_id ?? lookups.companies.find((c) => c.is_default)?.id ?? '');
  const [teamId, setTeamId] = useState(req?.team_id ?? '');
  const [ccId, setCcId] = useState(req?.cost_center_id ?? '');
  const [urgency, setUrgency] = useState<Requisition['urgency']>(req?.urgency ?? 'normal');
  const [neededBy, setNeededBy] = useState(req?.needed_by ?? '');
  const [just, setJust] = useState(req?.justification ?? '');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) return;
    void getSupabase().from('pur_requisition_items').select('*').eq('requisition_id', req.id).order('created_at').then(({ data }) => {
      const items = (data ?? []) as ReqItem[];
      if (items.length) setLines(items.map((i) => ({ key: i.id, item_id: i.item_id, description: i.description, qty: Number(i.qty), unit: i.unit, est_unit_cents: i.est_unit_cents ?? 0 })));
    });
  }, [req]);

  const set = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Math.round(l.qty * l.est_unit_cents), 0);
  const valid = lines.length > 0 && lines.every((l) => l.description.trim().length >= 2 && l.qty > 0);

  const save = async (send: boolean) => {
    if (!valid) { toast.error('Preencha a descrição e a quantidade de todos os itens.'); return; }
    if (send && just.trim().length < 5) { toast.error('Escreva a justificativa da compra (pelo menos 5 letras).'); return; }
    setBusy(true);
    const sb = getSupabase();
    try {
      const header = {
        company_id: companyId || null, team_id: teamId || null, cost_center_id: ccId || null, urgency,
        needed_by: neededBy || null, justification: just.trim() || null,
      };
      let id = req?.id;
      if (id) {
        const { error } = await sb.from('pur_requisitions').update(header).eq('id', id);
        if (error) throw error;
        const del = await sb.from('pur_requisition_items').delete().eq('requisition_id', id);
        if (del.error) throw del.error;
      } else {
        const { data, error } = await sb.from('pur_requisitions').insert(header).select('id').single();
        if (error) throw error;
        id = data.id as string;
      }
      const { error: ie } = await sb.from('pur_requisition_items').insert(lines.map((l) => ({
        requisition_id: id, item_id: l.item_id, description: l.description.trim(), qty: l.qty, unit: l.unit.trim() || 'UN',
        est_unit_cents: l.est_unit_cents || null,
      })));
      if (ie) throw ie;
      if (send) await rpc('pur_req_submit', { p_id: id });
      toast.success(send ? 'Requisição enviada para aprovação.' : 'Rascunho salvo.');
      onSaved(id!);
    } catch (e) {
      toast.error('Não foi possível salvar', { description: purError(e) });
    } finally { setBusy(false); }
  };

  const activeItems = lookups.items.filter((i) => i.is_active);
  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque title={req ? `Editar requisição ${req.number ?? ''}` : 'Nova requisição de compra'}
      description="Diga o que precisa, quanto e para quando. Quem pede não aprova: depois de enviar, outra pessoa com alçada decide.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Empresa" required htmlFor="rq-co">
          <select id="rq-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            {lookups.companies.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Setor / equipe" htmlFor="rq-team">
          <select id="rq-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {lookups.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Centro de custo" htmlFor="rq-cc">
          <select id="rq-cc" value={ccId} onChange={(e) => setCcId(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {lookups.costCenters.filter((c) => c.is_active || c.id === ccId).map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
          </select>
        </Field>
        <Field label="Urgência" required htmlFor="rq-urg">
          <select id="rq-urg" value={urgency} onChange={(e) => setUrgency(e.target.value as Requisition['urgency'])} className={inputCls}>
            {Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Precisa até" htmlFor="rq-need">
          <input id="rq-need" type="date" min={todaySP()} value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className={inputCls} />
        </Field>
        <div className="flex items-end text-sm text-[var(--color-text-secondary)]">Estimado: <b className="ml-1 tabular-nums text-[var(--color-text-primary)]">{formatBRL(total)}</b></div>
      </div>
      <div className="mt-3">
        <Field label="Justificativa" required htmlFor="rq-just" hint="Para que é a compra. Obrigatória para enviar.">
          <textarea id="rq-just" rows={2} value={just} onChange={(e) => setJust(e.target.value.slice(0, 1000))} className={`${inputCls} h-auto py-2`} placeholder="Ex.: reposição de cloro para o mês de novembro" />
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-sm font-semibold">Itens</div>
        {lines.map((l, idx) => (
          <div key={l.key} className="grid items-end gap-2 rounded-lg border border-[var(--color-border-soft)] p-2 sm:grid-cols-[1fr_2fr_auto_80px_150px_auto]">
            <Field label={idx === 0 ? 'Item do catálogo' : ''} htmlFor={`rq-it-${l.key}`}>
              <select id={`rq-it-${l.key}`} value={l.item_id ?? ''} className={inputCls}
                onChange={(e) => {
                  const it = activeItems.find((x) => x.id === e.target.value);
                  set(l.key, { item_id: it?.id ?? null, ...(it ? { description: it.name, unit: it.unit, est_unit_cents: l.est_unit_cents || it.last_cost_cents || 0 } : {}) });
                }}>
                <option value="">Avulso (sem catálogo)</option>
                {activeItems.map((i) => <option key={i.id} value={i.id}>{i.code ? `${i.code} · ` : ''}{i.name}</option>)}
              </select>
            </Field>
            <Field required={idx === 0} label={idx === 0 ? 'Descrição' : ''} htmlFor={`rq-d-${l.key}`}>
              <input id={`rq-d-${l.key}`} value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} className={inputCls} placeholder="O que comprar" />
            </Field>
            <Field required={idx === 0} label={idx === 0 ? 'Qtd.' : ''} htmlFor={`rq-q-${l.key}`}><QtyInput id={`rq-q-${l.key}`} value={l.qty} onChange={(n) => set(l.key, { qty: n })} /></Field>
            <Field label={idx === 0 ? 'Unid.' : ''} htmlFor={`rq-u-${l.key}`}>
              <input id={`rq-u-${l.key}`} value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value.toUpperCase().slice(0, 6) })} className={inputCls} />
            </Field>
            <Field label={idx === 0 ? 'Preço estimado (un.)' : ''} htmlFor={`rq-p-${l.key}`}>
              <MoneyInput id={`rq-p-${l.key}`} cents={l.est_unit_cents} onChange={(c) => set(l.key, { est_unit_cents: c })} />
            </Field>
            <Button variant="ghost" size="icon" aria-label="Remover item" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus className="h-3.5 w-3.5" /> Adicionar item</Button>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button variant="secondary" disabled={busy} onClick={() => save(false)}>Salvar rascunho</Button>
        <Button disabled={busy} onClick={() => save(true)}><Send className="h-4 w-4" /> Salvar e enviar</Button>
      </div>
    </Dialog>
  );
}

function ReqDetail({ req, lookups, onClose, onOpen, onChanged, onEdit }: {
  req: Requisition; lookups: PurLookups; onClose: () => void; onOpen: (k: string, id: string) => void; onChanged: () => Promise<void>; onEdit: () => void;
}) {
  const perms = usePermission();
  const { user } = useAuth();
  const [items, setItems] = useState<ReqItem[] | null>(null);
  const [reason, setReason] = useState<null | 'reject' | 'return' | 'cancel'>(null);
  const [tab, setTab] = useState<'itens' | 'historico'>('itens');
  const [busy, setBusy] = useState(false);
  const isMine = req.requested_by === user?.id;

  useEffect(() => {
    void getSupabase().from('pur_requisition_items').select('*').eq('requisition_id', req.id).order('created_at').then(({ data }) => setItems((data ?? []) as ReqItem[]));
  }, [req.id, req.status]);

  const act = async (fn: string, args: Record<string, unknown>, ok: string, after?: (r: unknown) => void) => {
    setBusy(true);
    try { const r = await rpc(fn, args); toast.success(ok); await onChanged(); after?.(r); }
    catch (e) { toast.error('Não foi possível concluir', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    const { error } = await getSupabase().from('pur_requisitions').delete().eq('id', req.id);
    setBusy(false);
    if (error) { toast.error(purError(error)); return; }
    toast.success('Rascunho excluído.'); onClose(); void onChanged();
  };

  const editable = (req.status === 'draft' || req.status === 'returned') && (isMine || perms.isAdmin);
  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque title={`Requisição ${req.number ?? '(rascunho)'}`}
      description={`Criada por ${personName(lookups.people, req.requested_by)} em ${fmtDateTime(req.created_at)}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><StatusPill map={REQ_STATUS} status={req.status} /><Trace kind="requisition" id={req.id} onOpen={onOpen} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <KV label="Empresa">{req.company_name}</KV>
          <KV label="Setor">{req.team_name}</KV>
          <KV label="Centro de custo">{req.cost_center_name}</KV>
          <KV label="Urgência">{URGENCY[req.urgency]}</KV>
          <KV label="Precisa até">{fmtDate(req.needed_by)}</KV>
          <KV label="Estimado">{formatBRL(req.estimated_cents)}</KV>
          <KV label="Teto aprovado">{req.approved_limit_cents ? formatBRL(req.approved_limit_cents) : req.status === 'approved' || req.status === 'quoting' || req.status === 'ordered' ? 'sem teto' : '—'}</KV>
          <KV label="Decisão">{req.decided_by ? `${personName(lookups.people, req.decided_by)} · ${fmtDateTime(req.decided_at)}` : '—'}</KV>
        </div>
        {req.justification && <p className="rounded-lg bg-[var(--color-fill-subtle)] p-3 text-sm"><b>Justificativa:</b> {req.justification}</p>}
        {req.decision_reason && <p className="rounded-lg border border-[rgba(245,158,11,0.4)] p-3 text-sm"><b>Motivo da decisão:</b> {req.decision_reason}</p>}
        {req.cancel_reason && <p className="rounded-lg border border-[rgba(239,68,68,0.3)] p-3 text-sm"><b>Cancelada:</b> {req.cancel_reason}</p>}

        <SubTabs value={tab} onChange={setTab} tabs={[['itens', 'Itens'], ['historico', 'Histórico']]} />
        {tab === 'itens' && (!items ? <Spinner /> : (
          <TableWrap minWidth={640}>
            <thead><tr className="border-b border-[var(--color-border-card)]">
              <th className={thCls}>Descrição</th><th className={`${thCls} text-right`}>Qtd.</th><th className={`${thCls} text-right`}>Preço est.</th>
              <th className={`${thCls} text-right`}>Total est.</th><th className={`${thCls} text-right`}>Pedido</th><th className={`${thCls} text-right`}>Recebido</th>
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                  <td className={tdCls}>{i.description}{i.item_id && <Badge tone="accent">catálogo</Badge>}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(i.qty)} {i.unit}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(i.est_unit_cents ?? 0)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(Math.round(Number(i.qty) * (i.est_unit_cents ?? 0)))}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(i.ordered_qty)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{qtyFmt(i.received_qty)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ))}
        {tab === 'historico' && <AuditList recordIds={[req.id, ...(items ?? []).map((i) => i.id)]} />}

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
          {req.status === 'draft' && (isMine || perms.isAdmin) && <Button variant="ghost" disabled={busy} onClick={remove}><Trash2 className="h-4 w-4" /> Excluir rascunho</Button>}
          {editable && <Button variant="outline" onClick={onEdit}><Pencil className="h-4 w-4" /> Editar</Button>}
          {editable && <Button disabled={busy} onClick={() => act('pur_req_submit', { p_id: req.id }, 'Enviada para aprovação.')}><Send className="h-4 w-4" /> Enviar para aprovação</Button>}
          {req.status === 'submitted' && perms.can('purchases.approve') && !isMine && (<>
            <Button variant="outline" disabled={busy} onClick={() => setReason('return')}><Undo2 className="h-4 w-4" /> Devolver p/ correção</Button>
            <Button variant="destructive" disabled={busy} onClick={() => setReason('reject')}><X className="h-4 w-4" /> Reprovar</Button>
            <Button variant="success" disabled={busy} onClick={() => act('pur_req_decide', { p_id: req.id, p_decision: 'approve', p_reason: null }, 'Requisição aprovada.')}><Check className="h-4 w-4" /> Aprovar</Button>
          </>)}
          {req.status === 'submitted' && isMine && <span className="self-center text-xs text-[var(--color-text-muted)]">Aguardando outra pessoa com alçada aprovar.</span>}
          {req.status === 'rejected' && (isMine || perms.isAdmin) && <Button variant="outline" disabled={busy} onClick={() => act('pur_req_reopen', { p_id: req.id }, 'Voltou para rascunho.')}>Reabrir como rascunho</Button>}
          {req.status === 'approved' && perms.can('purchases.quote') && (
            <Button disabled={busy} onClick={() => act('pur_quote_create', { p_requisition: req.id }, 'Cotação aberta.', (id) => onOpen('quotation', String(id)))}><FileSearch className="h-4 w-4" /> Abrir cotação</Button>
          )}
          {!['draft', 'canceled', 'done'].includes(req.status) && (isMine || perms.can('purchases.cancel')) && (
            <Button variant="ghost" disabled={busy} onClick={() => setReason('cancel')}>Cancelar requisição</Button>
          )}
        </div>
      </div>
      {reason && (
        <ReasonDialog danger={reason !== 'return'}
          title={reason === 'cancel' ? 'Cancelar requisição' : reason === 'reject' ? 'Reprovar requisição' : 'Devolver para correção'}
          description={reason === 'return' ? 'Quem pediu poderá corrigir e enviar de novo.' : 'O motivo fica registrado no histórico.'}
          confirmLabel={reason === 'cancel' ? 'Cancelar requisição' : reason === 'reject' ? 'Reprovar' : 'Devolver'}
          onClose={() => setReason(null)}
          onConfirm={async (r) => {
            if (reason === 'cancel') await act('pur_req_cancel', { p_id: req.id, p_reason: r }, 'Requisição cancelada.');
            else await act('pur_req_decide', { p_id: req.id, p_decision: reason, p_reason: r }, reason === 'reject' ? 'Requisição reprovada.' : 'Devolvida para correção.');
            setReason(null);
          }} />
      )}
    </Dialog>
  );
}
