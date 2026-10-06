import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, ArrowRightLeft, User, BadgeDollarSign, BarChart3, Bot, Briefcase, CalendarDays, CalendarPlus, CheckCircle2, CheckSquare, ChevronDown, CircleX, Clock, Copy, IdCard, Instagram, LayoutGrid, MessageCircle, MoreHorizontal, Pause, PauseCircle, Pin, Play, Plus, RotateCcw, ShoppingBag, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/Avatar';
import { getSupabase } from '@/lib/supabase';
import { formatNextDue, setTaskDone } from '@/lib/tasks';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { ConversationWithContact } from '@/types/inbox';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import type { Queue } from '@/hooks/useQueues';
import { TransferMenu } from './TransferMenu';
import { formatPhoneDisplay } from '@/lib/phone';
import { openNewSale } from '@/hooks/useSales';
import { ContactTagsEditor } from './ContactTagsEditor';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { AddToPipelineModal } from '@/components/funil/AddToPipelineModal';
import { ProximaAcao } from '@/components/crm/ProximaAcao';
import { ScheduleVisitDialog } from './ScheduleVisitDialog';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface OpenDeal {
  id: string;
  title: string;
  value: number | null;
  status: 'open' | 'won' | 'lost';
  pipeline_id: string | null;
  stage_id: string | null;
}

interface ContactPanelProps {
  conversation: ConversationWithContact;
  withinWindow: boolean;
  operators: Operator[];
  // Filas disponíveis (Configurações → Equipe → Filas). Opcional pra não
  // quebrar quem ainda não passa essa prop — sem ela, o seletor não aparece.
  queues?: Queue[];
  // IA habilitada para o canal desta conversa (configurações). false → "Humano".
  aiEnabled?: boolean;
  // Nome do operador atribuído — substitui o rótulo genérico.
  assignedName?: string | null;
  // Provedor da conversa: UAZAPI não tem janela de 24h.
  provider?: 'meta' | 'uazapi' | 'instagram';
  onPauseAI: () => Promise<void>;
  onResumeAI: () => Promise<void>;
  onClose: () => Promise<void>;
  onReopen: () => Promise<void>;
  onAssign: (userId: string | null) => Promise<void>;
  // Move a conversa pra outra fila, ou de volta pra "sem fila" (null) —
  // devolver ao setor depois de atendida, ou rotear manualmente.
  onSetQueue?: (queueId: string | null) => Promise<void>;
  onSetActiveDeal: (dealId: string | null) => Promise<void>;
  onPinNote: (note: string | null) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onContactRefresh?: () => void;
  // Transferir/Concluir no topo do painel (coluna fixa ≥1440px).
  showTopActions?: boolean;
}

export function ContactPanel({
  conversation, withinWindow, operators, queues = [], aiEnabled = true, assignedName = null, provider = 'meta',
  onPauseAI, onResumeAI, onClose, onReopen, onAssign, onSetQueue, onSetActiveDeal, onPinNote, onArchive, onContactRefresh,
  showTopActions = false,
}: ContactPanelProps) {
  const { userId } = useAppUser();
  const [novaTarefaOpen, setNovaTarefaOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tarefas, setTarefas] = useState<TaskLite[]>([]);
  const [tarefasVersion, setTarefasVersion] = useState(0);
  const [contactSince, setContactSince] = useState<string | null>(null);
  const [dealStages, setDealStages] = useState<{ id: string; name: string; color: string | null; is_won: boolean; is_lost: boolean }[]>([]);
  const [movingStage, setMovingStage] = useState(false);
  const [novaTarefaTexto, setNovaTarefaTexto] = useState('');
  const [criandoTarefa, setCriandoTarefa] = useState(false);

  const criarTarefaRapida = async () => {
    if (!novaTarefaTexto.trim()) return;
    setCriandoTarefa(true);
    try {
      const { error: tErr } = await getSupabase().from('tasks').insert({
        title: novaTarefaTexto.trim(),
        contact_id: contact?.id ?? null,
        conversation_id: conversation.id,
        created_by: userId,
        assigned_to: userId,
      });
      if (tErr) throw new Error(tErr.message);
      setTarefasVersion((v) => v + 1);
      toast.success('Tarefa criada.');
      setNovaTarefaTexto('');
      setNovaTarefaOpen(false);
    } catch (err) {
      toast.error('Falha ao criar tarefa', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setCriandoTarefa(false);
    }
  };
  const contact = conversation.contact;
  const displayName = contact?.name?.trim() || contact?.phone || '—';
  const [noteDraft, setNoteDraft] = useState(conversation.pinned_note ?? '');
  const [savingNote, setSavingNote] = useState(false);
  const [showPipelineModal, setShowPipelineModal] = useState(false);
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [openDeals, setOpenDeals] = useState<OpenDeal[]>([]);
  const [isCliente, setIsCliente] = useState(false);
  const [produtos, setProdutos] = useState<{ id: string; name: string }[]>([]);
  const [allDeals, setAllDeals] = useState<{ id: string; title: string }[]>([]);
  // Incrementado após marcar ganho/perdido para refazer as queries de deals.
  const [dealsVersion, setDealsVersion] = useState(0);
  const [lostReasonOpen, setLostReasonOpen] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [historico, setHistorico] = useState<{ conversas: number; visitas: number; negocios: number; campanhas: number } | null>(null);

  // Histórico rápido: contadores reais (Customer 360). Nenhum é derivado de
  // score/estimativa — são contagens diretas.
  useEffect(() => {
    if (!contact?.id) { setHistorico(null); return; }
    let alive = true;
    void (async () => {
      const supabase = getSupabase();
      const [convs, visits, deals, camps] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('contact_id', contact.id),
        supabase.from('park_visits').select('id', { count: 'exact', head: true }).eq('contact_id', contact.id),
        supabase.from('deals').select('id', { count: 'exact', head: true }).eq('contact_id', contact.id),
        supabase.from('campaign_contacts').select('id', { count: 'exact', head: true }).eq('contact_id', contact.id),
      ]);
      if (!alive) return;
      setHistorico({
        conversas: convs.count ?? 0,
        visitas: visits.count ?? 0,
        negocios: deals.count ?? 0,
        campanhas: camps.count ?? 0,
      });
    })();
    return () => { alive = false; };
  }, [contact?.id]);

  // Desde quando o contato existe ("Cliente desde").
  useEffect(() => {
    if (!contact?.id) { setContactSince(null); return; }
    let alive = true;
    void getSupabase().from('contacts').select('created_at').eq('id', contact.id).maybeSingle().then(({ data }) => {
      if (!alive) return;
      const iso = (data as { created_at?: string } | null)?.created_at;
      setContactSince(iso ? new Date(iso).toLocaleDateString('pt-BR') : null);
    });
    return () => { alive = false; };
  }, [contact?.id]);

  // Tarefas pendentes do contato (ou desta conversa).
  useEffect(() => {
    if (!contact?.id) { setTarefas([]); return; }
    let alive = true;
    void getSupabase()
      .from('tasks')
      .select('id, title, due_at, assigned_to')
      .eq('status', 'pending')
      .or(`contact_id.eq.${contact.id},conversation_id.eq.${conversation.id}`)
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(5)
      .then(({ data }) => { if (alive) setTarefas((data ?? []) as TaskLite[]); });
    return () => { alive = false; };
  }, [contact?.id, conversation.id, tarefasVersion]);

  const concluirTarefa = async (id: string) => {
    setTarefas((cur) => cur.filter((t) => t.id !== id));
    try {
      const res = await setTaskDone(id, true);
      toast.success('Tarefa concluída.', res.nextDue ? { description: `Próxima repetição: ${formatNextDue(res.nextDue)}` } : undefined);
      if (res.nextDue) setTarefasVersion((v) => v + 1);
    } catch (e) {
      toast.error('Falha ao concluir tarefa', { description: e instanceof Error ? e.message : String(e) });
      setTarefasVersion((v) => v + 1);
    }
  };

  // Negócios abertos OU ganhos do contato — alimentam o seletor de "Negócio
  // ativo" (cliente que já comprou tem deal 'won', e a próxima ação ancora
  // nele; só 'lost' e arquivados ficam de fora).
  useEffect(() => {
    if (!contact?.id) { setOpenDeals([]); return; }
    let alive = true;
    void getSupabase()
      .from('deals')
      .select('id, title, value, status, pipeline_id, stage_id')
      .eq('contact_id', contact.id)
      .in('status', ['open', 'won'])
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (alive) setOpenDeals((data ?? []) as OpenDeal[]); });
    return () => { alive = false; };
  }, [contact?.id, dealsVersion]);

  // Cliente ou Lead + produtos comprados (união dos deals do contato).
  useEffect(() => {
    if (!contact?.id) { setIsCliente(false); setProdutos([]); return; }
    let alive = true;
    void getSupabase()
      .from('deals')
      .select('id, title, lead_type, deal_products(product:product_id(id, name))')
      .eq('contact_id', contact.id)
      .then(({ data }) => {
        if (!alive) return;
        const rows = (data ?? []) as unknown as Array<{
          id: string;
          title: string;
          lead_type: string | null;
          deal_products: Array<{ product: { id: string; name: string } | null }> | null;
        }>;
        setIsCliente(rows.some((r) => r.lead_type === 'Cliente'));
        setAllDeals(rows.map((r) => ({ id: r.id, title: r.title })));
        const seen = new Map<string, string>();
        for (const r of rows) {
          for (const dp of r.deal_products ?? []) {
            if (dp.product) seen.set(dp.product.id, dp.product.name);
          }
        }
        setProdutos([...seen].map(([id, name]) => ({ id, name })));
      });
    return () => { alive = false; };
  }, [contact?.id, dealsVersion]);

  // Re-sincroniza o rascunho da nota ao TROCAR de conversa (chaveado por id, não
  // por pinned_note — assim um update realtime da MESMA conversa não apaga o que
  // o operador está digitando). Sem isso, a nota de uma conversa vazava para a
  // seguinte e podia ser salva na conversa errada.
  useEffect(() => {
    setNoteDraft(conversation.pinned_note ?? '');
    setLostReasonOpen(false);
    setLostReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const handlePause = async () => {
    try {
      await onPauseAI();
      toast.success('IA pausada — você assumiu esta conversa.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleResume = async () => {
    try {
      await onResumeAI();
      toast.success('IA reativada.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleClose = async () => {
    if (!confirm('Fechar esta conversa?')) return;
    try {
      await onClose();
      toast.success('Conversa fechada.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleReopen = async () => {
    try {
      await onReopen();
      toast.success('Conversa reaberta — você assumiu o atendimento.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleArchive = async () => {
    try {
      await onArchive(!conversation.archived);
      toast.success(conversation.archived ? 'Conversa desarquivada.' : 'Conversa arquivada.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const isClosed = conversation.status === 'closed';

  const handleConclude = async () => {
    try {
      await onClose();
      toast.success('Conversa concluída.');
    } catch (err) {
      toast.error('Falha ao concluir', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const copyPhone = (phone: string) => {
    void navigator.clipboard?.writeText(phone).then(() => toast.success('Telefone copiado.'), () => toast.error('Não foi possível copiar.'));
  };

  // Deal alvo dos botões Ganho/Perdido: o negócio ativo da conversa (se ainda
  // aberto), senão o negócio aberto mais recente do contato.
  const activeDeal = openDeals.find((d) => d.id === conversation.active_deal_id);
  const targetDeal = activeDeal?.status === 'open' ? activeDeal : openDeals.find((d) => d.status === 'open');
  const pipelineDeal = activeDeal ?? targetDeal ?? openDeals[0] ?? null;
  const pipelineDealPipeline = pipelineDeal?.pipeline_id ?? null;

  useEffect(() => {
    if (!pipelineDealPipeline) { setDealStages([]); return; }
    let alive = true;
    void getSupabase()
      .from('stages')
      .select('id, name, color, is_won, is_lost')
      .eq('pipeline_id', pipelineDealPipeline)
      .order('position')
      .then(({ data }) => { if (alive) setDealStages((data ?? []) as typeof dealStages); });
    return () => { alive = false; };
  }, [pipelineDealPipeline]);
  const stageColor = dealStages.find((st) => st.id === pipelineDeal?.stage_id)?.color ?? null;

  // Mesmas regras do arrastar no funil (usePipeline.moveDeal).
  const moveStage = async (deal: OpenDeal, stageId: string) => {
    if (!stageId || stageId === deal.stage_id) return;
    const stage = dealStages.find((st) => st.id === stageId);
    const patch: Record<string, unknown> = { stage_id: stageId };
    if (stage?.is_won) { patch.status = 'won'; patch.temperature = 'Morno'; }
    else if (stage?.is_lost) { patch.status = 'lost'; patch.temperature = 'Frio'; patch.lead_type = 'Lead'; }
    else patch.status = 'open';
    setMovingStage(true);
    try {
      const supabase = getSupabase();
      const { error: err } = await supabase.from('deals').update(patch).eq('id', deal.id);
      if (err) throw new Error(err.message);
      await supabase.from('lead_stage_history').insert({
        deal_id: deal.id,
        from_stage_id: deal.stage_id,
        to_stage_id: stageId,
        moved_by: 'humano',
        actor_id: userId,
      });
      setDealsVersion((v) => v + 1);
      onContactRefresh?.();
      toast.success(`Etapa: ${stage?.name ?? 'atualizada'}`);
    } catch (err) {
      toast.error('Falha ao mudar a etapa', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setMovingStage(false);
    }
  };

  // Mesma semântica do arrastar para a coluna Ganho/Perdido no funil
  // (usePipeline.moveDeal): muda status + temperatura, move para a etapa
  // is_won/is_lost do funil do deal e registra em lead_stage_history. Os
  // timestamps won_at/lost_at são preenchidos por trigger no UPDATE de status.
  const markOutcome = async (outcome: 'won' | 'lost') => {
    if (!targetDeal) return;
    setSavingOutcome(true);
    try {
      const supabase = getSupabase();
      const patch: Record<string, unknown> =
        outcome === 'won'
          ? { status: 'won', temperature: 'Morno' }
          : { status: 'lost', temperature: 'Frio', lead_type: 'Lead', lost_reason: lostReason.trim() || null };
      let toStageId: string | null = null;
      if (targetDeal.pipeline_id) {
        const { data: st } = await supabase
          .from('stages')
          .select('id, is_won, is_lost')
          .eq('pipeline_id', targetDeal.pipeline_id);
        const stage = (st ?? []).find((s: { is_won: boolean; is_lost: boolean }) =>
          outcome === 'won' ? s.is_won : s.is_lost,
        ) as { id: string } | undefined;
        if (stage && stage.id !== targetDeal.stage_id) {
          patch.stage_id = stage.id;
          toStageId = stage.id;
        }
      }
      const { error: err } = await supabase.from('deals').update(patch).eq('id', targetDeal.id);
      if (err) throw new Error(err.message);
      if (toStageId) {
        const { data: u } = await supabase.auth.getUser();
        await supabase.from('lead_stage_history').insert({
          deal_id: targetDeal.id,
          from_stage_id: targetDeal.stage_id,
          to_stage_id: toStageId,
          moved_by: 'humano',
          actor_id: u?.user?.id ?? null,
        });
      }
      // Deal perdido sai do seletor de negócio ativo — limpa a referência.
      if (outcome === 'lost' && conversation.active_deal_id === targetDeal.id) {
        await onSetActiveDeal(null);
      }
      setLostReasonOpen(false);
      setLostReason('');
      setDealsVersion((v) => v + 1);
      onContactRefresh?.();
      toast.success(outcome === 'won' ? 'Negócio marcado como ganho. 🎉' : 'Negócio marcado como perdido.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingOutcome(false);
    }
  };

  const handleSaveNote = async () => {
    setSavingNote(true);
    try {
      await onPinNote(noteDraft);
      toast.success('Nota fixa salva.');
    } catch (err) {
      toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingNote(false);
    }
  };

  const channelIsInstagram = conversation.channel === 'instagram';
  const stageDeal = activeDeal ?? targetDeal ?? openDeals[0] ?? null;

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      {/* Transferir / Concluir */}
      {showTopActions && (
        <div className="flex items-center gap-2">
          <TransferMenu
            operators={operators}
            assignedTo={conversation.assigned_to}
            userId={userId}
            onAssign={onAssign}
            align="left"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 text-[15px] font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <ArrowRightLeft className="h-4.5 w-4.5" /> Transferir
          </TransferMenu>
          <button
            type="button"
            onClick={() => void (isClosed ? handleReopen() : handleConclude())}
            className={isClosed
              ? 'inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 text-[15px] font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
              : 'inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--accent-fill)] px-4 text-[15px] font-semibold text-white hover:bg-[var(--accent-fill-hover)]'}
          >
            {isClosed ? <RotateCcw className="h-4.5 w-4.5" /> : <CheckCircle2 className="h-4.5 w-4.5" />}
            {isClosed ? 'Reabrir' : 'Concluir'}
          </button>
        </div>
      )}

      {/* Dados do contato */}
      <section className="inbox-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="inbox-card-title"><IdCard className="h-4.5 w-4.5 text-[var(--color-text-secondary)]" /> Dados do contato</div>
          {contact?.id && (
            <Link to={`/contacts/${contact.id}`} className="text-sm font-medium text-[var(--accent-primary)] hover:underline">Editar</Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Avatar src={contact?.profile_pic_url} name={displayName} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-lg font-bold text-[var(--color-text-primary)]">{displayName}</div>
            {contact?.phone && (
              <div className="flex items-center gap-1 text-sm text-[var(--color-text-secondary)]">
                <span className="truncate">{formatPhoneDisplay(contact.phone)}</span>
                <button type="button" onClick={() => copyPhone(contact.phone ?? '')} aria-label="Copiar telefone" title="Copiar telefone" className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {contactSince && (
              <div className="text-xs text-[var(--color-text-muted)]">{isCliente ? 'Cliente' : 'Contato'} desde {contactSince}</div>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5 text-sm">
          <dt className="inbox-field-label">Nome</dt>
          <dd className="truncate text-[var(--color-text-primary)]">{contact?.name?.trim() || '—'}</dd>
          <dt className="inbox-field-label">Telefone</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-primary)]">
            <span className="truncate">{contact?.phone ? formatPhoneDisplay(contact.phone) : '—'}</span>
            {contact?.phone && !channelIsInstagram && <MessageCircle className="h-4 w-4 shrink-0 text-[var(--inbox-wa,#25D366)]" />}
          </dd>
          {contact?.email && (
            <>
              <dt className="inbox-field-label">E-mail</dt>
              <dd className="truncate text-[var(--color-text-primary)]">{contact.email}</dd>
            </>
          )}
          <dt className="inbox-field-label">Origem</dt>
          <dd className="flex items-center gap-1.5 text-[var(--color-text-primary)]">
            {channelIsInstagram ? <Instagram className="h-4 w-4 text-[#E1306C]" /> : <MessageCircle className="h-4 w-4 text-[var(--inbox-wa,#25D366)]" />}
            {sourceLabel(contact?.source, channelIsInstagram)}
          </dd>
          <dt className="inbox-field-label self-start pt-1">Etiquetas</dt>
          <dd>{contact?.id ? <ContactTagsEditor contactId={contact.id} variant="inline" /> : '—'}</dd>
        </dl>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {provider === 'uazapi' ? (
            <Badge tone="success"><Clock className="h-3 w-3" /> Sem janela (UAZAPI)</Badge>
          ) : (
            <Badge tone={withinWindow ? 'success' : 'warning'}><Clock className="h-3 w-3" /> {withinWindow ? 'Janela 24h aberta' : 'Janela 24h fechada'}</Badge>
          )}
        </div>
      </section>

      {/* Pipeline / Etapa */}
      <section className="inbox-card space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="inbox-card-title"><BarChart3 className="h-4.5 w-4.5 text-[var(--color-text-secondary)]" /> Pipeline / Etapa</div>
          {contact?.id && (
            <button type="button" onClick={() => setShowPipelineModal(true)} className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label="Novo negócio no pipeline" title="Novo negócio no pipeline">
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        {stageDeal ? (
          <>
            {openDeals.length > 1 && <div className="truncate text-xs text-[var(--color-text-muted)]">{stageDeal.title}</div>}
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full" style={{ background: stageColor ?? 'var(--accent-fill)' }} />
              <select
                value={stageDeal.stage_id ?? ''}
                onChange={(e) => void moveStage(stageDeal, e.target.value)}
                disabled={movingStage}
                className="h-11 w-full appearance-none rounded-xl border border-[var(--color-border-card)] bg-[var(--color-surface)] pl-9 pr-9 text-[15px] text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
              >
                {!stageDeal.stage_id && <option value="">Sem etapa</option>}
                {dealStages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
            </div>
          </>
        ) : (
          <button type="button" onClick={() => setShowPipelineModal(true)} disabled={!contact?.id} className="w-full rounded-xl border border-dashed border-[var(--color-border-card)] py-2.5 text-sm font-medium text-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)]">
            + Adicionar no pipeline
          </button>
        )}
      </section>

      {/* Tarefas */}
      <section className="inbox-card space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="inbox-card-title"><CalendarDays className="h-4.5 w-4.5 text-[var(--color-text-secondary)]" /> Tarefas</div>
          <button type="button" onClick={() => setNovaTarefaOpen((v) => !v)} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--accent-primary)] hover:underline">
            <Plus className="h-4 w-4" /> Criar tarefa
          </button>
        </div>
        {novaTarefaOpen && (
          <div className="flex gap-2">
            <input
              autoFocus
              value={novaTarefaTexto}
              onChange={(e) => setNovaTarefaTexto(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void criarTarefaRapida(); }}
              placeholder="O que precisa ser feito?"
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <Button size="sm" className="h-auto" onClick={() => void criarTarefaRapida()} disabled={criandoTarefa || !novaTarefaTexto.trim()}>
              {criandoTarefa ? '…' : 'Criar'}
            </Button>
          </div>
        )}
        {tarefas.length === 0 && !novaTarefaOpen ? (
          <div className="text-sm text-[var(--color-text-muted)]">Nenhuma tarefa pendente.</div>
        ) : (
          <ul className="space-y-1.5">
            {tarefas.map((t) => (
              <li key={t.id} className="flex items-start gap-2.5 rounded-lg border border-[var(--color-border-soft)] px-2.5 py-2">
                <input type="checkbox" checked={false} onChange={() => void concluirTarefa(t.id)} aria-label={`Concluir: ${t.title}`} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[var(--color-text-primary)]">{t.title}</div>
                  {t.due_at && <div className={`text-xs ${new Date(t.due_at) < new Date() ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}>{formatDue(t.due_at)}</div>}
                </div>
                {t.assigned_to && (
                  <Avatar src={operators.find((o) => o.user_id === t.assigned_to)?.avatar_url ?? null} name={operatorLabel(operators.find((o) => o.user_id === t.assigned_to))} size="sm" className="!h-7 !w-7" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* IA AMAIA */}
      <section className="inbox-card">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inbox-card-title whitespace-nowrap"><Zap className="h-4.5 w-4.5 text-[var(--accent-primary)]" /> IA AMAIA</div>
              {!isClosed && aiEnabled && (
                conversation.ai_paused
                  ? <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(245,158,11,0.14)] px-2 py-0.5 text-xs font-semibold text-[var(--inbox-warn-text,#FBBF24)]"><PauseCircle className="h-3.5 w-3.5" /> Pausada</span>
                  : <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-xs font-semibold text-[var(--accent-primary)]"><Bot className="h-3.5 w-3.5" /> Ativa</span>
              )}
            </div>
            <div className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
              {isClosed
                ? 'Conversa concluída'
                : !aiEnabled
                  ? 'Desligada para este canal'
                  : conversation.ai_paused
                    ? `Atendimento humano${assignedName ? ` (${assignedName})` : ''}`
                    : 'Respondendo o cliente'}
            </div>
          </div>
          {!isClosed && aiEnabled && (
            conversation.ai_paused ? (
              <button type="button" onClick={() => void handleResume()} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border-card)] px-3 text-sm font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)]">
                <Play className="h-4 w-4" /> Retomar IA
              </button>
            ) : (
              <button type="button" onClick={() => void handlePause()} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border-card)] px-3 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
                <Pause className="h-4 w-4" /> Pausar IA
              </button>
            )
          )}
        </div>
        <Link to="/ai-agent" className="mt-2 inline-block text-xs font-medium text-[var(--accent-primary)] hover:underline">Configurar AMAIA</Link>
      </section>

      {/* Ações rápidas */}
      <section className="inbox-card space-y-2.5">
        <div className="inbox-card-title"><LayoutGrid className="h-4.5 w-4.5 text-[var(--color-text-secondary)]" /> Ações rápidas</div>
        <div className="grid grid-cols-4 gap-2">
          <QuickAction icon={<BadgeDollarSign className="h-5 w-5" />} label="Nova venda" onClick={() => openNewSale({ contactId: contact?.id, contactName: contact?.name ?? null })} disabled={!contact?.id} />
          <QuickAction icon={<CalendarPlus className="h-5 w-5" />} label="Agendar visita" onClick={() => setShowVisitModal(true)} disabled={!contact?.id} />
          <QuickAction icon={<CheckSquare className="h-5 w-5" />} label="Criar tarefa" onClick={() => setNovaTarefaOpen(true)} />
          <QuickAction icon={<MoreHorizontal className="h-5 w-5" />} label={moreOpen ? 'Menos' : 'Mais ações'} onClick={() => setMoreOpen((v) => !v)} active={moreOpen} />
        </div>
      </section>

      {moreOpen && (
        <section className="inbox-card space-y-5">
      {/* Nota fixa da conversa */}
      <div className="space-y-2">
        <div className="text-label flex items-center gap-1.5"><Pin className="h-3 w-3" /> Nota fixa</div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          rows={2}
          placeholder="Nota visível no topo da conversa…"
          className="w-full rounded-lg border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.04)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[#FBBF24] resize-none"
        />
        {noteDraft !== (conversation.pinned_note ?? '') && (
          <Button size="sm" variant="outline" onClick={handleSaveNote} disabled={savingNote}>
            Salvar nota
          </Button>
        )}
      </div>

      {/* Atribuir a operador */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-label">Atribuído a</div>
          {!isClosed && conversation.assigned_to !== userId && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await onAssign(userId);
                  toast.success('Conversa assumida.');
                } catch (err) {
                  toast.error('Falha ao assumir', { description: err instanceof Error ? err.message : String(err) });
                }
              }}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)] transition-colors"
            >
              <User className="h-3 w-3" /> Assumir
            </button>
          )}
        </div>
        <select
          value={conversation.assigned_to ?? ''}
          onChange={async (e) => {
            try {
              await onAssign(e.target.value || null);
              toast.success('Atribuição atualizada.');
            } catch (err) {
              toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
            }
          }}
          className="h-11 w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)]"
        >
          <option value="">Ninguém</option>
          {operators.map((op) => (
            <option key={op.user_id} value={op.user_id}>
              {operatorLabel(op)} {op.role === 'admin' ? '(admin)' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Fila/setor — devolver pra fila ou rotear manualmente. */}
      {onSetQueue && (
        <div className="space-y-2">
          <div className="text-label">Fila</div>
          <select
            value={conversation.queue_id ?? ''}
            onChange={async (e) => {
              try {
                await onSetQueue(e.target.value || null);
                toast.success('Fila atualizada.');
              } catch (err) {
                toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
              }
            }}
            className="h-11 w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Sem fila</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>{q.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Negócio ativo da conversa (independente do responsável) */}
      <div className="space-y-2">
        <div className="text-label flex items-center gap-1.5"><Briefcase className="h-3 w-3" /> Negócio ativo</div>
        {openDeals.length > 0 ? (
          <select
            value={conversation.active_deal_id ?? ''}
            onChange={async (e) => {
              try {
                await onSetActiveDeal(e.target.value || null);
                toast.success('Negócio ativo atualizado.');
              } catch (err) {
                toast.error('Falha', { description: err instanceof Error ? err.message : String(err) });
              }
            }}
            className="h-11 w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)]"
          >
            <option value="">Nenhum</option>
            {openDeals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} · {brl(Number(d.value) || 0)}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-[var(--color-text-secondary)] opacity-70">
            Nenhum negócio aberto. Use "Adicionar no pipeline" abaixo para criar um.
          </p>
        )}
      </div>

      {/* Ganho / Perdido — mesmo comportamento do card do lead no funil */}
      {targetDeal && (
        <div className="space-y-2">
          <div className="text-label">Status do negócio</div>
          {openDeals.filter((d) => d.status === 'open').length > 1 && (
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70 truncate">
              Aplica-se a: {targetDeal.title}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void markOutcome('won')}
              disabled={savingOutcome}
              className="flex-1 rounded-lg border border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.1)] py-2 text-sm font-semibold text-[#10B981] transition hover:bg-[rgba(16,185,129,0.18)] disabled:opacity-50"
            >
              Ganho
            </button>
            <button
              onClick={() => setLostReasonOpen((v) => !v)}
              disabled={savingOutcome}
              className="flex-1 rounded-lg border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] py-2 text-sm font-semibold text-[#EF4444] transition hover:bg-[rgba(239,68,68,0.16)] disabled:opacity-50"
            >
              Perdido
            </button>
          </div>
          {lostReasonOpen && (
            <div className="space-y-2 rounded-lg border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.05)] p-3">
              <input
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void markOutcome('lost')}
                placeholder="Motivo da perda (opcional)"
                className="h-11 w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                autoFocus
              />
              <button
                onClick={() => void markOutcome('lost')}
                disabled={savingOutcome}
                className="w-full rounded-lg bg-[#EF4444] py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
              >
                Confirmar perda
              </button>
            </div>
          )}
        </div>
      )}

      {/* Produtos comprados — só para Cliente */}
      {isCliente && produtos.length > 0 && (
        <div className="space-y-2">
          <div className="text-label flex items-center gap-1.5"><ShoppingBag className="h-3 w-3" /> Produtos comprados</div>
          <div className="flex flex-wrap gap-1.5">
            {produtos.map((p) => (
              <span
                key={p.id}
                className="rounded-full bg-[rgba(16,185,129,0.12)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-success)]"
              >
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Próxima ação — ancorada no negócio ativo; sem negócio ativo mas com
          deals no contato, cai no escopo por contato (com seletor de negócio
          no formulário). */}
      {conversation.active_deal_id ? (
        <ProximaAcao dealId={conversation.active_deal_id} />
      ) : contact?.id && allDeals.length > 0 ? (
        <ProximaAcao contactId={contact.id} deals={allDeals} />
      ) : (
        <div className="space-y-2">
          <div className="text-label flex items-center gap-1.5"><Clock className="h-3 w-3" /> Próxima ação</div>
          <p className="text-sm text-[var(--color-text-secondary)] opacity-70">
            Crie um negócio para o contato (botão "Adicionar no pipeline") para agendar a próxima ação.
          </p>
        </div>
      )}

      {/* Histórico rápido — contagens reais, não estimativa */}
      {historico && (
        <div className="space-y-2">
          <div className="text-label">Histórico rápido</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Conversas</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.conversas}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Visitas</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.visitas}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Negócios</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.negocios}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-card)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Campanhas</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.campanhas}</span>
            </div>
          </div>
        </div>
      )}

      {/* Campos personalizados (editáveis) */}
      {contact?.id && (
        <CustomFieldsEditor
          contactId={contact.id}
          customFields={contact.custom_fields ?? {}}
          onSaved={onContactRefresh}
        />
      )}

          <div className="space-y-2">
            <div className="text-label">Conversa</div>
            <Button variant="ghost" className="w-full justify-start" onClick={handleArchive}>
              {conversation.archived ? (<><ArchiveRestore className="h-4 w-4" /> Desarquivar conversa</>) : (<><Archive className="h-4 w-4" /> Arquivar conversa</>)}
            </Button>
            {!isClosed && (
              <Button variant="ghost" className="w-full justify-start" onClick={handleClose}>
                <CircleX className="h-4 w-4 text-[var(--color-error)]" /> Fechar conversa
              </Button>
            )}
          </div>
          <div className="border-t border-[var(--color-border-soft)] pt-3 text-[10px] text-[var(--color-text-secondary)] opacity-70 space-y-0.5">
            <div>Status: {conversation.status}</div>
            <div>Criada: {new Date(conversation.created_at).toLocaleString('pt-BR')}</div>
          </div>
        </section>
      )}

      {showPipelineModal && contact?.id && (
        <AddToPipelineModal
          contactId={contact.id}
          contactName={contact.name}
          onClose={() => setShowPipelineModal(false)}
        />
      )}

      {showVisitModal && contact?.id && (
        <ScheduleVisitDialog
          contactId={contact.id}
          contactName={contact.name}
          onClose={() => setShowVisitModal(false)}
        />
      )}
    </div>
  );
}

interface TaskLite {
  id: string;
  title: string;
  due_at: string | null;
  assigned_to: string | null;
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Hoje, ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Amanhã, ${hm}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hm}`;
}

function QuickAction({ icon, label, onClick, disabled, active }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2.5 text-[11.5px] font-medium leading-tight transition-colors disabled:opacity-40 ${active ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-soft)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'}`}
    >
      <span className={active ? '' : 'text-[var(--color-text-secondary)]'}>{icon}</span>
      <span className="text-center">{label}</span>
    </button>
  );
}

function sourceLabel(source: string | null | undefined, isInstagram: boolean): string {
  const s = (source ?? '').toLowerCase();
  if (s === 'whatsapp' || s === 'whatsapp_group') return 'WhatsApp';
  if (s === 'instagram') return 'Instagram';
  if (!s) return isInstagram ? 'Instagram' : 'WhatsApp';
  return source!.charAt(0).toUpperCase() + source!.slice(1);
}
