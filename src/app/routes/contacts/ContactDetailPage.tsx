import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Briefcase, CalendarDays, CheckSquare, Clock, Filter, FolderOpen, Link2, ListTodo, MapPin, Megaphone, MessageSquare, Plus, User, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useContactProfile } from '@/hooks/useContactProfile';
import { useContactTimeline, type DayGroup } from '@/hooks/useContactTimeline';
import { useContactChannelLinks, type ContactChannelLink } from '@/hooks/useContactChannelLinks';
import { useOperators } from '@/hooks/useOperators';
import { useTasks } from '@/hooks/useTasks';
import { CONTACT_SOURCE_LABEL, getDealOrigin, TRAFFIC_TYPE_STYLE } from '@/types/crm';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { AddToPipelineModal } from '@/components/funil/AddToPipelineModal';
import { ProximaAcao } from '@/components/crm/ProximaAcao';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { type Deal } from '@/types/crm';

type ProfileTab = 'geral' | 'conversas' | 'negocios' | 'visitas' | 'tarefas' | 'campanhas' | 'arquivos' | 'atividades';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtTime = (s: string) => new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
const todayISO = () => new Date().toISOString().slice(0, 10);

const inputCls =
  'w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

const DOT: Record<string, string> = {
  conversa: 'bg-[#22C55E]',
  mudanca_estagio: 'bg-[#A78BFA]',
  nota: 'bg-[#64748B]',
  ganho: 'bg-[#10B981]',
  perdido: 'bg-[#EF4444]',
  acao_agendada: 'bg-[var(--accent-fill)]',
  acao_concluida: 'bg-[#10B981]',
};

export default function ContactDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { contact, deals, loading, error, reload, saveContact } = useContactProfile(id);
  const { groups, addNoteToDay, reload: reloadTimeline } = useContactTimeline(id);
  const channelLinks = useContactChannelLinks(id);
  const { operators } = useOperators();
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showPipelineModal, setShowPipelineModal] = useState(false);
  const [tab, setTab] = useState<ProfileTab>('geral');
  const [resumo, setResumo] = useState<{ visitas: number; conversas: number } | null>(null);
  const { tasks } = useTasks();

  // Resumo rápido — contagens reais (negócios/valor já vêm de `deals`).
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void (async () => {
      const supabase = getSupabase();
      const [visitsRes, convsRes] = await Promise.all([
        supabase.from('park_visits').select('id', { count: 'exact', head: true }).eq('contact_id', id),
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('contact_id', id),
      ]);
      if (!alive) return;
      setResumo({ visitas: visitsRes.count ?? 0, conversas: convsRes.count ?? 0 });
    })();
    return () => { alive = false; };
  }, [id]);

  const tarefasDoContato = tasks.filter((t) => t.contact_id === id);
  const tarefasAbertas = tarefasDoContato.filter((t) => t.status === 'pending').length;
  const negociosAbertos = deals.filter((d) => d.status === 'open');
  const valorPipeline = negociosAbertos.reduce((s, d) => s + (Number(d.value) || 0), 0);

  const authorName = (uid: string | null | undefined) =>
    uid ? operators.find((o) => o.user_id === uid)?.email ?? 'Operador' : 'Sistema';

  if (loading && !contact) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error && !contact)
    return (
      <div className="max-w-3xl">
        <LoadErrorBanner message={error} onRetry={() => void reload()} />
      </div>
    );
  if (!contact) return <div className="text-[var(--color-text-secondary)]">Contato não encontrado.</div>;

  const company = typeof contact.custom_fields?.company === 'string' ? String(contact.custom_fields.company) : '';

  const saveField = async (patch: Parameters<typeof saveContact>[0]) => {
    const err = await saveContact(patch);
    if (err) toast.error(err);
    else toast.success('Salvo.');
  };

  const saveCompany = async (value: string) => {
    const err = await saveContact({ custom_fields: { ...(contact.custom_fields ?? {}), company: value || undefined } });
    if (err) toast.error(err);
    else toast.success('Salvo.');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]">
        <ArrowLeft className="h-4 w-4" /> Contatos
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl glass-card text-xl font-bold text-[var(--accent-primary)]">
            {(contact.name ?? contact.phone ?? '?').charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-display">{contact.name ?? 'Sem nome'}</h1>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--color-text-secondary)]">
              {contact.source && (
                <span className="rounded-full bg-[var(--color-fill-subtle)] px-2 py-0.5">
                  {CONTACT_SOURCE_LABEL[contact.source] ?? contact.source}
                </span>
              )}
              <span>Primeiro registro: {new Date(contact.first_seen_at ?? contact.created_at).toLocaleDateString('pt-BR')}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowPipelineModal(true)}>
            <Filter className="h-4 w-4" /> Adicionar no pipeline
          </Button>
          <Button variant="outline" onClick={() => setShowLinkModal(true)}>
            <Link2 className="h-4 w-4" /> Vincular canal
          </Button>
          <Button onClick={() => navigate(`/inbox?contact=${contact.id}`)}>
            <MessageSquare className="h-4 w-4" /> Abrir conversa
          </Button>
        </div>
      </div>

      {/* Resumo rápido — só dado real */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <ResumoCard icon={Briefcase} label="Negócios" value={String(deals.length)} />
        <ResumoCard icon={Briefcase} label="Valor em pipeline" value={brl(valorPipeline)} />
        <ResumoCard icon={CalendarDays} label="Visitas" value={resumo === null ? '…' : String(resumo.visitas)} />
        <ResumoCard icon={MessageSquare} label="Conversas" value={resumo === null ? '…' : String(resumo.conversas)} />
        <ResumoCard icon={CheckSquare} label="Tarefas abertas" value={String(tarefasAbertas)} />
      </div>

      {/* Abas do Perfil 360 */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-[var(--color-border-card)] p-1 bg-[var(--color-fill-subtle)] w-fit max-w-full">
        {([
          ['geral', 'Visão geral', User],
          ['conversas', 'Conversas', MessageSquare],
          ['negocios', 'Negócios', Briefcase],
          ['visitas', 'Visitas', CalendarDays],
          ['tarefas', 'Tarefas', ListTodo],
          ['campanhas', 'Campanhas', Megaphone],
          ['arquivos', 'Arquivos', FolderOpen],
          ['atividades', 'Atividades', Clock],
        ] as [ProfileTab, string, typeof User][]).map(([id_, label, Icon]) => (
          <button
            key={id_}
            onClick={() => setTab(id_)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              tab === id_ ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Principal: conteúdo da aba selecionada */}
        <div className="space-y-5 min-w-0">
          {tab === 'geral' && (
            <>
              <div className="glass-card p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InlineField label="Nome" value={contact.name ?? ''} onSave={(v) => saveField({ name: v || null })} />
                <InlineField label="Telefone" value={contact.phone ?? ''} onSave={(v) => saveField({ phone: v || null })} />
                <InlineField label="E-mail" value={contact.email ?? ''} onSave={(v) => saveField({ email: v || null })} />
                <InlineField label="Empresa" value={company} onSave={saveCompany} />
                <div>
                  <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Canal / Origem</div>
                  <select value={contact.source ?? ''} onChange={(e) => saveField({ source: e.target.value || null })} className={inputCls}>
                    <option value="">—</option>
                    {Object.entries(CONTACT_SOURCE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Negócio ativo — card resumido; sem negócio, chama pra criar */}
              {negociosAbertos.length > 0 ? (
                <div className="glass-card p-5 space-y-2">
                  <div className="text-label">Negócio ativo</div>
                  {negociosAbertos.map((d) => <DealRow key={d.id} deal={d} />)}
                </div>
              ) : (
                <div className="glass-card p-5 flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--color-text-secondary)]">Nenhum negócio ativo.</span>
                  <Button size="sm" variant="outline" onClick={() => setShowPipelineModal(true)}>
                    <Plus className="h-3.5 w-3.5" /> Criar negócio
                  </Button>
                </div>
              )}
            </>
          )}

          {tab === 'conversas' && <ConversasTab contactId={id} />}
          {tab === 'negocios' && <NegociosTab deals={deals} />}
          {tab === 'visitas' && <VisitasTab contactId={id} />}
          {tab === 'tarefas' && <TarefasTab contactId={id} tasks={tarefasDoContato} />}
          {tab === 'campanhas' && <CampanhasTab contactId={id} />}
          {tab === 'arquivos' && (
            <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">
              Nenhum arquivo anexado. O CRM ainda não tem armazenamento de arquivos por contato —
              recurso pendente, não implementado nesta etapa.
            </div>
          )}
          {tab === 'atividades' && (
            <TimelineGrouped groups={groups} onAddNote={async (d, t) => { await addNoteToDay(d, t); }} authorName={authorName} />
          )}
        </div>

        {/* Lateral: negócios + vínculos */}
        <div className="space-y-5">
          <SidePanel title="Negócios" empty="Nenhum negócio.">
            {deals.map((d) => (
              <DealRow key={d.id} deal={d} />
            ))}
          </SidePanel>

          <div className="glass-card p-5">
            <ProximaAcao contactId={id} deals={deals.map((d) => ({ id: d.id, title: d.title }))} />
          </div>

          <div className="glass-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-label">Canais vinculados</div>
              <button onClick={() => setShowLinkModal(true)} className="text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]" aria-label="Vincular canal">
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {channelLinks.links.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] opacity-70">Nenhum canal vinculado.</p>
            ) : (
              <div className="space-y-2">
                {channelLinks.links.map((l) => (
                  <ChannelLinkRow key={l.id} link={l} onUnlink={() => void channelLinks.unlink(l.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showPipelineModal && (
        <AddToPipelineModal
          contactId={contact.id}
          contactName={contact.name}
          onClose={() => setShowPipelineModal(false)}
          onCreated={() => { void reload(); void reloadTimeline(); }}
        />
      )}

      {showLinkModal && (
        <LinkChannelModal
          onClose={() => setShowLinkModal(false)}
          onLink={async (channel, identifier) => {
            try {
              await channelLinks.link(channel, identifier);
              toast.success('Canal vinculado.');
              setShowLinkModal(false);
              void reloadTimeline();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Falha ao vincular.');
            }
          }}
        />
      )}
    </div>
  );
}

function InlineField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void | Promise<void> }) {
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setLocal(value), [value]);
  const commit = () => { if (local !== value) void onSave(local); };
  return (
    <div>
      <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">{label}</div>
      <input
        ref={ref}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); ref.current?.blur(); } if (e.key === 'Escape') setLocal(value); }}
        placeholder="—"
        className={inputCls}
      />
    </div>
  );
}

function TimelineGrouped({
  groups,
  onAddNote,
  authorName,
}: {
  groups: DayGroup[];
  onAddNote: (date: string, text: string) => Promise<void>;
  authorName: (uid: string | null | undefined) => string;
}) {
  const [openNoteFor, setOpenNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (date: string) => {
    if (!noteText.trim()) return;
    setBusy(true);
    await onAddNote(date, noteText);
    setNoteText('');
    setOpenNoteFor(null);
    setBusy(false);
  };

  // Sempre permite anotar no dia de hoje, mesmo sem outra atividade.
  const days = groups.some((g) => g.date === todayISO())
    ? groups
    : [{ date: todayISO(), entries: [] }, ...groups];

  return (
    <div>
      <div className="text-label mb-3">Linha do tempo</div>
      {days.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Sem histórico ainda.</div>
      ) : (
        <ol className="space-y-4">
          {days.map((g) => (
            <li key={g.date} className="glass-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">{fmtDay(g.date)}</span>
                <button
                  onClick={() => { setOpenNoteFor(openNoteFor === g.date ? null : g.date); setNoteText(''); }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]"
                >
                  <Plus className="h-3 w-3" /> Nota
                </button>
              </div>

              {openNoteFor === g.date && (
                <div className="mb-3 flex gap-2">
                  <input
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit(g.date)}
                    placeholder="Adicionar nota a esta data…"
                    className={inputCls}
                    autoFocus
                  />
                  <Button onClick={() => void submit(g.date)} disabled={busy || !noteText.trim()}>Anotar</Button>
                </div>
              )}

              {g.entries.length === 0 ? (
                <p className="text-xs text-[var(--color-text-secondary)] opacity-60">Sem atividade — use "Nota" para registrar algo.</p>
              ) : (
                <ul className="space-y-2">
                  {g.entries.map((e) => (
                    <li key={e.id} className="flex gap-3">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[e.kind] ?? 'bg-[#64748B]'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{e.label}</span>
                          <span className="text-[11px] text-[var(--color-text-secondary)]">
                            {fmtTime(e.at)}{e.kind === 'nota' && ` · ${authorName(e.author_id)}`}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">{e.text}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ChannelLinkRow({ link, onUnlink }: { link: ContactChannelLink; onUnlink: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          {link.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}
        </div>
        <div className="truncate text-sm text-[var(--color-text-primary)]">{link.channel_identifier}</div>
      </div>
      <button onClick={onUnlink} className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]" aria-label="Desvincular">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function LinkChannelModal({
  onClose,
  onLink,
}: {
  onClose: () => void;
  onLink: (channel: 'whatsapp' | 'instagram', identifier: string) => Promise<void>;
}) {
  const [channel, setChannel] = useState<'whatsapp' | 'instagram'>('instagram');
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-5 shadow-[var(--shadow-lg)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-display">Vincular canal</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><X className="h-5 w-5" /></button>
        </div>
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          Associe um Instagram (@usuário/ID) ou WhatsApp (E.164) a este contato para unificar as conversas dos dois canais.
        </p>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">Canal</div>
            <select value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp' | 'instagram')} className={inputCls}>
              <option value="instagram">Instagram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
          <div>
            <div className="mb-1 text-[0.65rem] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
              {channel === 'instagram' ? '@usuário ou ID' : 'Número (E.164)'}
            </div>
            <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={channel === 'instagram' ? '@fulano' : '+5511999999999'} className={inputCls} autoFocus />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button
            className="flex-1"
            disabled={busy || !identifier.trim()}
            onClick={async () => { setBusy(true); await onLink(channel, identifier); setBusy(false); }}
          >
            Vincular
          </Button>
          <button onClick={onClose} className="rounded-lg border border-[var(--color-border-card)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function SidePanel({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  const hasContent = items.some(Boolean) && items.flat().length > 0;
  return (
    <div className="glass-card p-5">
      <div className="text-label mb-3">{title}</div>
      {hasContent ? <div className="space-y-2">{children}</div> : <p className="text-sm text-[var(--color-text-secondary)] opacity-70">{empty}</p>}
    </div>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  const origin = getDealOrigin(deal);
  return (
    <Link to={`/funil?deal=${deal.id}`} className="block rounded-lg border border-[var(--color-border-card)] px-3 py-2 hover:border-[var(--accent-primary)]">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--color-text-primary)]">{deal.title}</span>
        <span className="text-xs font-semibold text-[var(--accent-secondary)]">{brl(Number(deal.value) || 0)}</span>
      </div>
      {origin && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-semibold ${TRAFFIC_TYPE_STYLE[origin.traffic ?? ''] ?? ''}`}>
            {origin.highlight}
          </span>
          {(origin.channel || origin.campaign) && (
            <span className="flex min-w-0 items-center gap-1 text-[var(--color-text-secondary)]">
              <MapPin className="h-3 w-3 shrink-0 opacity-70" />
              <span className="truncate">{[origin.channel, origin.campaign].filter(Boolean).join(' · ')}</span>
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Resumo rápido — card compacto, só dado real (sem estimativa/score).
// ---------------------------------------------------------------------------
function ResumoCard({ icon: Icon, label, value }: { icon: typeof Briefcase; label: string; value: string }) {
  return (
    <div className="glass-card p-3">
      <Icon className="h-4 w-4 text-[var(--accent-primary)] mb-1" />
      <div className="text-base font-bold text-[var(--color-text-primary)]">{value}</div>
      <div className="text-xs text-[var(--color-text-secondary)]">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba Conversas — histórico real de conversations do contato.
// ---------------------------------------------------------------------------
interface ConversaRow {
  id: string;
  channel: string;
  status: string;
  last_message_at: string | null;
  created_at: string;
}

function ConversasTab({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<ConversaRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void getSupabase()
      .from('conversations')
      .select('id, channel, status, last_message_at, created_at')
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false })
      .then(({ data }) => { if (alive) setRows((data ?? []) as ConversaRow[]); });
    return () => { alive = false; };
  }, [contactId]);

  if (rows === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (rows.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhuma conversa ainda.</div>;

  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <Link
          key={c.id}
          to={`/inbox?conversation=${c.id}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-card)] px-4 py-2.5 hover:border-[var(--accent-primary)] transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--color-fill-subtle)] px-2 py-0.5 text-xs capitalize text-[var(--color-text-secondary)]">{c.channel}</span>
            <span className="text-xs text-[var(--color-text-secondary)]">{c.status}</span>
          </div>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {c.last_message_at ? new Date(c.last_message_at).toLocaleString('pt-BR') : new Date(c.created_at).toLocaleDateString('pt-BR')}
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba Negócios — todos os deals do contato (ativos/ganhos/perdidos/arquivados).
// ---------------------------------------------------------------------------
function NegociosTab({ deals }: { deals: Deal[] }) {
  if (deals.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhum negócio ainda.</div>;
  return (
    <div className="space-y-2">
      {deals.map((d) => (
        <Link
          key={d.id}
          to={`/funil?deal=${d.id}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-card)] px-4 py-2.5 hover:border-[var(--accent-primary)] transition-colors"
        >
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text-primary)] truncate">{d.title}</div>
            <div className="text-xs text-[var(--color-text-secondary)] capitalize">{d.status}{d.archived_at ? ' · arquivado' : ''}</div>
          </div>
          <span className="shrink-0 text-sm font-semibold text-[var(--accent-secondary)]">{brl(Number(d.value) || 0)}</span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba Visitas — park_visits do contato.
// ---------------------------------------------------------------------------
interface VisitaRow {
  id: string;
  visit_date: string;
  visit_time: string | null;
  status: string;
  party_size: number;
}

const VISIT_STATUS_LABEL: Record<string, string> = {
  scheduled: 'Agendada', pending: 'Aguardando', confirmed: 'Confirmada',
  completed: 'Realizada', cancelled: 'Cancelada', no_show: 'Não compareceu',
};

function VisitasTab({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<VisitaRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void getSupabase()
      .from('park_visits')
      .select('id, visit_date, visit_time, status, party_size')
      .eq('contact_id', contactId)
      .order('visit_date', { ascending: false })
      .then(({ data }) => { if (alive) setRows((data ?? []) as VisitaRow[]); });
    return () => { alive = false; };
  }, [contactId]);

  if (rows === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (rows.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhuma visita ainda.</div>;

  return (
    <div className="space-y-2">
      {rows.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-card)] px-4 py-2.5">
          <div>
            <div className="text-sm text-[var(--color-text-primary)]">
              {new Date(v.visit_date + 'T12:00:00').toLocaleDateString('pt-BR')} {v.visit_time?.slice(0, 5)}
            </div>
            <div className="text-xs text-[var(--color-text-secondary)]">{v.party_size} pessoa(s)</div>
          </div>
          <span className="text-xs font-semibold text-[var(--accent-secondary)]">{VISIT_STATUS_LABEL[v.status] ?? v.status}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba Tarefas — reaproveita o módulo de Tarefas (Etapa 1), filtrado por contato.
// ---------------------------------------------------------------------------
function TarefasTab({ contactId, tasks }: { contactId: string; tasks: ReturnType<typeof useTasks>['tasks'] }) {
  const { createTask, toggleTask } = useTasks();
  const [novoTitulo, setNovoTitulo] = useState('');
  const [criando, setCriando] = useState(false);

  const criar = async () => {
    if (!novoTitulo.trim()) return;
    setCriando(true);
    try {
      await createTask({ title: novoTitulo.trim(), contact_id: contactId });
      setNovoTitulo('');
    } catch (err) {
      toast.error('Falha ao criar tarefa', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setCriando(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={novoTitulo}
          onChange={(e) => setNovoTitulo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
          placeholder="Nova tarefa para este contato..."
          className={inputCls}
        />
        <Button onClick={() => void criar()} disabled={criando || !novoTitulo.trim()}>Criar</Button>
      </div>
      {tasks.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhuma tarefa para este contato.</div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border-card)] px-4 py-2.5">
              <button
                onClick={() => void toggleTask(t)}
                className={`h-4 w-4 rounded border ${t.status === 'done' ? 'bg-[var(--color-success)] border-[var(--color-success)]' : 'border-[var(--accent-primary)]'}`}
              />
              <span className={`flex-1 text-sm text-[var(--color-text-primary)] ${t.status === 'done' ? 'line-through opacity-60' : ''}`}>{t.title}</span>
              {t.due_at && <span className="text-xs text-[var(--color-text-secondary)]">{new Date(t.due_at).toLocaleDateString('pt-BR')}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba Campanhas — campaign_contacts do contato, com status real de envio.
// ---------------------------------------------------------------------------
interface CampanhaRow {
  id: string;
  status: string;
  sent_at: string | null;
  campaign: { name: string } | null;
}

function CampanhasTab({ contactId }: { contactId: string }) {
  const [rows, setRows] = useState<CampanhaRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void getSupabase()
      .from('campaign_contacts')
      .select('id, status, sent_at, campaign:campaign_id(name)')
      .eq('contact_id', contactId)
      .order('sent_at', { ascending: false })
      .then(({ data }) => { if (alive) setRows((data ?? []) as unknown as CampanhaRow[]); });
    return () => { alive = false; };
  }, [contactId]);

  if (rows === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (rows.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhuma campanha recebida.</div>;

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-card)] px-4 py-2.5">
          <span className="text-sm text-[var(--color-text-primary)] truncate">{r.campaign?.name ?? 'Campanha'}</span>
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="capitalize">{r.status}</span>
            {r.sent_at && <span>{new Date(r.sent_at).toLocaleDateString('pt-BR')}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
