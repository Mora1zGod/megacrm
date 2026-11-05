import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Camera, Clock, Copy, Fingerprint, Loader2, Plus, RefreshCw, ScanFace, UserMinus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatDoc, maskDoc, onlyDigits } from '@/lib/format';
import { searchMatch } from '@/lib/search';
import { fmtDate, fmtDateTime, friendlyError } from '../finance/data';
import { CompanySelect, EmptyRow, Field, inputCls, TableWrap, tdCls, thCls } from '../finance/ui';
import {
  CMD_LABEL, EVENT_LABEL, PONTO_BUCKET, dayStartIso, fmtInTz, prepareFacePhoto, pushUrl, todayIn, usePontoLookups, usePontoPhoto, validCpf,
  type Device, type DeviceCmd, type DeviceLog, type Employee, type Mark, type PontoLookups,
} from './data';

type Tab = 'batidas' | 'funcionarios' | 'aparelhos';
const TZ = 'America/Rio_Branco';

export default function PontoPage() {
  const perms = usePermission();
  const lookups = usePontoLookups();
  const [params, setParams] = useSearchParams();
  const canManage = perms.can('ponto.manage');
  const tabs: [Tab, string, boolean][] = [
    ['batidas', 'Batidas', true],
    ['funcionarios', 'Funcionários', true],
    ['aparelhos', 'Aparelhos', canManage],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const tab = (visible.find(([k]) => k === params.get('tab'))?.[0] ?? 'batidas') as Tab;
  const setTab = (t: Tab) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><Fingerprint className="h-5 w-5" /></span>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Ponto</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Batidas do reconhecimento facial (Control iD), funcionários e aparelhos.</p>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border-card)]" role="tablist">
        {visible.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors',
              tab === id ? 'border-[var(--accent-fill)] text-[var(--accent-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
            {label}
          </button>
        ))}
      </div>

      {lookups.missing && (
        <div className="rounded-[var(--radius-card)] border border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] p-3 text-sm text-[var(--color-text-primary)]">
          O módulo de ponto ainda não foi instalado no banco. Rode o SQL <b>20261105100000_ponto_base.sql</b> no Supabase.
        </div>
      )}
      {lookups.error && (
        <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{lookups.error}</div>
      )}

      {!lookups.missing && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'batidas' && <MarksTab lookups={lookups} canManage={canManage} />}
          {tab === 'funcionarios' && <EmployeesTab lookups={lookups} canManage={canManage} />}
          {tab === 'aparelhos' && canManage && <DevicesTab lookups={lookups} />}
        </div>
      )}
    </div>
  );
}

// ============================================================================ Batidas
function MarksTab({ lookups, canManage }: { lookups: PontoLookups; canManage: boolean }) {
  const [day, setDay] = useState(todayIn(TZ));
  const [days, setDays] = useState(1);
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLogs, setShowLogs] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const from = dayStartIso(day, TZ);
    const to = new Date(Date.parse(from) + days * 86_400_000).toISOString();
    const sb = getSupabase();
    let mq = sb.from('ponto_marks').select('*').gte('marked_at', from).lt('marked_at', to).order('marked_at', { ascending: false }).limit(3000);
    if (company) mq = mq.eq('company_id', company);
    const [m, l] = await Promise.all([
      mq,
      canManage
        ? sb.from('ponto_device_logs').select('*').gte('received_at', from).lt('received_at', to).is('mark_id', null).order('received_at', { ascending: false }).limit(300)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (m.error) toast.error('Não foi possível carregar as batidas', { description: friendlyError(m.error) });
    setMarks((m.data ?? []) as Mark[]);
    setLogs((l.data ?? []) as DeviceLog[]);
    setLoading(false);
  }, [day, days, company, canManage]);
  useEffect(() => { void load(); }, [load]);

  // Batida nova aparece sozinha.
  useEffect(() => {
    const ch = getSupabase().channel('ponto-marks')
      .on('postgres_changes', { event: 'INSERT', schema: 'whatsapp_hub', table: 'ponto_marks' }, () => { void load(); })
      .subscribe();
    return () => { void getSupabase().removeChannel(ch); };
  }, [load]);

  const emp = useMemo(() => new Map(lookups.employees.map((e) => [e.id, e])), [lookups.employees]);
  const empByDevUser = useMemo(() => new Map(lookups.employees.map((e) => [e.device_user_id, e])), [lookups.employees]);
  const dev = useMemo(() => new Map(lookups.devices.map((d) => [d.id, d])), [lookups.devices]);
  const rows = marks.filter((m) => !q || searchMatch(q, [emp.get(m.employee_id)?.name, m.cpf, String(m.nsr)]));
  const people = new Set(rows.map((r) => r.employee_id)).size;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Dia" htmlFor="pt-day"><input id="pt-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className={inputCls} /></Field>
        <Field label="Período" htmlFor="pt-days">
          <select id="pt-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
            <option value={1}>Só o dia</option><option value={7}>7 dias</option><option value={31}>31 dias</option>
          </select>
        </Field>
        <Field label="Empresa" htmlFor="pt-co"><CompanySelect id="pt-co" companies={lookups.companies} value={company} onChange={setCompany} /></Field>
        <Field label="Buscar" htmlFor="pt-q"><input id="pt-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CPF ou NSR" className={inputCls} /></Field>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Atualizar</Button>
      </div>
      <p className="text-sm text-[var(--color-text-secondary)]">{rows.length} batida{rows.length === 1 ? '' : 's'} · {people} pessoa{people === 1 ? '' : 's'}. Horário de Rio Branco. Batida não se edita nem se apaga — correção vira ajuste (próxima etapa).</p>

      <TableWrap minWidth={820}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Data e hora</th><th className={thCls}>Funcionário</th><th className={thCls}>CPF</th>
          <th className={thCls}>NSR</th><th className={thCls}>Aparelho</th><th className={thCls}>Chegada</th>
        </tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={cn(tdCls, 'tabular-nums font-medium')}>{fmtInTz(m.marked_at, m.tz)}</td>
              <td className={tdCls}>{emp.get(m.employee_id)?.name ?? '—'}</td>
              <td className={cn(tdCls, 'tabular-nums')}>{formatDoc(m.cpf)}</td>
              <td className={cn(tdCls, 'tabular-nums')}>{m.nsr}</td>
              <td className={tdCls}>{(m.device_id && dev.get(m.device_id)?.name) || m.collector}</td>
              <td className={tdCls} title={`Gravado no CRM em ${fmtInTz(m.recorded_at, m.tz)} · SHA-256 ${m.hash}`}>
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', m.online ? 'bg-[rgba(34,197,94,0.14)] text-[var(--color-success)]' : 'bg-[rgba(245,158,11,0.14)] text-[var(--inbox-warn-text,#B45309)]')}>
                  {m.online ? 'Na hora' : 'Atrasada (aparelho sem internet)'}
                </span>
              </td>
            </tr>
          ))}
          {!loading && rows.length === 0 && <EmptyRow cols={6} text="Nenhuma batida nesse período." />}
        </tbody>
      </TableWrap>

      {canManage && logs.length > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => setShowLogs((v) => !v)} className="self-start text-sm font-semibold text-[var(--accent-primary)] hover:underline">
            {showLogs ? 'Esconder' : 'Ver'} {logs.length} tentativa{logs.length === 1 ? '' : 's'} sem batida (não reconhecido, negado…)
          </button>
          {showLogs && (
            <TableWrap minWidth={720}>
              <thead><tr className="border-b border-[var(--color-border-card)]">
                <th className={thCls}>Recebido</th><th className={thCls}>Aparelho</th><th className={thCls}>O que houve</th><th className={thCls}>Pessoa no aparelho</th>
              </tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                    <td className={cn(tdCls, 'tabular-nums')}>{fmtInTz(l.marked_at ?? l.received_at, TZ)}</td>
                    <td className={tdCls}>{dev.get(l.device_id)?.name ?? '—'}</td>
                    <td className={tdCls}>{l.note ?? EVENT_LABEL[l.event ?? 0] ?? `Evento ${l.event}`}</td>
                    <td className={tdCls}>{l.device_user_id ? (empByDevUser.get(l.device_user_id)?.name ?? `nº ${l.device_user_id}`) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================ Funcionários
function EmployeesTab({ lookups, canManage }: { lookups: PontoLookups; canManage: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | ''>('active');
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  const co = useMemo(() => new Map(lookups.companies.map((c) => [c.id, c.name])), [lookups.companies]);
  const rows = lookups.employees.filter((e) => (!status || e.status === status) && (!q || searchMatch(q, [e.name, e.cpf, e.registration, e.job_title])));

  const toggle = async (e: Employee) => {
    const next = e.status === 'active' ? 'inactive' : 'active';
    const { error } = await getSupabase().from('ponto_employees')
      .update({ status: next, ...(next === 'active' ? { dismissal_date: null } : {}) }).eq('id', e.id);
    if (error) { toast.error('Não foi possível salvar', { description: friendlyError(error) }); return; }
    toast.success(next === 'active' ? 'Funcionário reativado — cadastro vai de novo para o aparelho.' : 'Funcionário desligado — sai do aparelho.');
    void lookups.reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar" htmlFor="pe-q"><input id="pe-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CPF, matrícula" className={inputCls} /></Field>
        <Field label="Situação" htmlFor="pe-st">
          <select id="pe-st" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={inputCls}>
            <option value="active">Ativos</option><option value="inactive">Desligados</option><option value="">Todos</option>
          </select>
        </Field>
        {canManage && <Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Novo funcionário</Button>}
      </div>

      <TableWrap minWidth={880}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Foto</th><th className={thCls}>Nome</th><th className={thCls}>CPF</th><th className={thCls}>Empresa</th>
          <th className={thCls}>Cargo</th><th className={thCls}>Admissão</th><th className={thCls}>Nº no aparelho</th><th className={thCls}></th>
        </tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="border-b border-[var(--color-border-soft)] last:border-0">
              <td className={tdCls}><FaceThumb path={e.photo_path} synced={!!e.photo_synced_at} /></td>
              <td className={cn(tdCls, 'font-medium')}>{e.name}{e.status === 'inactive' && <span className="ml-2 text-xs text-[var(--color-text-muted)]">desligado {fmtDate(e.dismissal_date)}</span>}</td>
              <td className={cn(tdCls, 'tabular-nums')}>{formatDoc(e.cpf)}</td>
              <td className={tdCls}>{co.get(e.company_id) ?? '—'}</td>
              <td className={tdCls}>{e.job_title ?? '—'}</td>
              <td className={tdCls}>{fmtDate(e.admission_date)}</td>
              <td className={cn(tdCls, 'tabular-nums')}>{e.device_user_id}</td>
              <td className={cn(tdCls, 'whitespace-nowrap text-right')}>
                {canManage && <>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(e)}>Editar</Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(e)}>
                    {e.status === 'active' ? <><UserMinus className="h-4 w-4" /> Desligar</> : <><UserPlus className="h-4 w-4" /> Reativar</>}
                  </Button>
                </>}
              </td>
            </tr>
          ))}
          {!lookups.loading && rows.length === 0 && <EmptyRow cols={8} text="Nenhum funcionário." />}
        </tbody>
      </TableWrap>
      {edit && <EmployeeDialog lookups={lookups} employee={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function FaceThumb({ path, synced }: { path: string | null; synced: boolean }) {
  const url = usePontoPhoto(path);
  return (
    <div className="relative h-9 w-9" title={!path ? 'Sem foto: não bate ponto pelo rosto' : synced ? 'Foto no aparelho' : 'Foto ainda indo para o aparelho'}>
      {url ? <img src={url} alt="" className="h-9 w-9 rounded-full object-cover" />
        : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"><ScanFace className="h-4 w-4" /></span>}
      {path && <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-surface)]', synced ? 'bg-[var(--color-success)]' : 'bg-[#F59E0B]')} />}
    </div>
  );
}

function EmployeeDialog({ lookups, employee, onClose }: { lookups: PontoLookups; employee: Employee | null; onClose: () => void }) {
  const { orgId } = useAppUser();
  const activeCompanies = lookups.companies.filter((c) => c.is_active);
  const [f, setF] = useState({
    company_id: employee?.company_id ?? (activeCompanies.find((c) => c.is_default) ?? activeCompanies[0])?.id ?? '',
    name: employee?.name ?? '',
    cpf: employee ? maskDoc(employee.cpf) : '',
    registration: employee?.registration ?? '',
    job_title: employee?.job_title ?? '',
    admission_date: employee?.admission_date ?? '',
    notes: employee?.notes ?? '',
  });
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const current = usePontoPhoto(employee?.photo_path);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      const blob = await prepareFacePhoto(file);
      setPhoto(blob);
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Foto inválida.');
    }
  };

  const save = async () => {
    const cpf = onlyDigits(f.cpf);
    if (f.name.trim().length < 2) return toast.error('Informe o nome.');
    if (!validCpf(cpf)) return toast.error('CPF inválido.');
    if (!f.company_id) return toast.error('Escolha a empresa (estabelecimento).');
    setBusy(true);
    try {
      const sb = getSupabase();
      const row = {
        company_id: f.company_id, name: f.name.trim().slice(0, 52), cpf,
        registration: f.registration.trim() || null, job_title: f.job_title.trim() || null,
        admission_date: f.admission_date || null, notes: f.notes.trim() || null,
      };
      let id = employee?.id ?? null;
      if (id) {
        const { error } = await sb.from('ponto_employees').update(row).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await sb.from('ponto_employees').insert(row).select('id').single();
        if (error) throw error;
        id = (data as { id: string }).id;
      }
      if (photo && id && orgId) {
        const path = `${orgId}/funcionarios/${id}-${Date.now()}.jpg`;
        const up = await sb.storage.from(PONTO_BUCKET).upload(path, photo, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        const { error } = await sb.from('ponto_employees').update({ photo_path: path }).eq('id', id);
        if (error) throw error;
      }
      toast.success('Salvo. O cadastro vai para o aparelho na próxima consulta dele.');
      void lookups.reload();
      onClose();
    } catch (err) {
      const msg = friendlyError(err);
      toast.error('Não foi possível salvar', { description: /ponto_employees_org_id_cpf_key|duplicate key/i.test(String((err as { message?: string })?.message)) ? 'Já existe funcionário com este CPF.' : msg });
    } finally {
      setBusy(false);
    }
  };

  const shown = preview ?? current;
  return (
    <Dialog open onClose={onClose} title={employee ? 'Editar funcionário' : 'Novo funcionário'} widthClass="max-w-xl">
      <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
        <div className="flex flex-col items-center gap-2">
          {shown ? <img src={shown} alt="" className="h-28 w-28 rounded-xl object-cover" />
            : <span className="flex h-28 w-28 items-center justify-center rounded-xl bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"><ScanFace className="h-8 w-8" /></span>}
          <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-[var(--accent-primary)] hover:underline">
            <Camera className="h-3.5 w-3.5" /> {shown ? 'Trocar foto' : 'Foto do rosto'}
            <input type="file" accept="image/jpeg,image/png" capture="user" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          <p className="text-center text-[11px] text-[var(--color-text-muted)]">De frente, rosto inteiro, boa luz, sem óculos escuros.</p>
        </div>
        <div className="space-y-3">
          <Field label="Nome" htmlFor="pe-name" required><input id="pe-name" value={f.name} onChange={set('name')} maxLength={52} className={inputCls} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="CPF" htmlFor="pe-cpf" required><input id="pe-cpf" inputMode="numeric" value={f.cpf} onChange={(e) => setF((s) => ({ ...s, cpf: maskDoc(onlyDigits(e.target.value).slice(0, 11)) }))} className={inputCls} /></Field>
            <Field label="Matrícula" htmlFor="pe-reg"><input id="pe-reg" value={f.registration} onChange={set('registration')} maxLength={20} className={inputCls} /></Field>
          </div>
          <Field label="Empresa (estabelecimento)" htmlFor="pe-co" required hint="O NSR e os arquivos legais são por empresa (CNPJ).">
            <CompanySelect id="pe-co" companies={lookups.companies} value={f.company_id} onChange={(v) => setF((s) => ({ ...s, company_id: v }))} allLabel={null} onlyActive />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cargo" htmlFor="pe-job"><input id="pe-job" value={f.job_title} onChange={set('job_title')} maxLength={80} className={inputCls} /></Field>
            <Field label="Admissão" htmlFor="pe-adm"><input id="pe-adm" type="date" value={f.admission_date} onChange={set('admission_date')} className={inputCls} /></Field>
          </div>
          <Field label="Observações" htmlFor="pe-notes"><textarea id="pe-notes" value={f.notes} onChange={set('notes')} maxLength={500} rows={2} className={inputCls} /></Field>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>
      </div>
    </Dialog>
  );
}

// ============================================================================ Aparelhos
function DevicesTab({ lookups }: { lookups: PontoLookups }) {
  const [adding, setAdding] = useState(false);
  const [cmds, setCmds] = useState<DeviceCmd[]>([]);
  const loadCmds = useCallback(async () => {
    const { data } = await getSupabase().from('ponto_device_cmds')
      .select('id, device_id, kind, employee_id, status, error, created_at, done_at')
      .neq('kind', 'load_logs').order('id', { ascending: false }).limit(200);
    setCmds((data ?? []) as DeviceCmd[]);
  }, []);
  useEffect(() => { void loadCmds(); const t = setInterval(() => void loadCmds(), 15_000); return () => clearInterval(t); }, [loadCmds]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-[var(--color-text-secondary)]">
          O iDFace consulta o CRM pela internet (modo Push) a cada 30 segundos: busca as batidas e recebe cadastros, fotos e acerto de hora.
          Não precisa abrir porta no roteador do parque.
        </p>
        <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Novo aparelho</Button>
      </div>
      {lookups.devices.length === 0 && !lookups.loading && (
        <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhum aparelho cadastrado.</div>
      )}
      {lookups.devices.map((d) => <DeviceCard key={d.id} device={d} lookups={lookups} cmds={cmds.filter((c) => c.device_id === d.id)} onChanged={loadCmds} />)}
      {adding && <DeviceDialog lookups={lookups} onClose={() => setAdding(false)} />}
    </div>
  );
}

function DeviceCard({ device: d, lookups, cmds, onChanged }: { device: Device; lookups: PontoLookups; cmds: DeviceCmd[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showCfg, setShowCfg] = useState(!d.last_seen_at);
  const url = pushUrl(d.push_token);
  const online = d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < 3 * 60_000;
  const company = lookups.companies.find((c) => c.id === d.company_id)?.name ?? '—';
  const pending = cmds.filter((c) => c.status === 'pending' || c.status === 'sent').length;
  const errors = cmds.filter((c) => c.status === 'error').slice(0, 5);
  const emp = new Map(lookups.employees.map((e) => [e.id, e.name]));

  const rpc = async (fn: 'ponto_device_resync' | 'ponto_device_set_time', ok: string) => {
    setBusy(fn);
    const { data, error } = await getSupabase().rpc(fn, { p_device: d.id });
    setBusy(null);
    if (error) return toast.error('Não foi possível', { description: friendlyError(error) });
    toast.success(fn === 'ponto_device_resync' ? `${ok} (${data ?? 0} funcionários).` : ok);
    onChanged();
  };
  const toggle = async () => {
    const { error } = await getSupabase().from('ponto_devices').update({ is_active: !d.is_active }).eq('id', d.id);
    if (error) return toast.error('Não foi possível salvar', { description: friendlyError(error) });
    void lookups.reload();
  };
  const copy = (t: string) => { void navigator.clipboard.writeText(t).then(() => toast.success('Copiado.')); };

  const ps = [
    '# Rode no PowerShell de um computador na MESMA rede do aparelho. Troque o IP e a senha do aparelho.',
    '$ip = "192.168.0.50"',
    '$senha = Read-Host "Senha do admin do aparelho"',
    '$s = (Invoke-RestMethod -Method Post -Uri "http://$ip/login.fcgi" -ContentType "application/json" -Body (@{ login = "admin"; password = $senha } | ConvertTo-Json)).session',
    `$cfg = '{"push_server":{"push_remote_address":"${url}","push_request_timeout":"30000","push_request_period":"30"}}'`,
    'Invoke-RestMethod -Method Post -Uri "http://$ip/set_configuration.fcgi?session=$s" -ContentType "application/json" -Body $cfg',
  ].join('\n');

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', !d.is_active ? 'bg-[var(--color-text-muted)]' : online ? 'bg-[var(--color-success)]' : 'bg-[var(--color-error)]')} />
            <h3 className="font-semibold text-[var(--color-text-primary)]">{d.name}</h3>
            <span className="text-xs text-[var(--color-text-muted)]">iDFace{d.device_serial ? ` · nº ${d.device_serial}` : ''}</span>
          </div>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {company} · {!d.is_active ? 'Desativado' : d.last_seen_at ? `Última consulta ${fmtDateTime(d.last_seen_at)}${online ? '' : ' — sem contato'}` : 'Ainda não se conectou'}
            {pending > 0 && ` · ${pending} envio${pending === 1 ? '' : 's'} na fila`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy || !d.is_active} onClick={() => void rpc('ponto_device_resync', 'Funcionários na fila para o aparelho')}>
            {busy === 'ponto_device_resync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reenviar funcionários
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy || !d.is_active} onClick={() => void rpc('ponto_device_set_time', 'Hora vai ser acertada na próxima consulta.')}>
            {busy === 'ponto_device_set_time' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />} Acertar hora
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowCfg((v) => !v)}>{showCfg ? 'Esconder' : 'Como configurar'}</Button>
          <Button size="sm" variant="ghost" onClick={() => void toggle()}>{d.is_active ? 'Desativar' : 'Ativar'}</Button>
        </div>
      </div>

      {showCfg && (
        <div className="mt-3 space-y-2 rounded-[var(--radius-control)] bg-[var(--color-bg-primary)] p-3 text-sm">
          <p className="text-[var(--color-text-secondary)]">Endereço Push deste aparelho (é secreto — quem tiver o endereço consegue falar com o CRM como se fosse o aparelho):</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-[var(--color-surface)] px-2 py-1 text-xs">{url}</code>
            <Button size="sm" variant="outline" onClick={() => copy(url)}><Copy className="h-4 w-4" /></Button>
          </div>
          <p className="text-[var(--color-text-secondary)]">Para gravar no aparelho, rode no PowerShell (computador na rede do parque):</p>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-[var(--color-surface)] p-2 text-[11px] leading-relaxed">{ps}</pre>
            <Button size="sm" variant="outline" onClick={() => copy(ps)}><Copy className="h-4 w-4" /></Button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">Depois de 1 minuto a bolinha fica verde. Clique em “Reenviar funcionários” para mandar cadastros e fotos, e em “Acertar hora”.</p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="font-semibold text-[var(--color-error)]">Últimos envios com erro</p>
          {errors.map((c) => (
            <p key={c.id} className="text-[var(--color-text-secondary)]">
              {fmtDateTime(c.done_at ?? c.created_at)} · {CMD_LABEL[c.kind] ?? c.kind}{c.employee_id ? ` · ${emp.get(c.employee_id) ?? ''}` : ''} — {c.error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceDialog({ lookups, onClose }: { lookups: PontoLookups; onClose: () => void }) {
  const active = lookups.companies.filter((c) => c.is_active);
  const [name, setName] = useState('');
  const [company, setCompany] = useState((active.find((c) => c.is_default) ?? active[0])?.id ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (name.trim().length < 2) return toast.error('Dê um nome ao aparelho (ex.: Portaria).');
    if (!company) return toast.error('Escolha a empresa.');
    setBusy(true);
    const { error } = await getSupabase().from('ponto_devices').insert({ name: name.trim(), company_id: company });
    setBusy(false);
    if (error) return toast.error('Não foi possível salvar', { description: friendlyError(error) });
    toast.success('Aparelho cadastrado. Agora configure o endereço Push nele.');
    void lookups.reload();
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Novo aparelho">
      <div className="space-y-3">
        <Field label="Nome" htmlFor="pd-name" required><input id="pd-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Portaria" className={inputCls} /></Field>
        <Field label="Empresa (estabelecimento)" htmlFor="pd-co" required hint="Funcionários desta empresa são enviados para este aparelho.">
          <CompanySelect id="pd-co" companies={lookups.companies} value={company} onChange={setCompany} allLabel={null} onlyActive />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>
      </div>
    </Dialog>
  );
}
