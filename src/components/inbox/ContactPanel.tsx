import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Bot, Briefcase, CalendarPlus, CheckSquare, CircleX, Clock, Compass, Filter, Pause, Pin, Play, Mail, Phone, RotateCcw, ShoppingBag, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/Avatar';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { ConversationWithContact } from '@/types/inbox';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import type { Queue } from '@/hooks/useQueues';
import { useTasks } from '@/hooks/useTasks';
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
}

export function ContactPanel({
  conversation, withinWindow, operators, queues = [], aiEnabled = true, assignedName = null, provider = 'meta',
  onPauseAI, onResumeAI, onClose, onReopen, onAssign, onSetQueue, onSetActiveDeal, onPinNote, onArchive, onContactRefresh,
}: ContactPanelProps) {
  const { userId } = useAppUser();
  const { createTask } = useTasks();
  const [novaTarefaOpen, setNovaTarefaOpen] = useState(false);
  const [novaTarefaTexto, setNovaTarefaTexto] = useState('');
  const [criandoTarefa, setCriandoTarefa] = useState(false);

  const criarTarefaRapida = async () => {
    if (!novaTarefaTexto.trim()) return;
    setCriandoTarefa(true);
    try {
      await createTask({ title: novaTarefaTexto.trim(), contact_id: contact?.id ?? null, conversation_id: conversation.id });
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

  // Deal alvo dos botões Ganho/Perdido: o negócio ativo da conversa (se ainda
  // aberto), senão o negócio aberto mais recente do contato.
  const activeDeal = openDeals.find((d) => d.id === conversation.active_deal_id);
  const targetDeal = activeDeal?.status === 'open' ? activeDeal : openDeals.find((d) => d.status === 'open');

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

  return (
    <div className="h-full p-5 space-y-5 overflow-y-auto">
      <div className="text-center">
        <Avatar
          src={contact?.profile_pic_url}
          name={displayName}
          size="lg"
          className="mx-auto shadow-[0_0_30px_rgba(14,154,160,0.25)]"
        />
        <div className="mt-3 text-lg font-bold text-display text-[var(--color-text-primary)]">
          {displayName}
        </div>
        {contact?.phone && (
          <div className="text-xs font-mono text-[var(--color-text-secondary)] mt-0.5">
            {contact.phone}
          </div>
        )}
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {/* Atendente: Fechada > nome do operador atribuído > IA ativa (canal
              com IA ligada e sem pausa) > IA pausada > Humano (IA do canal
              desligada nas configurações). */}
          {isClosed ? (
            <Badge tone="default"><CircleX className="h-3 w-3" /> Fechada</Badge>
          ) : assignedName ? (
            <Badge tone="success"><User className="h-3 w-3" /> {assignedName}</Badge>
          ) : !aiEnabled ? (
            <Badge tone="success"><User className="h-3 w-3" /> Humano</Badge>
          ) : conversation.ai_paused ? (
            <Badge tone="warning"><Bot className="h-3 w-3" /> IA pausada</Badge>
          ) : (
            <Badge tone="success"><Bot className="h-3 w-3" /> IA ativa</Badge>
          )}
          <Badge tone={isCliente ? 'success' : 'default'}>
            <User className="h-3 w-3" />
            {isCliente ? 'Cliente' : 'Lead'}
          </Badge>
          {provider === 'uazapi' ? (
            <Badge tone="success">
              <Clock className="h-3 w-3" /> Sem janela (UAZAPI)
            </Badge>
          ) : (
            <Badge tone={withinWindow ? 'success' : 'warning'}>
              <Clock className="h-3 w-3" />
              {withinWindow ? 'Janela 24h aberta' : 'Janela 24h fechada'}
            </Badge>
          )}
        </div>
      </div>

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
              className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-primary)] bg-[rgba(14,154,160,0.12)] px-2 py-1 text-[11px] font-semibold text-[var(--accent-primary)] hover:bg-[rgba(14,154,160,0.2)] transition-colors"
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
          className="h-11 w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
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
            className="h-11 w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
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
            className="h-11 w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)]"
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
                className="h-11 w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
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

      {/* Tags rápidas */}
      {contact?.id && <ContactTagsEditor contactId={contact.id} />}

      <div className="space-y-2">
        <div className="text-label">Contato</div>
        <div className="space-y-2 text-sm">
          {contact?.email ? (
            <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
              <Mail className="h-3.5 w-3.5" />
              <span className="truncate">{contact.email}</span>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
            <Phone className="h-3.5 w-3.5" />
            <span className="font-mono">{contact?.phone ?? '—'}</span>
          </div>
          {contact?.source && (
            <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
              <Compass className="h-3.5 w-3.5" />
              <span className="capitalize">Origem: {contact.source}</span>
            </div>
          )}
        </div>
      </div>

      {/* Histórico rápido — contagens reais, não estimativa */}
      {historico && (
        <div className="space-y-2">
          <div className="text-label">Histórico rápido</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center justify-between rounded-lg border border-[rgba(14,154,160,0.12)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Conversas</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.conversas}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[rgba(14,154,160,0.12)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Visitas</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.visitas}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[rgba(14,154,160,0.12)] px-2.5 py-1.5">
              <span className="text-[var(--color-text-secondary)]">Negócios</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{historico.negocios}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-[rgba(14,154,160,0.12)] px-2.5 py-1.5">
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
        <div className="text-label">Ações</div>
        {contact?.id && (
          <Button variant="outline" className="w-full justify-start" onClick={() => setShowVisitModal(true)}>
            <CalendarPlus className="h-4 w-4" />
            Agendar visita
          </Button>
        )}
        {contact?.id && (
          <Button variant="outline" className="w-full justify-start" onClick={() => setShowPipelineModal(true)}>
            <Filter className="h-4 w-4" />
            Adicionar no pipeline
          </Button>
        )}
        <Button variant="outline" className="w-full justify-start" onClick={() => setNovaTarefaOpen((v) => !v)}>
          <CheckSquare className="h-4 w-4" />
          Criar tarefa
        </Button>
        {novaTarefaOpen && (
          <div className="space-y-1.5 pl-1">
            <input
              autoFocus
              value={novaTarefaTexto}
              onChange={(e) => setNovaTarefaTexto(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void criarTarefaRapida(); }}
              placeholder="O que precisa ser feito?"
              className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <Button size="sm" onClick={() => void criarTarefaRapida()} disabled={criandoTarefa || !novaTarefaTexto.trim()}>
              {criandoTarefa ? 'Criando...' : 'Criar'}
            </Button>
          </div>
        )}
        {isClosed ? (
          <Button variant="outline" className="w-full justify-start" onClick={handleReopen}>
            <RotateCcw className="h-4 w-4" />
            Reabrir conversa
          </Button>
        ) : (
          <>
            {conversation.ai_paused ? (
              <Button variant="outline" className="w-full justify-start" onClick={handleResume}>
                <Play className="h-4 w-4" />
                Retomar IA
              </Button>
            ) : (
              <Button variant="outline" className="w-full justify-start" onClick={handlePause}>
                <Pause className="h-4 w-4" />
                Pausar IA
              </Button>
            )}
            <Button variant="ghost" className="w-full justify-start" onClick={handleClose}>
              <CircleX className="h-4 w-4 text-[var(--color-error)]" />
              Fechar conversa
            </Button>
          </>
        )}
        <Button variant="ghost" className="w-full justify-start" onClick={handleArchive}>
          {conversation.archived ? (
            <>
              <ArchiveRestore className="h-4 w-4" />
              Desarquivar conversa
            </>
          ) : (
            <>
              <Archive className="h-4 w-4" />
              Arquivar conversa
            </>
          )}
        </Button>
      </div>

      {/* Atendimento com IA — status + link pro módulo de configuração */}
      <div className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(14,154,160,0.15)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[var(--accent-primary)]" />
          <div>
            <div className="text-xs font-semibold text-[var(--color-text-primary)]">AMAIA</div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              {isClosed ? 'Conversa fechada' : assignedName ? `Humano assumiu (${assignedName})` : conversation.ai_paused ? 'Pausada' : 'Online'}
            </div>
          </div>
        </div>
        <Link to="/ai-agent" className="text-xs font-semibold text-[var(--accent-primary)] hover:opacity-80">
          Configurar
        </Link>
      </div>

      <div className="pt-3 border-t border-[rgba(14,154,160,0.08)] text-[10px] text-[var(--color-text-secondary)] opacity-70 space-y-0.5">
        <div>Status: {conversation.status}</div>
        <div>IA: {conversation.ai_paused ? 'pausada' : 'ativa'}</div>
        <div>Criada: {new Date(conversation.created_at).toLocaleString('pt-BR')}</div>
      </div>

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
