import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Check, Copy, ExternalLink, FileText, IdCard, Link2, Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatPhoneDisplay } from '@/lib/phone';
import { usePermission } from '../../providers/PermissionsProvider';

// Recadastramento de associados (20261111200000_recadastramento.sql). O associado preenche o link público
// /recadastro/<token>; aqui a equipe confere os dados e documentos, copia para o Pocket e marca o status.
// Os campos ficam com data-pocket="…" para facilitar a cópia automática (extensão do navegador).

const BUCKET = 'whatsapp-hub-recadastro';

type Status = 'enviando' | 'novo' | 'em_analise' | 'pendente' | 'lancado' | 'recusado';
interface Submission {
  id: string; protocol: number; status: Status; plan: 'amai10' | 'infinity' | 'nao_sei'; people_count: number | null;
  passport_number: string | null; holder_name: string; holder_cpf: string; holder_birth: string | null; holder_email: string | null;
  holder_phone: string | null; portal_access: 'email' | 'whatsapp'; contact_id: string | null; team_notes: string | null;
  reviewed_at: string | null; completed_at: string | null; created_at: string;
}
interface PersonRow { id: string; position: number; name: string; birth_date: string; relationship: string; relationship_other: string | null; cpf: string | null; email: string | null }
interface FileRow { id: string; person_id: string | null; kind: 'passaporte' | 'documento' | 'certidao_casamento'; path: string; mime: string }

const STATUS: Record<Status, { label: string; cls: string }> = {
  enviando: { label: 'Incompleto', cls: 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]' },
  novo: { label: 'Novo', cls: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' },
  em_analise: { label: 'Em análise', cls: 'bg-[rgba(245,158,11,0.14)] text-[#b45309] dark:text-[#fbbf24]' },
  pendente: { label: 'Pendência', cls: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]' },
  lancado: { label: 'Lançado no Pocket', cls: 'bg-[rgba(34,197,94,0.14)] text-[var(--color-success)]' },
  recusado: { label: 'Recusado', cls: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]' },
};
const FILTERS: [string, Status[] | null][] = [
  ['A fazer', ['novo', 'em_analise', 'pendente']],
  ['Lançados', ['lancado']],
  ['Recusados', ['recusado']],
  ['Incompletos', ['enviando']],
  ['Todos', null],
];
const PLAN: Record<string, string> = { amai10: 'AMAI 10', infinity: 'AMAI Infinity', nao_sei: 'Não sabe' };
const REL: Record<string, string> = { pai: 'Pai', mae: 'Mãe', sogro: 'Sogro', sogra: 'Sogra', conjuge: 'Cônjuge', filho: 'Filho(a)', outro: 'Outro' };

const fmtCpf = (c: string | null) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c ?? '');
const fmtDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const fmtDateTime = (d: string | null) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const relLabel = (p: PersonRow) => (p.relationship === 'outro' ? `Outro: ${p.relationship_other ?? ''}` : REL[p.relationship] ?? p.relationship);

async function copy(text: string, what = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast.success(what); } catch { toast.error('Não foi possível copiar.'); }
}

function CopyField({ label, value, field }: { label: string; value: string; field: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-28 shrink-0 text-xs text-[var(--color-text-muted)]">{label}</span>
      <span data-pocket={field} className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">{value || '—'}</span>
      {value && (
        <button type="button" aria-label={`Copiar ${label}`} onClick={() => void copy(value, `${label} copiado`)} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--accent-primary)]">
          <Copy className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function LinkCard({ canManage }: { canManage: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await getSupabase().from('recad_links').select('id, token').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    setToken((data as { token: string } | null)?.token ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const url = token ? `${window.location.origin}/recadastro/${token}` : '';

  async function regenerate() {
    if (!window.confirm('Gerar um link novo? O link atual para de funcionar na hora (inclusive o que a AMAIA manda).')) return;
    setBusy(true);
    const sb = getSupabase();
    const { error: e1 } = await sb.from('recad_links').update({ is_active: false }).eq('is_active', true);
    const { error: e2 } = e1 ? { error: e1 } : await sb.from('recad_links').insert({});
    setBusy(false);
    if (e2) { toast.error('Não foi possível gerar o link', { description: e2.message }); return; }
    toast.success('Link novo gerado. Atualize o link da AMAIA (variável link_recadastro).');
    void load();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-3">
      <Link2 className="h-4 w-4 text-[var(--accent-primary)]" />
      <span className="text-sm font-medium text-[var(--color-text-primary)]">Link do formulário:</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-secondary)]">{url || 'nenhum link ativo'}</span>
      {url && <Button size="sm" variant="outline" onClick={() => void copy(url, 'Link copiado')}><Copy className="h-3.5 w-3.5" /> Copiar</Button>}
      {url && <a href={url} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink className="h-3.5 w-3.5" /> Abrir</Button></a>}
      {canManage && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void regenerate()}><RefreshCw className="h-3.5 w-3.5" /> Gerar novo</Button>}
    </div>
  );
}

function Detail({ sub, canManage, onClose, onChanged }: { sub: Submission; canManage: boolean; onClose: () => void; onChanged: (s: Submission) => void }) {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [files, setFiles] = useState<(FileRow & { url: string | null })[]>([]);
  const [notes, setNotes] = useState(sub.team_notes ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNotes(sub.team_notes ?? '');
    let cancelled = false;
    (async () => {
      const sb = getSupabase();
      const [{ data: p }, { data: f }] = await Promise.all([
        sb.from('recad_people').select('id, position, name, birth_date, relationship, relationship_other, cpf, email').eq('submission_id', sub.id).order('position'),
        sb.from('recad_files').select('id, person_id, kind, path, mime').eq('submission_id', sub.id).order('created_at'),
      ]);
      const fl = (f ?? []) as FileRow[];
      let urls: Record<string, string | null> = {};
      if (fl.length) {
        const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(fl.map((x) => x.path), 3600);
        urls = Object.fromEntries((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path ?? '', s.signedUrl]));
      }
      if (cancelled) return;
      setPeople((p ?? []) as PersonRow[]);
      setFiles(fl.map((x) => ({ ...x, url: urls[x.path] ?? null })));
    })();
    return () => { cancelled = true; };
  }, [sub.id, sub.team_notes]);

  async function save(patch: Partial<Pick<Submission, 'status' | 'team_notes'>>) {
    setSaving(true);
    const { data, error } = await getSupabase().from('recad_submissions').update(patch).eq('id', sub.id)
      .select('id, protocol, status, plan, people_count, passport_number, holder_name, holder_cpf, holder_birth, holder_email, holder_phone, portal_access, contact_id, team_notes, reviewed_at, completed_at, created_at').single();
    setSaving(false);
    if (error) { toast.error('Não foi possível salvar', { description: error.message }); return; }
    onChanged(data as Submission);
    toast.success('Salvo');
  }

  const allText = useMemo(() => {
    const lines = [
      `Protocolo #${sub.protocol} — ${PLAN[sub.plan]}${sub.people_count ? ` (${sub.people_count} pessoas)` : ''}`,
      `Titular: ${sub.holder_name}`, `CPF: ${fmtCpf(sub.holder_cpf)}`,
      sub.holder_birth ? `Nascimento: ${fmtDate(sub.holder_birth)}` : '',
      `E-mail: ${sub.holder_email ?? ''}`, `WhatsApp: ${sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : ''}`,
      `Acesso ao portal por: ${sub.portal_access === 'email' ? 'e-mail' : 'WhatsApp'}`,
      sub.passport_number ? `Nº passaporte/contrato: ${sub.passport_number}` : '',
      '', 'Dependentes:',
      ...people.map((p) => `${p.position}. ${p.name} | ${fmtDate(p.birth_date)} | ${relLabel(p)} | CPF ${fmtCpf(p.cpf) || '-'} | ${p.email ?? '-'}`),
    ];
    return lines.filter((l, i) => l !== '' || i > 0).join('\n');
  }, [sub, people]);

  const filesOf = (personId: string | null, kind?: FileRow['kind']) => files.filter((f) => f.person_id === personId && (!kind || f.kind === kind));
  const Thumbs = ({ list }: { list: typeof files }) => (
    <div className="flex flex-wrap gap-2">
      {list.length === 0 && <span className="text-xs text-[var(--color-error)]">sem arquivo</span>}
      {list.map((f) => (
        <a key={f.id} href={f.url ?? '#'} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-hover)]">
          {f.mime.startsWith('image/') && f.url
            ? <img src={f.url} alt="Documento" className="h-full w-full object-cover" />
            : <span className="flex h-full w-full flex-col items-center justify-center text-xs text-[var(--color-text-secondary)]"><FileText className="h-6 w-6" />PDF</span>}
        </a>
      ))}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
      <div className="space-y-2 border-b border-[var(--color-border-card)] p-3">
        <div className="flex items-start gap-2">
          <button type="button" aria-label="Voltar para a lista" onClick={onClose} className="-ml-1 rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] lg:hidden"><ArrowLeft className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-[var(--color-text-muted)]">Protocolo #{sub.protocol} · enviado {fmtDateTime(sub.completed_at ?? sub.created_at)}</div>
            <div className="text-base font-semibold text-[var(--color-text-primary)]">{sub.holder_name}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <select value={sub.status} disabled={saving} onChange={(e) => void save({ status: e.target.value as Status })}
              className="h-9 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] sm:flex-none">
              {(Object.keys(STATUS) as Status[]).filter((s) => s !== 'enviando' || sub.status === 'enviando').map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          ) : <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', STATUS[sub.status].cls)}>{STATUS[sub.status].label}</span>}
          <Button size="sm" variant="outline" onClick={() => void copy(allText, 'Dados copiados')}><Copy className="h-3.5 w-3.5" /> Copiar tudo</Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-pocket-protocol={sub.protocol}>
        {sub.status === 'enviando' && (
          <p className="rounded-[var(--radius-control)] bg-[rgba(245,158,11,0.1)] p-2 text-sm text-[var(--color-text-primary)]">O associado começou mas não terminou de enviar os documentos.</p>
        )}
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Passaporte</h3>
          <CopyField label="Passaporte" value={`${PLAN[sub.plan]}${sub.people_count ? ` — ${sub.people_count} pessoa(s)` : ''}`} field="plano" />
          <CopyField label="Nº passaporte" value={sub.passport_number ?? ''} field="numero_passaporte" />
          <div className="mt-1"><Thumbs list={filesOf(null, 'passaporte')} /></div>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Titular</h3>
          <CopyField label="Nome" value={sub.holder_name} field="titular_nome" />
          <CopyField label="CPF" value={fmtCpf(sub.holder_cpf)} field="titular_cpf" />
          <CopyField label="Nascimento" value={fmtDate(sub.holder_birth)} field="titular_nascimento" />
          <CopyField label="E-mail" value={sub.holder_email ?? ''} field="titular_email" />
          <CopyField label="WhatsApp" value={sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : ''} field="titular_whatsapp" />
          <CopyField label="Acesso portal" value={sub.portal_access === 'email' ? 'E-mail' : 'WhatsApp'} field="acesso_portal" />
          {sub.contact_id && <Link to={`/contacts/${sub.contact_id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent-primary)] hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Abrir contato / conversa</Link>}
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">RG / CNH</div>
          <Thumbs list={filesOf(null, 'documento')} />
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Dependentes ({people.length})</h3>
          {people.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum.</p>}
          <div className="space-y-3">
            {people.map((p) => (
              <div key={p.id} data-pocket-dependente={p.position} className="rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-2.5">
                <CopyField label="Nome" value={p.name} field="dep_nome" />
                <CopyField label="Nascimento" value={fmtDate(p.birth_date)} field="dep_nascimento" />
                <CopyField label="Parentesco" value={relLabel(p)} field="dep_parentesco" />
                <CopyField label="CPF" value={fmtCpf(p.cpf)} field="dep_cpf" />
                <CopyField label="E-mail" value={p.email ?? ''} field="dep_email" />
                <div className="mt-1"><Thumbs list={filesOf(p.id)} /></div>
              </div>
            ))}
          </div>
        </section>

        {(files.some((f) => f.kind === 'certidao_casamento') || people.some((p) => ['conjuge', 'sogro', 'sogra'].includes(p.relationship))) && (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Certidão de casamento / união</h3>
            <Thumbs list={filesOf(null, 'certidao_casamento')} />
          </section>
        )}

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Observação da equipe</h3>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} disabled={!canManage}
            className="w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)]" placeholder="Ex.: falta o verso do RG da filha" />
          {canManage && notes !== (sub.team_notes ?? '') && (
            <Button size="sm" className="mt-2" disabled={saving} onClick={() => void save({ team_notes: notes.trim() || null })}><Check className="h-3.5 w-3.5" /> Salvar observação</Button>
          )}
        </section>
      </div>
    </div>
  );
}

export default function RecadastramentosPage() {
  const perms = usePermission();
  const canManage = perms.can('recad.manage');
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(0);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await getSupabase().from('recad_submissions')
      .select('id, protocol, status, plan, people_count, passport_number, holder_name, holder_cpf, holder_birth, holder_email, holder_phone, portal_access, contact_id, team_notes, reviewed_at, completed_at, created_at')
      .order('created_at', { ascending: false }).limit(1000);
    if (e) { setError(/recad_submissions/.test(e.message) ? 'O módulo de recadastramento ainda não foi instalado no banco.' : e.message); setRows([]); return; }
    setError(null);
    setRows((data ?? []) as Submission[]);
  }, []);

  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const ch = getSupabase().channel('recad-submissions')
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'recad_submissions' }, () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => void load(), 1500);
      })
      .subscribe();
    return () => { if (t) clearTimeout(t); void getSupabase().removeChannel(ch); };
  }, [load]);

  const statuses = FILTERS[filter][1];
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const qd = qq.replace(/\D/g, '');
    return (rows ?? []).filter((r) => (!statuses || statuses.includes(r.status)) && (!qq
      || r.holder_name.toLowerCase().includes(qq) || String(r.protocol).includes(qq)
      || (qd.length >= 3 && (r.holder_cpf.includes(qd) || (r.holder_phone ?? '').includes(qd)))));
  }, [rows, statuses, q]);
  const counts = useMemo(() => FILTERS.map(([, st]) => (rows ?? []).filter((r) => !st || st.includes(r.status)).length), [rows]);
  const current = (rows ?? []).find((r) => r.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className={cn('flex flex-wrap items-center gap-3', current && 'hidden lg:flex')}>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><IdCard className="h-5 w-5" /></span>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Recadastramento</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Dados e documentos que os associados enviaram pelo link. Confira, lance no Pocket e marque como lançado.</p>
        </div>
      </div>
      <div className={cn(current && 'hidden lg:block')}><LinkCard canManage={canManage} /></div>
      {error && <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{error}</div>}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className={cn('flex min-h-0 w-full flex-col gap-2 lg:w-[380px] lg:shrink-0', current && 'hidden lg:flex')}>
          <div className="flex max-w-full flex-wrap gap-1.5">
            {FILTERS.map(([label], i) => (
              <button key={label} type="button" onClick={() => setFilter(i)}
                className={cn('rounded-full border px-3 py-1 text-xs font-semibold', filter === i ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]')}>
                {label} <span className="opacity-70">{counts[i]}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CPF, WhatsApp ou protocolo"
              className="h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] pl-8 pr-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
            {rows === null && <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>}
            {rows !== null && list.length === 0 && <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nada por aqui.</p>}
            {list.map((r) => (
              <button key={r.id} type="button" onClick={() => setSelected(r.id)}
                className={cn('flex w-full items-start gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 text-left hover:bg-[var(--color-surface-hover)]', selected === r.id && 'bg-[var(--color-accent-subtle)]')}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{r.holder_name}</div>
                  <div className="truncate text-xs text-[var(--color-text-muted)]">#{r.protocol} · {PLAN[r.plan]}{r.people_count ? ` · ${r.people_count} pess.` : ''} · {fmtDateTime(r.completed_at ?? r.created_at)}</div>
                </div>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS[r.status].cls)}>{STATUS[r.status].label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={cn('min-h-0 flex-1', !current && 'hidden lg:block')}>
          {current
            ? <Detail sub={current} canManage={canManage} onClose={() => setSelected(null)} onChanged={(s) => setRows((rs) => (rs ?? []).map((x) => (x.id === s.id ? s : x)))} />
            : <div className="flex h-full items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-6 text-sm text-[var(--color-text-muted)]">Escolha um recadastramento na lista.</div>}
        </div>
      </div>
    </div>
  );
}
