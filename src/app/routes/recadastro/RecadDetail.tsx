import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { zip } from 'fflate';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, ExternalLink, FileText, History,
  Download, Layers, LayoutGrid, Loader2, Lock, MessageCircle, Paperclip, Pencil, Plus, UserRound, Zap, RotateCcw, Trash2, Users, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatPhoneDisplay } from '@/lib/phone';
import {
  BUCKET, CopyField, PLAN, REL, uploadTeamFile, STATUS, SUB_COLS, StatusChip, buildWhatsMessage, copy, eventText, fmtCpf, fmtDate, fmtDateTime,
  relLabel, waNumber, type EventRow, type FileRow, type Issue, type Note, type PersonRow, type Status, type Submission,
} from './recadShared';

const QUICK = [
  ['RG / CNH', 'Enviar foto legível do RG ou CNH (frente e verso).'],
  ['Contrato', 'Enviar foto do título, passaporte ou contrato do AMAI Park.'],
  ['Dados divergentes', 'Confirmar dados que estão diferentes do cadastro.'],
  ['Certidão', 'Enviar certidão de casamento ou de união estável.'],
  ['Foto ilegível', 'Reenviar a foto do documento: a enviada está ilegível.'],
] as const;

const WA_GREEN = 'bg-[#16a34a] text-white hover:bg-[#15803d] disabled:opacity-60';
const box = 'rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]';
const sectionTitle = 'text-sm font-semibold text-[var(--color-text-primary)]';

interface Props {
  sub: Submission;
  canManage: boolean;
  centralReady: boolean;
  tick: number;                     // muda quando chega alteração em tempo real (pendências/observações)
  nameOf: (uid: string | null) => string;
  onClose: () => void;
  onChanged: (s: Submission) => void;
  onIssuesChanged: () => void;
}

// Cadastro selecionado: centro (titular, passaporte, documentos, dependentes) + direita (pendências, WhatsApp, observações).
// O componente é montado com key = id do envio: trocar de cadastro zera todo o estado (nada se mistura entre protocolos).
export default function RecadDetail({ sub, canManage, centralReady, tick, nameOf, onClose, onChanged, onIssuesChanged }: Props) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [saving, setSaving] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [whatsOpen, setWhatsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filesVer, setFilesVer] = useState(0);
  const [tab, setTab] = useState<'resumo' | 'titular' | 'dependentes' | 'documentos'>('resumo');
  const [recent, setRecent] = useState<EventRow[]>([]);
  const [editSub, setEditSub] = useState(false);
  const [editPerson, setEditPerson] = useState<PersonRow | 'new' | null>(null);

  // pessoas + arquivos (links assinados de 1 h)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = getSupabase();
      const [{ data: p }, { data: f }] = await Promise.all([
        sb.from('recad_people').select('id, position, name, birth_date, relationship, relationship_other, cpf, email').eq('submission_id', sub.id).order('position'),
        sb.from('recad_files').select('id, person_id, kind, path, mime').eq('submission_id', sub.id).order('created_at'),
      ]);
      const fl = (f ?? []) as Omit<FileRow, 'url'>[];
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
  }, [sub.id, filesVer]);

  // pendências + observações (recarrega com o tempo real)
  const loadSide = useCallback(async () => {
    if (!centralReady) return;
    const sb = getSupabase();
    const [{ data: i }, { data: n }, { data: ev }] = await Promise.all([
      sb.from('recad_issues').select('id, submission_id, text, status, created_by, created_at, resolved_by, resolved_at, deleted_at')
        .eq('submission_id', sub.id).is('deleted_at', null).order('created_at'),
      sb.from('recad_notes').select('id, submission_id, text, created_by, created_at').eq('submission_id', sub.id).order('created_at', { ascending: false }),
      sb.from('recad_events').select('id, kind, actor, at, meta').eq('submission_id', sub.id).order('at', { ascending: false }).limit(4),
    ]);
    // guarda contra resposta atrasada de outro cadastro
    setIssues(((i ?? []) as Issue[]).filter((x) => x.submission_id === sub.id));
    setNotes(((n ?? []) as Note[]).filter((x) => x.submission_id === sub.id));
    setRecent((ev ?? []) as EventRow[]);
  }, [sub.id, centralReady]);
  useEffect(() => { void loadSide(); }, [loadSide, tick]);

  const openIssues = useMemo(() => issues.filter((i) => i.status === 'aberta'), [issues]);
  const sortedIssues = useMemo(() => [...openIssues, ...issues.filter((i) => i.status === 'resolvida')], [issues, openIssues]);

  async function saveSub(patch: Partial<Pick<Submission, 'status' | 'holder_phone'>>, okMsg = 'Salvo'): Promise<boolean> {
    if ((patch.status === 'conferido' || patch.status === 'lancado') && openIssues.length) {
      toast.error(`Há ${openIssues.length} pendência${openIssues.length > 1 ? 's' : ''} em aberto`, {
        description: 'Resolva ou exclua as pendências antes de marcar como conferido ou lançado.',
      });
      return false;
    }
    setSaving(true);
    const { data, error } = await getSupabase().from('recad_submissions').update(patch).eq('id', sub.id).select(SUB_COLS).single();
    setSaving(false);
    if (error) { toast.error('Não foi possível salvar', { description: error.message }); return false; }
    onChanged(data as Submission);
    toast.success(okMsg);
    return true;
  }

  async function addIssue(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) return false;
    if (openIssues.some((i) => i.text.toLowerCase() === t.toLowerCase())) { toast.info('Essa pendência já está em aberto.'); return false; }
    const { error } = await getSupabase().from('recad_issues').insert({ submission_id: sub.id, text: t.slice(0, 400) });
    if (error) { toast.error('Não foi possível criar a pendência', { description: error.message }); return false; }
    await afterIssueChange();
    return true;
  }
  async function setIssue(id: string, patch: Partial<Pick<Issue, 'status' | 'deleted_at'>>) {
    const { error } = await getSupabase().from('recad_issues').update(patch).eq('id', id);
    if (error) { toast.error('Não foi possível alterar a pendência', { description: error.message }); return; }
    await afterIssueChange();
  }
  async function afterIssueChange() {
    await loadSide();
    onIssuesChanged();
    // abrir pendência pode mudar o status para "Aguardando associado" (feito pelo banco)
    const { data } = await getSupabase().from('recad_submissions').select(SUB_COLS).eq('id', sub.id).single();
    if (data) onChanged(data as Submission);
  }

  const allText = useMemo(() => {
    const lines = [
      `Protocolo #${sub.protocol} — ${PLAN[sub.plan]}${sub.people_count ? ` (${sub.people_count} pessoas)` : ''}`,
      `Titular: ${sub.holder_name}`, `CPF: ${fmtCpf(sub.holder_cpf)}`,
      sub.holder_birth ? `Nascimento: ${fmtDate(sub.holder_birth)}` : '',
      `E-mail: ${sub.holder_email ?? ''}`, `WhatsApp: ${sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : ''}`,
      'Acesso ao portal: enviar login pelo WhatsApp e pelo e-mail',
      sub.passport_number ? `Nº passaporte/contrato: ${sub.passport_number}` : '',
      '', 'Dependentes:',
      ...(people ?? []).map((p) => `${p.position}. ${p.name} | ${fmtDate(p.birth_date)} | ${relLabel(p)} | CPF ${fmtCpf(p.cpf) || '-'} | ${p.email ?? '-'}`),
    ];
    return lines.filter((l, i) => l !== '' || i > 0).join('\n');
  }, [sub, people]);

  const needsCert = files.some((f) => f.kind === 'certidao_casamento') || (people ?? []).some((p) => ['conjuge', 'sogro', 'sogra'].includes(p.relationship));
  const checkpoints = useMemo(() => {
    const list: { key: string; label: string; files: FileRow[]; kind: FileRow['kind']; personId: string | null }[] = [
      { key: 'pass', kind: 'passaporte', personId: null, label: 'Passaporte/contrato ou comprovante', files: files.filter((f) => !f.person_id && f.kind === 'passaporte') },
      { key: 'doc', kind: 'documento', personId: null, label: 'RG / CNH do titular', files: files.filter((f) => !f.person_id && f.kind === 'documento') },
    ];
    if (needsCert) list.push({ key: 'cert', kind: 'certidao_casamento', personId: null, label: 'Certidão de casamento / união', files: files.filter((f) => f.kind === 'certidao_casamento') });
    for (const p of people ?? []) list.push({ key: p.id, kind: 'documento', personId: p.id, label: `Documento — ${p.name.split(' ')[0]} (${relLabel(p)})`, files: files.filter((f) => f.person_id === p.id) });
    return list;
  }, [files, people, needsCert]);
  const openFile = (f: FileRow) => setViewer(files.findIndex((x) => x.id === f.id));

  const blocked = openIssues.length > 0;
  const fileLabel = (f: FileRow) => {
    const who = f.person_id ? (people ?? []).find((p) => p.id === f.person_id)?.name.split(' ')[0] ?? 'dependente' : 'Titular';
    return f.kind === 'passaporte' ? 'Passaporte/contrato' : f.kind === 'certidao_casamento' ? 'Certidão de casamento' : `RG/CNH (${who})`;
  };
  async function downloadAll() {
    if (!files.length) return;
    const t = toast.loading('Preparando os arquivos…');
    try {
      const entries: Record<string, Uint8Array> = {};
      for (const [k, f] of files.entries()) {
        if (!f.url) continue;
        const buf = new Uint8Array(await (await fetch(f.url)).arrayBuffer());
        const ext = f.mime === 'application/pdf' ? 'pdf' : f.mime === 'image/png' ? 'png' : f.mime === 'image/webp' ? 'webp' : 'jpg';
        entries[`${String(k + 1).padStart(2, '0')}-${fileLabel(f).replace(/[^\w\-() ]+/g, '').replace(/\s+/g, '_')}.${ext}`] = buf;
      }
      const data = await new Promise<Uint8Array>((res, rej) => zip(entries, { level: 0 }, (err, out) => (err ? rej(err) : res(out))));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
      a.download = `recadastro-${sub.protocol}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast.success('Arquivos baixados', { id: t });
    } catch {
      toast.error('Não foi possível baixar os arquivos', { id: t });
    }
  }
  const TABS = [
    ['resumo', 'Resumo', LayoutGrid, null],
    ['titular', 'Titular', UserRound, null],
    ['dependentes', 'Dependentes', Users, people?.length ?? 0],
    ['documentos', 'Documentos', FileText, files.length],
  ] as const;
  const row = 'grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 border-b border-[var(--color-border-soft)] py-1.5 text-sm last:border-0';
  const rowLabel = 'text-xs text-[var(--color-text-muted)]';
  const rowVal = 'min-w-0 truncate text-[var(--color-text-primary)]';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto @min-[1040px]:flex-row @min-[1040px]:overflow-visible">
      {/* ============ CENTRO ============ */}
      <section className={cn(box, '@container flex min-w-0 flex-col @min-[1040px]:min-h-0 @min-[1040px]:flex-1')} aria-label="Dados do cadastro selecionado">
        <div className="border-b border-[var(--color-border-card)] px-3 pt-3 sm:px-4 sm:pt-4">
          <div className="flex items-start gap-2">
            <button type="button" aria-label="Voltar para a lista" onClick={onClose}
              className="-ml-1 rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] @min-[760px]/page:hidden"><ArrowLeft className="h-5 w-5" /></button>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-[var(--color-text-muted)]">Protocolo #{sub.protocol} · Recebido em {fmtDateTime(sub.completed_at ?? sub.created_at)}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-xl font-semibold text-[var(--color-text-primary)]">{sub.holder_name}</h2>
                <StatusChip status={sub.status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-text-secondary)]">
                <span className="inline-flex items-center gap-1"><Layers className="h-3.5 w-3.5" /> Produto: <strong className="text-[var(--accent-primary)]">{PLAN[sub.plan]}</strong></span>
                <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Titular{sub.people_count ? <> · <strong className="text-[var(--color-text-primary)]">{sub.people_count} pessoas</strong></> : ` + ${people?.length ?? 0} dependente(s)`}</span>
                {(sub.checked_at || sub.launched_at) && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {sub.checked_at && <>Conferido em {fmtDateTime(sub.checked_at)}</>}
                    {sub.checked_at && sub.launched_at && ' · '}
                    {sub.launched_at && <>Lançado no Pocket em {fmtDateTime(sub.launched_at)}</>}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div role="tablist" aria-label="Seções do cadastro" className="mt-3 flex max-w-full flex-wrap gap-x-1">
            {TABS.map(([k, label, Icon, n]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={cn('inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm font-medium',
                  tab === k ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
                <Icon className="h-4 w-4" /> {label}{n !== null ? ` (${n})` : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="p-3 sm:p-4 @min-[1040px]:min-h-0 @min-[1040px]:flex-1 @min-[1040px]:overflow-y-auto" data-pocket-protocol={sub.protocol} data-pocket-status={sub.status}>
          {sub.status === 'enviando' && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-[rgba(245,158,11,0.1)] p-2 text-sm text-[var(--color-text-primary)]">
              <span className="min-w-0 flex-1">O associado começou mas não terminou de enviar os documentos. Complete (dados, dependentes e anexos) e conclua.</span>
              {canManage && <Button size="sm" variant="outline" disabled={saving} onClick={() => void saveSub({ status: 'novo' }, 'Envio concluído pela equipe — agora está em "Novo"')}>Concluir envio</Button>}
            </div>
          )}

          {/* ---------- RESUMO ---------- */}
          <div className={cn('space-y-3', tab !== 'resumo' && 'hidden')}>
            <div className="grid gap-3 @min-[640px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className={cn(sectionTitle, 'inline-flex items-center gap-1.5')}><UserRound className="h-4 w-4 text-[var(--accent-primary)]" /> Dados do titular</h3>
                  {canManage && <Button size="sm" variant="outline" onClick={() => setEditSub(true)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>}
                </div>
                <div className={row}><span className={rowLabel}>Nome completo</span><span className={rowVal}>{sub.holder_name}</span></div>
                <div className={row}><span className={rowLabel}>CPF</span><span className={rowVal}>{fmtCpf(sub.holder_cpf)}</span></div>
                <div className={row}><span className={rowLabel}>Nascimento</span><span className={rowVal}>{fmtDate(sub.holder_birth)}{ageOf(sub.holder_birth)}</span></div>
                <div className={row}><span className={rowLabel}>E-mail</span><span className={rowVal}>{sub.holder_email ?? '—'}</span></div>
                <div className={row}><span className={rowLabel}>WhatsApp</span>
                  <span className={cn(rowVal, 'inline-flex items-center gap-1')}><MessageCircle className="h-3.5 w-3.5 text-[#16a34a]" />{sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : '—'}</span></div>
                <div className={row}><span className={rowLabel}>Acesso ao portal</span><span className={rowVal}>WhatsApp e e-mail</span></div>
              </div>
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3">
                <h3 className={cn(sectionTitle, 'mb-1 inline-flex items-center gap-1.5')}><Layers className="h-4 w-4 text-[var(--accent-primary)]" /> Resumo do cadastro</h3>
                <div className={row}><span className={rowLabel}>Status atual</span><span><StatusChip status={sub.status} /></span></div>
                <div className={row}><span className={rowLabel}>Pendências</span>
                  <span>{openIssues.length
                    ? <span className="rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-xs font-semibold text-[var(--color-error)]">{openIssues.length} {openIssues.length > 1 ? 'itens' : 'item'}</span>
                    : <span className="text-sm text-[var(--color-text-muted)]">nenhuma</span>}</span></div>
                <div className={row}><span className={rowLabel}>Dependentes</span><span className={rowVal}>{people?.length ?? '…'} cadastrado(s)</span></div>
                <div className={row}><span className={rowLabel}>Documentos</span><span className={rowVal}>{files.length} enviado(s) · {checkpoints.filter((c) => c.files.length).length}/{checkpoints.length} pontos</span></div>
                <div className={row}><span className={rowLabel}>Produto</span><span className={cn(rowVal, 'font-semibold')}>{PLAN[sub.plan]}</span></div>
                <div className={row}><span className={rowLabel}>Nº passaporte</span><span className={rowVal}>{sub.no_proof ? 'declarou que não tem' : sub.passport_number ?? '—'}</span></div>
              </div>
            </div>
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className={cn(sectionTitle, 'inline-flex items-center gap-1.5')}><FileText className="h-4 w-4 text-[var(--accent-primary)]" /> Documentos enviados ({files.length})</h3>
                <div className="flex gap-2">
                  {checkpoints.some((c) => !c.files.length) && <Button size="sm" variant="ghost" onClick={() => setTab('documentos')}>Ver faltantes</Button>}
                  {files.length > 0 && <Button size="sm" variant="outline" onClick={() => void downloadAll()}><Download className="h-3.5 w-3.5" /> Baixar todos</Button>}
                </div>
              </div>
              {people === null ? <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-primary)]" />
                : files.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhum arquivo enviado.</p>
                : (
                  <div className="grid grid-cols-2 gap-2 @min-[560px]:grid-cols-3 @min-[820px]:grid-cols-4">
                    {files.map((f) => (
                      <button key={f.id} type="button" onClick={() => openFile(f)} title="Abrir documento"
                        className="min-w-0 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-2 text-left hover:border-[var(--accent-primary)]">
                        <div className="flex h-24 items-center justify-center overflow-hidden rounded-md bg-[var(--color-surface-hover)]">
                          {f.mime.startsWith('image/') && f.url
                            ? <img src={f.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                            : <span className="flex flex-col items-center text-xs text-[var(--color-text-secondary)]"><FileText className="h-7 w-7" />PDF</span>}
                        </div>
                        <div className="mt-1.5 truncate text-xs font-medium text-[var(--color-text-primary)]">{fileLabel(f)}</div>
                        <span className="mt-1 inline-block rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]">Enviado · conferir</span>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          </div>

          {/* ---------- TITULAR (campos com data-pocket para a extensão) ---------- */}
          <div className={cn('space-y-5', tab !== 'titular' && 'hidden')}>
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className={sectionTitle}>Titular</h3>
                {canManage && <Button size="sm" variant="ghost" onClick={() => setEditSub(true)}><Pencil className="h-3.5 w-3.5" /> Editar dados</Button>}
              </div>
              <div className="grid gap-2 @min-[520px]:grid-cols-2">
                <CopyField label="Nome completo" value={sub.holder_name} field="titular_nome" wide />
                <CopyField label="CPF" value={fmtCpf(sub.holder_cpf)} field="titular_cpf" />
                <CopyField label="Nascimento" value={fmtDate(sub.holder_birth)} field="titular_nascimento" />
                <CopyField label="E-mail" value={sub.holder_email ?? ''} field="titular_email" />
                <CopyField label="WhatsApp" value={sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : ''} field="titular_whatsapp" />
                <CopyField label="Acesso ao portal" value="WhatsApp e e-mail" field="acesso_portal" />
              </div>
              {canManage && <PhoneEditor key={sub.holder_phone ?? ''} current={sub.holder_phone} disabled={saving}
                onSave={(digits) => saveSub({ holder_phone: digits }, 'WhatsApp do titular salvo')} />}
              {sub.contact_id && (
                <Link to={`/contacts/${sub.contact_id}`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent-primary)] hover:underline">
                  <ExternalLink className="h-3.5 w-3.5" /> Abrir contato / conversa no CRM
                </Link>
              )}
            </section>
            <section>
              <h3 className={cn(sectionTitle, 'mb-2')}>Passaporte</h3>
              <div className="grid gap-2 @min-[520px]:grid-cols-2">
                <CopyField label="Passaporte informado" value={`${PLAN[sub.plan]}${sub.people_count ? ` — ${sub.people_count} pessoa(s)` : ''}`} field="plano" />
                <CopyField label="Nº passaporte/contrato" value={sub.passport_number ?? ''} field="numero_passaporte" />
              </div>
            </section>
          </div>

          {/* ---------- DEPENDENTES ---------- */}
          <div className={cn(tab !== 'dependentes' && 'hidden')}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className={sectionTitle}>Dependentes ({people?.length ?? 0})</h3>
              {canManage && people !== null && <Button size="sm" variant="ghost" onClick={() => setEditPerson('new')}><Plus className="h-3.5 w-3.5" /> Adicionar dependente</Button>}
            </div>
            {people === null && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-primary)]" />}
            {people?.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum dependente informado.</p>}
            <div className="space-y-2.5">
              {(people ?? []).map((p) => (
                <div key={p.id} data-pocket-dependente={p.position} className="rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-2.5">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-[11px] font-bold text-[var(--accent-primary)]">{p.position}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">{p.name}</span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{relLabel(p)}</span>
                    {canManage && (
                      <button type="button" title="Editar dependente" aria-label={`Editar ${p.name}`} onClick={() => setEditPerson(p)}
                        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--accent-primary)]"><Pencil className="h-3.5 w-3.5" /></button>
                    )}
                  </div>
                  <div className="grid gap-2 @min-[520px]:grid-cols-2">
                    <CopyField label="Nome" value={p.name} field="dep_nome" wide />
                    <CopyField label="Nascimento" value={fmtDate(p.birth_date)} field="dep_nascimento" />
                    <CopyField label="Parentesco" value={relLabel(p)} field="dep_parentesco" />
                    <CopyField label="CPF" value={fmtCpf(p.cpf)} field="dep_cpf" />
                    <CopyField label="E-mail" value={p.email ?? ''} field="dep_email" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---------- DOCUMENTOS (pontos de conferência + anexar) ---------- */}
          <div className={cn(tab !== 'documentos' && 'hidden')}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className={sectionTitle}>Documentos</h3>
              <span className="text-xs text-[var(--color-text-muted)]">
                {people === null ? 'carregando…' : `${checkpoints.filter((c) => c.files.length).length} de ${checkpoints.length} pontos com arquivo`}
              </span>
            </div>
            <div className="grid gap-2 @min-[520px]:grid-cols-2">
              {checkpoints.map((c) => (
                <div key={c.key} className={cn('min-w-0 rounded-[var(--radius-control)] border p-2.5',
                  c.files.length ? 'border-[var(--color-border-soft)]' : 'border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.05)]')}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-[var(--color-text-primary)]" title={c.label}>{c.label}</span>
                    {c.key === 'pass' && sub.no_proof
                      ? <span className="shrink-0 text-[11px] font-semibold text-[var(--color-error)]">declarou que não tem</span>
                      : c.files.length
                      ? <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">● enviado · conferir</span>
                      : <span className="shrink-0 text-[11px] font-semibold text-[var(--color-error)]">○ não enviado</span>}
                  </div>
                  <Thumbs list={c.files} onOpen={openFile} />
                  {canManage && <AddFiles sub={sub} kind={c.kind} personId={c.personId} onDone={() => setFilesVer((v) => v + 1)} />}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============ DIREITA: AÇÕES E PENDÊNCIAS ============ */}
      <aside className={cn(box, 'flex min-w-0 flex-col @min-[1040px]:min-h-0 @min-[1040px]:w-[320px] @min-[1040px]:shrink-0')} aria-label="Ações e pendências">
        <div className="space-y-4 p-3 sm:p-4 @min-[1040px]:min-h-0 @min-[1040px]:flex-1 @min-[1040px]:overflow-y-auto">
          <h2 className="inline-flex items-center gap-1.5 text-base font-semibold text-[var(--color-text-primary)]"><Zap className="h-4 w-4 text-[#f59e0b]" /> Ações e pendências</h2>
          {canManage && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">Status do cadastro</span>
              <select value={sub.status} disabled={saving} aria-label="Status do recadastramento"
                onChange={(e) => void saveSub({ status: e.target.value as Status }, 'Status atualizado')}
                className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)]">
                {(Object.keys(STATUS) as Status[])
                  .filter((s) => (s !== 'enviando' || sub.status === 'enviando') && (s !== 'lancado' || sub.status === 'conferido' || sub.status === 'lancado'))
                  .map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
            </label>
          )}
          <div className="space-y-2">
            <Button className={cn('h-10 w-full', WA_GREEN)} onClick={() => setWhatsOpen(true)}>
              <MessageCircle className="h-4 w-4" /> {openIssues.length ? 'Enviar pendências pelo WhatsApp' : 'Conversar no WhatsApp'}
            </Button>
            {canManage && ['novo', 'em_analise', 'pendente'].includes(sub.status) && (
              <Button className="h-10 w-full" disabled={saving} variant={blocked ? 'outline' : 'default'} data-pocket-action="conferir"
                title={blocked ? 'Resolva as pendências em aberto antes' : undefined}
                onClick={() => void saveSub({ status: 'conferido' }, 'Marcado como conferido — pronto para lançar')}>
                {blocked ? <Lock className="h-4 w-4" /> : <Check className="h-4 w-4" />} Marcar como conferido
              </Button>
            )}
            {canManage && sub.status === 'conferido' && (
              <Button className="h-10 w-full" disabled={saving} data-pocket-action="marcar-lancado" onClick={() => void saveSub({ status: 'lancado' }, 'Marcado como lançado no Pocket')}>
                <Check className="h-4 w-4" /> Marcar como lançado no Pocket
              </Button>
            )}
            <Button size="sm" variant="ghost" className="w-full" onClick={() => void copy(allText, 'Dados copiados')}><Copy className="h-3.5 w-3.5" /> Copiar tudo (para o Pocket)</Button>
          </div>

          {!centralReady ? (
            <div className="rounded-[var(--radius-control)] bg-[rgba(245,158,11,0.1)] p-2.5 text-xs text-[var(--color-text-primary)]">
              Pendências e observações ainda não foram instaladas no banco (SQL <code>20261113090000_recad_central</code>).
            </div>
          ) : (
            <>
              <section className={cn('rounded-[var(--radius-card)] border',
                openIssues.length ? 'border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.05)]' : 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.05)]')}>
                <div className={cn('flex items-center gap-1.5 px-3 py-2 text-sm font-semibold',
                  openIssues.length ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]')}>
                  {openIssues.length ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  {openIssues.length ? `Pendências do cadastro (${openIssues.length})` : 'Sem pendências abertas'}
                </div>
                {sortedIssues.length > 0 && (
                  <div className="space-y-1 px-2 pb-2">
                    {sortedIssues.map((i) => (
                      <div key={i.id} className={cn('flex items-start gap-2 rounded-md p-1.5', i.status === 'resolvida' && 'opacity-70')}>
                        <input type="checkbox" checked={i.status === 'resolvida'} disabled={!canManage}
                          aria-label={i.status === 'aberta' ? `Resolver: ${i.text}` : `Reabrir: ${i.text}`}
                          onChange={() => void setIssue(i.id, { status: i.status === 'aberta' ? 'resolvida' : 'aberta' })}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                        <div className="min-w-0 flex-1">
                          <div className={cn('break-words text-sm text-[var(--color-text-primary)]', i.status === 'resolvida' && 'line-through')}>{i.text}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]">
                            {i.status === 'resolvida'
                              ? <>Resolvida por {nameOf(i.resolved_by)} em {fmtDateTime(i.resolved_at)}</>
                              : <>Aberta por {nameOf(i.created_by)} em {fmtDateTime(i.created_at)}</>}
                          </div>
                        </div>
                        {canManage && i.status === 'resolvida' && (
                          <button type="button" title="Reabrir" aria-label="Reabrir pendência" onClick={() => void setIssue(i.id, { status: 'aberta' })}
                            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"><RotateCcw className="h-3.5 w-3.5" /></button>
                        )}
                        {canManage && (
                          <button type="button" title="Excluir pendência" aria-label="Excluir pendência"
                            onClick={() => { if (window.confirm('Excluir esta pendência? Ela continua registrada no histórico.')) void setIssue(i.id, { deleted_at: new Date().toISOString() }); }}
                            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[rgba(239,68,68,0.1)] hover:text-[var(--color-error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
              {canManage && <IssueAdder onAdd={addIssue} />}

              <section>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className={cn(sectionTitle, 'inline-flex items-center gap-1.5')}><Users className="h-4 w-4 text-[var(--accent-primary)]" /> Observações da equipe</h3>
                  <span className="rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-primary)]">Interno</span>
                </div>
                <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">Só a equipe vê. Não vão para o WhatsApp, o formulário nem o portal.</p>
                {canManage && <NoteAdder subId={sub.id} onSaved={() => void loadSide()} />}
                {notes[0] && <NoteCard n={notes[0]} nameOf={nameOf} />}
                {notes.length > 1 && (
                  <button type="button" onClick={() => setNotesOpen(true)} className="mt-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline">
                    Ver todas as {notes.length} observações
                  </button>
                )}
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className={cn(sectionTitle, 'inline-flex items-center gap-1.5')}><History className="h-4 w-4 text-[var(--accent-primary)]" /> Histórico de ações</h3>
                  <button type="button" onClick={() => setHistoryOpen(true)} className="text-xs font-semibold text-[var(--accent-primary)] hover:underline">Ver completo</button>
                </div>
                <ol className="relative space-y-3 border-l border-[var(--color-border-card)] pl-4">
                  {recent.map((e, k) => (
                    <li key={e.id} className="relative">
                      <span className={cn('absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full', k === 0 ? 'bg-[var(--accent-fill)]' : 'bg-[var(--color-border-card)]')} />
                      <div className="break-words text-sm text-[var(--color-text-primary)]">{eventText(e)}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">{fmtDateTime(e.at)} · {e.actor ? nameOf(e.actor) : 'Sistema'}</div>
                    </li>
                  ))}
                  <li className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-[var(--color-border-card)]" />
                    <div className="text-sm text-[var(--color-text-primary)]">Solicitação recebida</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{fmtDateTime(sub.completed_at ?? sub.created_at)} · Associado</div>
                  </li>
                </ol>
              </section>
            </>
          )}
        </div>
      </aside>

      {/* ============ MODAIS ============ */}
      {viewer !== null && files[viewer] && (
        <FileViewer files={files} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
      <WhatsDialog open={whatsOpen} onClose={() => setWhatsOpen(false)} sub={sub} openIssues={openIssues} centralReady={centralReady} />
      <Dialog open={notesOpen} onClose={() => setNotesOpen(false)} title="Observações da equipe" description={`Protocolo #${sub.protocol} — ${sub.holder_name}`} opaque>
        <div className="space-y-2">{notes.map((n) => <NoteCard key={n.id} n={n} nameOf={nameOf} />)}</div>
      </Dialog>
      {editSub && <SubEditDialog sub={sub} onClose={() => setEditSub(false)} onSaved={(s) => { onChanged(s); setEditSub(false); }} />}
      {editPerson && <PersonDialog subId={sub.id} person={editPerson === 'new' ? null : editPerson}
        onClose={() => setEditPerson(null)} onSaved={() => { setEditPerson(null); setFilesVer((v) => v + 1); }} />}
      {historyOpen && <HistoryDialog subId={sub.id} title={`Protocolo #${sub.protocol} — ${sub.holder_name}`} nameOf={nameOf} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

function ageOf(d: string | null): string {
  if (!d) return '';
  const b = new Date(`${d.slice(0, 10)}T12:00:00`), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a >= 0 && a < 130 ? ` (${a} anos)` : '';
}

function Thumbs({ list, onOpen }: { list: FileRow[]; onOpen: (f: FileRow) => void }) {
  if (!list.length) return <div className="text-[11px] text-[var(--color-text-muted)]">Peça o arquivo ao associado (pendência).</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((f) => (
        <button key={f.id} type="button" onClick={() => onOpen(f)} title="Abrir documento"
          className="block h-16 w-16 overflow-hidden rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-hover)] hover:ring-2 hover:ring-[var(--accent-primary)]">
          {f.mime.startsWith('image/') && f.url
            ? <img src={f.url} alt="Documento" loading="lazy" className="h-full w-full object-cover" />
            : <span className="flex h-full w-full flex-col items-center justify-center text-[11px] text-[var(--color-text-secondary)]"><FileText className="h-5 w-5" />{f.mime === 'application/pdf' ? 'PDF' : 'Arquivo'}</span>}
        </button>
      ))}
    </div>
  );
}

function FileViewer({ files, index, onIndex, onClose }: { files: FileRow[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const f = files[index];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < files.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, files.length, onIndex, onClose]);
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-black/85" role="dialog" aria-modal="true" aria-label="Documento">
      <div className="flex items-center gap-2 p-2 text-white">
        <span className="min-w-0 flex-1 truncate text-sm">Documento {index + 1} de {files.length}</span>
        {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="rounded px-2 py-1 text-sm hover:bg-white/10"><ExternalLink className="inline h-4 w-4" /> Abrir em outra aba</a>}
        <button type="button" aria-label="Fechar" onClick={onClose} className="rounded p-1.5 hover:bg-white/10"><X className="h-5 w-5" /></button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2" onClick={onClose}>
        <div className="flex h-full w-full items-center justify-center" onClick={(e) => e.stopPropagation()}>
          {!f.url ? <p className="text-sm text-white">Não foi possível abrir este arquivo.</p>
            : f.mime.startsWith('image/') ? <img src={f.url} alt="Documento" className="max-h-full max-w-full object-contain" />
              : <iframe src={f.url} title="Documento" className="h-full w-full max-w-4xl rounded bg-white" />}
        </div>
        {index > 0 && <button type="button" aria-label="Anterior" onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }} className="absolute left-2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"><ChevronLeft className="h-6 w-6" /></button>}
        {index < files.length - 1 && <button type="button" aria-label="Próximo" onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }} className="absolute right-2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"><ChevronRight className="h-6 w-6" /></button>}
      </div>
    </div>
  );
}

function PhoneEditor({ current, disabled, onSave }: { current: string | null; disabled: boolean; onSave: (digits: string | null) => Promise<boolean> }) {
  const [v, setV] = useState(current ? formatPhoneDisplay(current) : '');
  const digits = v.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const changed = digits !== (current ?? '').replace(/^55(?=\d{10,11}$)/, '');
  const valid = digits === '' || /^\d{10,11}$/.test(digits);
  return (
    <div className="mt-2">
      <label className="text-[11px] font-medium text-[var(--color-text-muted)]" htmlFor="recad-phone">Corrigir / cadastrar WhatsApp do titular</label>
      <div className="flex gap-2">
        <input id="recad-phone" inputMode="tel" value={v} onChange={(e) => setV(e.target.value)} placeholder="(68) 99999-9999"
          className="h-9 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
        <Button size="sm" variant="outline" disabled={disabled || !changed || !valid} onClick={() => void onSave(digits || null)}>Salvar número</Button>
      </div>
      {!valid && <p className="mt-1 text-[11px] text-[var(--color-error)]">DDD + número (10 ou 11 dígitos).</p>}
    </div>
  );
}

function IssueAdder({ onAdd }: { onAdd: (t: string) => Promise<boolean> }) {
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  async function add(text: string, clear: boolean) {
    setBusy(true);
    const ok = await onAdd(text);
    setBusy(false);
    if (ok && clear) setT('');
  }
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-medium text-[var(--color-text-muted)]">Nova pendência</div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(t, true); }}>
        <input value={t} onChange={(e) => setT(e.target.value)} maxLength={400} placeholder="Ex.: Enviar foto legível do contrato"
          className="h-9 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
        <Button size="sm" type="submit" disabled={busy || !t.trim()} aria-label="Adicionar pendência"><Plus className="h-4 w-4" /></Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK.map(([label, text]) => (
          <button key={label} type="button" disabled={busy} onClick={() => void add(text, false)}
            className="rounded-full border border-[var(--color-border-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
            + {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NoteAdder({ subId, onSaved }: { subId: string; onSaved: () => void }) {
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    const text = t.trim();
    if (!text) return;
    setBusy(true);
    const { error } = await getSupabase().from('recad_notes').insert({ submission_id: subId, text: text.slice(0, 3000) });
    setBusy(false);
    if (error) { toast.error('Não foi possível salvar a observação', { description: error.message }); return; }
    setT('');
    toast.success('Observação salva');
    onSaved();
  }
  return (
    <div>
      <textarea value={t} onChange={(e) => setT(e.target.value)} maxLength={3000} rows={3} placeholder="Registre o que falta, o que já foi conferido ou uma orientação…"
        className="w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={busy || !t.trim()} onClick={() => void save()}><Plus className="h-3.5 w-3.5" /> Salvar observação</Button>
      </div>
    </div>
  );
}

function NoteCard({ n, nameOf }: { n: Note; nameOf: (u: string | null) => string }) {
  return (
    <div className="mt-2 rounded-[var(--radius-control)] border border-[var(--color-note-border,var(--color-border-soft))] bg-[var(--color-note-bg,var(--color-surface-hover))] p-2.5">
      <div className="whitespace-pre-wrap break-words text-sm text-[var(--color-text-primary)]">{n.text}</div>
      <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{nameOf(n.created_by)} · {fmtDateTime(n.created_at)}</div>
    </div>
  );
}

function WhatsDialog({ open, onClose, sub, openIssues, centralReady }: { open: boolean; onClose: () => void; sub: Submission; openIssues: Issue[]; centralReady: boolean }) {
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState('');
  // remonta o texto ao abrir (sempre com as pendências abertas DESTE cadastro, nesse momento)
  useEffect(() => {
    if (!open) return;
    setPhone(sub.holder_phone ? formatPhoneDisplay(sub.holder_phone) : '');
    setMsg(buildWhatsMessage(sub, openIssues));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = waNumber(phone);

  function openWa() {
    if (!num) { toast.error('Informe um WhatsApp válido com DDD.'); return; }
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
    if (centralReady) {
      void getSupabase().from('recad_events').insert({ submission_id: sub.id, kind: 'whatsapp_aberto', meta: { pendencias: openIssues.length } });
    }
    toast.info('Conversa aberta no WhatsApp. Confira e envie por lá — o CRM não envia sozinho.');
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Contato pelo WhatsApp" opaque widthClass="max-w-xl"
      description="Confira e edite a mensagem antes de abrir a conversa. Observações internas não entram.">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-[var(--color-text-secondary)]" htmlFor="wa-phone">WhatsApp de {sub.holder_name}</label>
          <input id="wa-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(68) 99999-9999"
            className="mt-1 h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
          <p className={cn('mt-1 text-[11px]', num ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-error)]')}>
            {num ? `Vai abrir: +${num}` : 'Número sem DDD ou inválido.'}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-[var(--color-text-secondary)]" htmlFor="wa-msg">
            Mensagem ({openIssues.length ? `${openIssues.length} pendência${openIssues.length > 1 ? 's' : ''} em aberto` : 'sem pendências em aberto'})
          </label>
          <textarea id="wa-msg" value={msg} onChange={(e) => setMsg(e.target.value)} rows={12}
            className="mt-1 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void copy(msg, 'Mensagem copiada')}><Copy className="h-4 w-4" /> Copiar mensagem</Button>
          <Button className={WA_GREEN} disabled={!num || !msg.trim()} onClick={openWa}><MessageCircle className="h-4 w-4" /> Abrir conversa</Button>
        </div>
      </div>
    </Dialog>
  );
}

function HistoryDialog({ subId, title, nameOf, onClose }: { subId: string; title: string; nameOf: (u: string | null) => string; onClose: () => void }) {
  const [rows, setRows] = useState<EventRow[] | null>(null);
  useEffect(() => {
    let c = false;
    void getSupabase().from('recad_events').select('id, kind, actor, at, meta').eq('submission_id', subId).order('at', { ascending: false }).limit(300)
      .then(({ data }) => { if (!c) setRows((data ?? []) as EventRow[]); });
    return () => { c = true; };
  }, [subId]);
  return (
    <Dialog open onClose={onClose} title="Histórico" description={title} opaque widthClass="max-w-xl">
      {rows === null && <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" />}
      {rows?.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nada registrado ainda.</p>}
      <ol className="space-y-2">
        {(rows ?? []).map((e) => (
          <li key={e.id} className="flex gap-2 text-sm">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
            <div className="min-w-0">
              <div className="break-words text-[var(--color-text-primary)]">{eventText(e)}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{nameOf(e.actor)} · {fmtDateTime(e.at)}</div>
            </div>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

// ------------------------------------------------------------------ equipe completando o cadastro
function AddFiles({ sub, kind, personId, onDone }: { sub: Submission; kind: FileRow['kind']; personId: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function pick(list: FileList | null) {
    const arr = Array.from(list ?? []);
    if (!arr.length) return;
    setBusy(true);
    let ok = 0;
    for (const f of arr.slice(0, 6)) {
      try { await uploadTeamFile(sub, kind, personId, f); ok++; }
      catch (e) { toast.error('Não foi possível anexar', { description: e instanceof Error ? e.message : String(e) }); }
    }
    setBusy(false);
    if (ok) { toast.success(`${ok} arquivo(s) anexado(s)`); onDone(); }
  }
  return (
    <label className={cn('mt-2 inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-[var(--color-border-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]',
      busy && 'pointer-events-none opacity-60')}>
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />} {busy ? 'Anexando…' : 'Anexar arquivo'}
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="sr-only"
        onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
    </label>
  );
}

const fieldCls = 'h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls = 'text-xs font-medium text-[var(--color-text-secondary)]';
const onlyDigits = (v: string) => v.replace(/\D/g, '');
const maskCpf = (v: string) => { const d = onlyDigits(v).slice(0, 11); return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'); };
function cpfOk(raw: string) {
  const d = onlyDigits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function SubEditDialog({ sub, onClose, onSaved }: { sub: Submission; onClose: () => void; onSaved: (s: Submission) => void }) {
  const [f, setF] = useState({
    name: sub.holder_name, cpf: maskCpf(sub.holder_cpf), birth: sub.holder_birth ?? '', email: sub.holder_email ?? '',
    plan: sub.plan, people: String(sub.people_count ?? ''), passport: sub.passport_number ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    if (f.name.trim().length < 3) return toast.error('Informe o nome completo.');
    if (!cpfOk(f.cpf)) return toast.error('CPF inválido.');
    if (f.plan === 'amai10' && !(Number(f.people) >= 1 && Number(f.people) <= 10)) return toast.error('No AMAI 10, informe de 1 a 10 pessoas.');
    setBusy(true);
    const { data, error } = await getSupabase().from('recad_submissions').update({
      holder_name: f.name, holder_cpf: onlyDigits(f.cpf), holder_birth: f.birth || null, holder_email: f.email || null,
      plan: f.plan, people_count: f.plan === 'amai10' ? Number(f.people) : null, passport_number: f.passport || null,
    }).eq('id', sub.id).select(SUB_COLS).single();
    setBusy(false);
    if (error) return toast.error('Não foi possível salvar', { description: error.message });
    toast.success('Dados corrigidos (registrado no histórico)');
    onSaved(data as Submission);
  }
  return (
    <Dialog open onClose={onClose} title="Editar dados do titular" description={`Protocolo #${sub.protocol} — a correção fica no histórico.`} opaque widthClass="max-w-lg">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className={labelCls}>Nome completo</span><input className={fieldCls} value={f.name} maxLength={120} onChange={set('name')} /></label>
        <label><span className={labelCls}>CPF</span><input className={fieldCls} inputMode="numeric" value={f.cpf} onChange={(e) => setF({ ...f, cpf: maskCpf(e.target.value) })} /></label>
        <label><span className={labelCls}>Nascimento</span><input className={fieldCls} type="date" value={f.birth} onChange={set('birth')} /></label>
        <label className="sm:col-span-2"><span className={labelCls}>E-mail</span><input className={fieldCls} type="email" value={f.email} maxLength={254} onChange={set('email')} /></label>
        <label><span className={labelCls}>Passaporte</span>
          <select className={fieldCls} value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as Submission['plan'] })}>
            {Object.entries(PLAN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        {f.plan === 'amai10'
          ? <label><span className={labelCls}>Pessoas (com o titular)</span><input className={fieldCls} inputMode="numeric" value={f.people} onChange={(e) => setF({ ...f, people: onlyDigits(e.target.value).slice(0, 2) })} /></label>
          : <div />}
        <label className="sm:col-span-2"><span className={labelCls}>Nº passaporte/contrato</span><input className={fieldCls} value={f.passport} maxLength={40} onChange={set('passport')} /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>
      </div>
    </Dialog>
  );
}

function PersonDialog({ subId, person, onClose, onSaved }: { subId: string; person: PersonRow | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: person?.name ?? '', birth: person?.birth_date ?? '', rel: person?.relationship ?? 'filho', other: person?.relationship_other ?? '',
    cpf: maskCpf(person?.cpf ?? ''), email: person?.email ?? '',
  });
  const [busy, setBusy] = useState(false);
  async function save() {
    if (f.name.trim().length < 3) return toast.error('Informe o nome completo.');
    if (!f.birth) return toast.error('Informe a data de nascimento.');
    if (f.cpf && !cpfOk(f.cpf)) return toast.error('CPF inválido.');
    if (f.rel === 'outro' && !f.other.trim()) return toast.error('Diga qual é o parentesco.');
    setBusy(true);
    const row = { name: f.name, birth_date: f.birth, relationship: f.rel, relationship_other: f.rel === 'outro' ? f.other.trim().slice(0, 40) : null,
      cpf: onlyDigits(f.cpf) || null, email: f.email.trim() || null };
    const sb = getSupabase();
    const { error } = person
      ? await sb.from('recad_people').update(row).eq('id', person.id)
      : await sb.from('recad_people').insert({ ...row, submission_id: subId, position: 0 });
    setBusy(false);
    if (error) return toast.error('Não foi possível salvar', { description: error.message });
    toast.success(person ? 'Dependente corrigido' : 'Dependente incluído — anexe o documento dele');
    onSaved();
  }
  return (
    <Dialog open onClose={onClose} title={person ? 'Editar dependente' : 'Adicionar dependente'} opaque widthClass="max-w-lg"
      description="Fica registrado no histórico com o seu nome.">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className={labelCls}>Nome completo</span><input className={fieldCls} value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label><span className={labelCls}>Nascimento</span><input className={fieldCls} type="date" value={f.birth} onChange={(e) => setF({ ...f, birth: e.target.value })} /></label>
        <label><span className={labelCls}>Parentesco</span>
          <select className={fieldCls} value={f.rel} onChange={(e) => setF({ ...f, rel: e.target.value })}>
            {Object.entries(REL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        {f.rel === 'outro' && <label className="sm:col-span-2"><span className={labelCls}>Qual parentesco?</span><input className={fieldCls} value={f.other} maxLength={40} onChange={(e) => setF({ ...f, other: e.target.value })} /></label>}
        <label><span className={labelCls}>CPF (se tiver)</span><input className={fieldCls} inputMode="numeric" value={f.cpf} onChange={(e) => setF({ ...f, cpf: maskCpf(e.target.value) })} /></label>
        <label><span className={labelCls}>E-mail (se tiver)</span><input className={fieldCls} type="email" value={f.email} maxLength={254} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>
      </div>
    </Dialog>
  );
}
