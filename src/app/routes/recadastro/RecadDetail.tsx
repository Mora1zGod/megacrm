import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Copy, ExternalLink, FileText, History,
  Info, Loader2, Lock, MessageCircle, Plus, RotateCcw, Trash2, Users, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatPhoneDisplay } from '@/lib/phone';
import {
  BUCKET, CopyField, PLAN, STATUS, SUB_COLS, StatusChip, buildWhatsMessage, copy, eventText, fmtCpf, fmtDate, fmtDateTime,
  relLabel, waNumber, type EventRow, type FileRow, type Issue, type Note, type PersonRow, type Status, type Submission,
} from './recadShared';

const QUICK = [
  ['RG / CNH', 'Enviar foto legível do RG ou CNH (frente e verso).'],
  ['Contrato', 'Enviar foto do título, passaporte ou contrato do AMAI Park.'],
  ['Dados divergentes', 'Confirmar dados que estão diferentes do cadastro.'],
  ['Certidão', 'Enviar certidão de casamento ou de união estável.'],
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
  }, [sub.id]);

  // pendências + observações (recarrega com o tempo real)
  const loadSide = useCallback(async () => {
    if (!centralReady) return;
    const sb = getSupabase();
    const [{ data: i }, { data: n }] = await Promise.all([
      sb.from('recad_issues').select('id, submission_id, text, status, created_by, created_at, resolved_by, resolved_at, deleted_at')
        .eq('submission_id', sub.id).is('deleted_at', null).order('created_at'),
      sb.from('recad_notes').select('id, submission_id, text, created_by, created_at').eq('submission_id', sub.id).order('created_at', { ascending: false }),
    ]);
    // guarda contra resposta atrasada de outro cadastro
    setIssues(((i ?? []) as Issue[]).filter((x) => x.submission_id === sub.id));
    setNotes(((n ?? []) as Note[]).filter((x) => x.submission_id === sub.id));
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
    const list: { key: string; label: string; files: FileRow[] }[] = [
      { key: 'pass', label: 'Passaporte / comprovante', files: files.filter((f) => !f.person_id && f.kind === 'passaporte') },
      { key: 'doc', label: 'RG / CNH do titular', files: files.filter((f) => !f.person_id && f.kind === 'documento') },
    ];
    if (needsCert) list.push({ key: 'cert', label: 'Certidão de casamento / união', files: files.filter((f) => f.kind === 'certidao_casamento') });
    for (const p of people ?? []) list.push({ key: p.id, label: `Documento — ${p.name.split(' ')[0]} (${relLabel(p)})`, files: files.filter((f) => f.person_id === p.id) });
    return list;
  }, [files, people, needsCert]);
  const openFile = (f: FileRow) => setViewer(files.findIndex((x) => x.id === f.id));

  const blocked = openIssues.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto @min-[1040px]:flex-row @min-[1040px]:overflow-visible">
      {/* ============ CENTRO ============ */}
      <section className={cn(box, 'flex min-w-0 flex-col @min-[1040px]:min-h-0 @min-[1040px]:flex-1')} aria-label="Dados do cadastro selecionado">
        <div className="space-y-2.5 border-b border-[var(--color-border-card)] p-3 sm:p-4">
          <div className="flex items-start gap-2">
            <button type="button" aria-label="Voltar para a lista" onClick={onClose}
              className="-ml-1 rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] @min-[760px]:hidden"><ArrowLeft className="h-5 w-5" /></button>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Protocolo #{sub.protocol} · recebido em {fmtDateTime(sub.completed_at ?? sub.created_at)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-lg font-semibold text-[var(--color-text-primary)]">{sub.holder_name}</h2>
                <StatusChip status={sub.status} />
              </div>
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {canManage ? (
              <select value={sub.status} disabled={saving} aria-label="Status do recadastramento"
                onChange={(e) => void saveSub({ status: e.target.value as Status }, 'Status atualizado')}
                className="h-9 min-w-0 max-w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)]">
                {(Object.keys(STATUS) as Status[])
                  .filter((s) => (s !== 'enviando' || sub.status === 'enviando') && (s !== 'lancado' || sub.status === 'conferido' || sub.status === 'lancado'))
                  .map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
            ) : null}
            <Button size="sm" className={WA_GREEN} onClick={() => setWhatsOpen(true)}><MessageCircle className="h-3.5 w-3.5" /> Conversar no WhatsApp</Button>
            {canManage && ['novo', 'em_analise', 'pendente'].includes(sub.status) && (
              <Button size="sm" disabled={saving} variant={blocked ? 'outline' : 'default'} data-pocket-action="conferir"
                title={blocked ? 'Resolva as pendências em aberto antes' : undefined}
                onClick={() => void saveSub({ status: 'conferido' }, 'Marcado como conferido — pronto para lançar')}>
                {blocked ? <Lock className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} Marcar como conferido
              </Button>
            )}
            {canManage && sub.status === 'conferido' && (
              <Button size="sm" disabled={saving} data-pocket-action="marcar-lancado" onClick={() => void saveSub({ status: 'lancado' }, 'Marcado como lançado no Pocket')}>
                <Check className="h-3.5 w-3.5" /> Marcar como lançado no Pocket
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void copy(allText, 'Dados copiados')}><Copy className="h-3.5 w-3.5" /> Copiar tudo</Button>
            {centralReady && <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}><History className="h-3.5 w-3.5" /> Histórico</Button>}
          </div>
          {(sub.checked_at || sub.launched_at) && (
            <div className="text-xs text-[var(--color-text-muted)]">
              {sub.checked_at && <>Conferido em {fmtDateTime(sub.checked_at)}</>}
              {sub.checked_at && sub.launched_at && ' · '}
              {sub.launched_at && <>Lançado no Pocket em {fmtDateTime(sub.launched_at)}</>}
            </div>
          )}
        </div>

        <div className="space-y-5 p-3 sm:p-4 @min-[1040px]:min-h-0 @min-[1040px]:flex-1 @min-[1040px]:overflow-y-auto" data-pocket-protocol={sub.protocol} data-pocket-status={sub.status}>
          <div className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-accent-subtle)] p-2.5 text-xs text-[var(--color-text-secondary)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" />
            <span>Dados e arquivos enviados pelo próprio associado. <strong>Enviado não é validado:</strong> confira cada documento antes de marcar como conferido.</span>
          </div>
          {sub.status === 'enviando' && (
            <p className="rounded-[var(--radius-control)] bg-[rgba(245,158,11,0.1)] p-2 text-sm text-[var(--color-text-primary)]">O associado começou mas não terminou de enviar os documentos.</p>
          )}

          <section>
            <h3 className={cn(sectionTitle, 'mb-2')}>Titular</h3>
            <div className="grid gap-2 sm:grid-cols-2">
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
            <div className="grid gap-2 sm:grid-cols-2">
              <CopyField label="Passaporte informado" value={`${PLAN[sub.plan]}${sub.people_count ? ` — ${sub.people_count} pessoa(s)` : ''}`} field="plano" />
              <CopyField label="Nº passaporte / contrato" value={sub.passport_number ?? ''} field="numero_passaporte" />
            </div>
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className={sectionTitle}>Documentos</h3>
              <span className="text-xs text-[var(--color-text-muted)]">
                {people === null ? 'carregando…' : `${checkpoints.filter((c) => c.files.length).length} de ${checkpoints.length} pontos com arquivo`}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {checkpoints.map((c) => (
                <div key={c.key} className={cn('min-w-0 rounded-[var(--radius-control)] border p-2.5',
                  c.files.length ? 'border-[var(--color-border-soft)]' : 'border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.05)]')}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-[var(--color-text-primary)]" title={c.label}>{c.label}</span>
                    {c.files.length
                      ? <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">● enviado · conferir</span>
                      : <span className="shrink-0 text-[11px] font-semibold text-[var(--color-error)]">○ não enviado</span>}
                  </div>
                  <Thumbs list={c.files} onOpen={openFile} />
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className={cn(sectionTitle, 'mb-2')}>Dependentes ({people?.length ?? 0})</h3>
            {people === null && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-primary)]" />}
            {people?.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum dependente informado.</p>}
            <div className="space-y-2.5">
              {(people ?? []).map((p) => (
                <div key={p.id} data-pocket-dependente={p.position} className="rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-2.5">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-[11px] font-bold text-[var(--accent-primary)]">{p.position}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">{p.name}</span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{relLabel(p)}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <CopyField label="Nome" value={p.name} field="dep_nome" wide />
                    <CopyField label="Nascimento" value={fmtDate(p.birth_date)} field="dep_nascimento" />
                    <CopyField label="Parentesco" value={relLabel(p)} field="dep_parentesco" />
                    <CopyField label="CPF" value={fmtCpf(p.cpf)} field="dep_cpf" />
                    <CopyField label="E-mail" value={p.email ?? ''} field="dep_email" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {/* ============ DIREITA ============ */}
      <aside className={cn(box, 'flex min-w-0 flex-col @min-[1040px]:min-h-0 @min-[1040px]:w-[320px] @min-[1040px]:shrink-0')} aria-label="Pendências e observações">
        <div className="space-y-2.5 border-b border-[var(--color-border-card)] p-3 sm:p-4">
          <div className="text-sm font-semibold text-[var(--color-text-primary)]">Pendências e observações</div>
          {!centralReady ? (
            <div className="rounded-[var(--radius-control)] bg-[rgba(245,158,11,0.1)] p-2.5 text-xs text-[var(--color-text-primary)]">
              Pendências e observações ainda não foram instaladas no banco (SQL <code>20261113090000_recad_central</code>).
            </div>
          ) : openIssues.length ? (
            <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.07)] p-2.5 text-xs text-[var(--color-text-primary)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-error)]" />
              <span><strong>{openIssues.length} pendência{openIssues.length > 1 ? 's' : ''} em aberto.</strong> Não dá para marcar como conferido ou lançado até resolver.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.07)] p-2.5 text-xs text-[var(--color-text-primary)]">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" />
              <span><strong>Sem pendências abertas.</strong> Confira os documentos antes de prosseguir.</span>
            </div>
          )}
          <Button className={cn('w-full', WA_GREEN)} onClick={() => setWhatsOpen(true)}>
            <MessageCircle className="h-4 w-4" /> Enviar pendências pelo WhatsApp
          </Button>
          <p className="text-[11px] text-[var(--color-text-muted)]">A mensagem abre para revisão no WhatsApp; nada é enviado automaticamente.</p>
        </div>

        <div className="space-y-5 p-3 sm:p-4 @min-[1040px]:min-h-0 @min-[1040px]:flex-1 @min-[1040px]:overflow-y-auto">
          {centralReady && (
            <>
              <section>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className={sectionTitle}>Pendências do cadastro</h3>
                  <span className="text-xs text-[var(--color-text-muted)]">{openIssues.length} em aberto</span>
                </div>
                {sortedIssues.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">Nenhuma pendência registrada.</p>}
                <div className="space-y-1.5">
                  {sortedIssues.map((i) => (
                    <div key={i.id} className={cn('flex items-start gap-2 rounded-[var(--radius-control)] border p-2',
                      i.status === 'aberta' ? 'border-[rgba(239,68,68,0.3)]' : 'border-[var(--color-border-soft)] opacity-75')}>
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
                {canManage && <IssueAdder onAdd={addIssue} />}
              </section>

              <section>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className={sectionTitle}>Observações da equipe</h3>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-primary)]"><Users className="h-3 w-3" /> Interno</span>
                </div>
                <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">Só a equipe vê. Não vão para o WhatsApp, o formulário nem o portal.</p>
                {canManage && <NoteAdder subId={sub.id} onSaved={() => void loadSide()} />}
                {notes.length === 0 && <p className="mt-2 text-xs text-[var(--color-text-muted)]">Nenhuma observação registrada.</p>}
                {notes[0] && <NoteCard n={notes[0]} nameOf={nameOf} />}
                {notes.length > 1 && (
                  <button type="button" onClick={() => setNotesOpen(true)} className="mt-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:underline">
                    Ver todas as {notes.length} observações
                  </button>
                )}
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
      {historyOpen && <HistoryDialog subId={sub.id} title={`Protocolo #${sub.protocol} — ${sub.holder_name}`} nameOf={nameOf} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
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
