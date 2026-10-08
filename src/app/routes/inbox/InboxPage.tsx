import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { usePermission } from '@/app/providers/PermissionsProvider';
import './inbox.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRightLeft, CheckCircle2, Copy, CornerUpRight, Info, Instagram, MessageCircle, MoreVertical, PanelRightClose, PanelRightOpen, Pin, Plus, RotateCcw, Share2, Star, UserCheck, X } from 'lucide-react';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { cn } from '@/lib/utils';
import { useAiChannels } from '@/hooks/useAiChannels';
import { useWhatsappProvider } from '@/hooks/useWhatsappProvider';
import { useConversations } from '@/hooks/useConversations';
import type { ConversationWithContact, Message } from '@/types/inbox';
import { useMessages } from '@/hooks/useMessages';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { useQueues } from '@/hooks/useQueues';
import { useTags } from '@/hooks/useTags';
import { ConversationList } from '@/components/inbox/ConversationList';
import { StartWhatsappChat } from '@/components/inbox/StartWhatsappChat';
import { ConversationDealBar } from '@/components/inbox/ConversationDealBar';
import { MessageThread } from '@/components/inbox/MessageThread';
import { MessageInput } from '@/components/inbox/MessageInput';
import { ContactPanel } from '@/components/inbox/ContactPanel';
import { InboxFilters } from '@/components/inbox/InboxFilters';
import { InboxQuickBar, isGroupConversation, matchesBusca, matchesQuickChip, type QuickChip } from '@/components/inbox/InboxQuickBar';
import { GroupsBar } from '@/components/inbox/GroupsBar';
import {
  matchesFilters,
  readFiltersFromParams,
  sortConversations,
  writeFiltersToParams,
  type InboxFilterState,
  type InboxSort,
} from '@/components/inbox/inbox-filters';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { ForwardToChatDialog } from '@/components/chat/ForwardToChatDialog';
import { ContactTagsEditor } from '@/components/inbox/ContactTagsEditor';
import { TransferMenu } from '@/components/inbox/TransferMenu';
import { formatPhoneDisplay } from '@/lib/phone';
import { ForwardMessageDialog } from '@/components/inbox/ForwardMessageDialog';
import { EditMessageDialog } from '@/components/inbox/EditMessageDialog';
import { useSlaConfig } from '@/hooks/useSlaConfig';
import { useNow } from '@/lib/sla';
import { formatPhone } from '@/lib/format';

function copyText(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error('Não foi possível copiar.'),
  );
}

function lastActivityLabel(iso: string | null): string {
  if (!iso) return 'Sem atividade';
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Última atividade hoje às ${hm}`;
  if (d.toDateString() === yest.toDateString()) return `Última atividade ontem às ${hm}`;
  return `Última atividade em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hm}`;
}

function MenuItem({ icon, onClick, children }: { icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
      <span className="text-[var(--color-text-secondary)]">{icon}</span>
      {children}
    </button>
  );
}

const MAX_FORWARD_MSGS = 30;

export default function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showStartChat, setShowStartChat] = useState(false);
  const [busca, setBusca] = useState('');
  const [quickChip, setQuickChip] = useState<QuickChip>('todas');
  const [filters, setFiltersState] = useState<InboxFilterState>(() =>
    readFiltersFromParams(searchParams),
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get('conversation'),
  );
  const [sort, setSort] = useState<InboxSort>('recente');
  // Responder citando / encaminhar (ações do balão).
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Encaminhar: 1 mensagem (atalho do balão) ou várias (modo seleção).
  const [forwardMsgs, setForwardMsgs] = useState<Message[] | null>(null);
  const [selectedMsgs, setSelectedMsgs] = useState<Map<string, Message> | null>(null);
  useEffect(() => { setReplyTo(null); setSelectedMsgs(null); }, [selectedId]);
  const toggleSelectMsg = useCallback((m: Message) => {
    setSelectedMsgs((cur) => {
      const next = new Map(cur ?? []);
      if (next.has(m.id)) next.delete(m.id);
      else if (next.size >= MAX_FORWARD_MSGS) { toast.info(`Até ${MAX_FORWARD_MSGS} mensagens por vez.`); return cur; }
      else next.set(m.id, m);
      return next;
    });
  }, []);
  const selectedMsgIds = useMemo(() => (selectedMsgs ? new Set(selectedMsgs.keys()) : null), [selectedMsgs]);
  // Editar: WhatsApp pelo número UAZAPI, texto da equipe, até 15 min (janela do
  // WhatsApp). O número oficial (Zernio/Meta) não permite editar pela API.
  const [editingMsg, setEditingMsg] = useState<Message | null>(null);
  // SLA: limites da org + relógio de 30s para os contadores de espera.
  const { sla } = useSlaConfig();
  const now = useNow(30_000);
  // No mobile (<lg) mostramos uma coluna por vez: lista quando nada está
  // selecionado, senão a thread. O painel de contato vira um overlay.
  const [showPanelMobile, setShowPanelMobile] = useState(false);
  // "Compartilhar com a equipe": joga a conversa no Chat Interno.
  const [showForward, setShowForward] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [selectedId]);
  // Painel de contato (coluna direita, xl+) recolhível; preferência persiste.
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem('inbox_panel_collapsed') === '1',
  );
  const togglePanel = () =>
    setPanelCollapsed((v) => {
      localStorage.setItem('inbox_panel_collapsed', v ? '0' : '1');
      return !v;
    });
  const { operators } = useOperators();
  const { queues } = useQueues();
  const { tags } = useTags();
  const { userId, role } = useAppUser();
  const perms = usePermission();
  const { aiEnabledForChannel } = useAiChannels();
  const { providerOf } = useWhatsappProvider();

  // Nome exibível do operador atribuído: display_name do perfil, senão a parte
  // local do e-mail (via list_operators).
  const operatorName = useCallback(
    (uid: string | null) => {
      if (!uid) return null;
      const op = operators.find((o) => o.user_id === uid);
      return op ? operatorLabel(op) : null;
    },
    [operators],
  );

  // Escopo do perfil (Configurações → Usuários e acessos): "só próprias"
  // bloqueia conversa atribuída a outra pessoa; "equipe" libera as da equipe;
  // "todas" libera tudo. Sem atribuição, todo mundo vê.
  const isLocked = useCallback(
    (c: ConversationWithContact) => !perms.inScope('inbox', c.assigned_to),
    [perms],
  );

  // Persiste os filtros na querystring (namespace f*), preservando ?conversation.
  const updateFilters = (next: InboxFilterState) => {
    setFiltersState(next);
    setSearchParams((prev) => writeFiltersToParams(prev, next), { replace: true });
  };

  // Sync selectedId ↔ URL query. Notifications deep-link into the inbox with
  // ?conversation=<uuid> — we pick it up here and also update the URL when
  // the operator switches rows so sharing / bookmarks work.
  useEffect(() => {
    const fromUrl = searchParams.get('conversation');
    if (fromUrl && fromUrl !== selectedId) {
      setSelectedId(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (selectedId && searchParams.get('conversation') !== selectedId) {
      // Merge — não sobrescreve os params de filtro.
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set('conversation', selectedId);
          return p;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const {
    conversations,
    loading: loadingConvs,
    error: convError,
    reload: reloadConvs,
    setStatus,
    setAiPaused,
    setAssigned,
    setActiveDeal,
    setPinnedNote,
    setArchived,
    setFavorite,
    markRead,
    setQueue,
  } = useConversations();

  // Base = filtros avançados aplicados. Os contadores dos chips saem daqui,
  // para o número bater com o que o clique realmente mostra.
  const baseConversations = useMemo(() => {
    const now = Date.now();
    return conversations.filter((c) => matchesFilters(c, filters, now));
  }, [conversations, filters]);

  const visibleConversations = useMemo(() => {
    const filtered = baseConversations.filter(
      (c) => matchesQuickChip(c, quickChip, sla.late) && matchesBusca(c, busca),
    );
    return sortConversations(filtered, sort);
    // `now` entra para a aba "Atrasadas" acompanhar o relógio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConversations, quickChip, busca, sort, sla.late, now]);

  const { messages, loading: loadingMsgs, sendText, retry, dismissFailed } = useMessages(selectedId);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const selectedIsGroup = selected ? isGroupConversation(selected) : false;

  // Se a conversa aberta for (re)atribuída a outro operador (deep-link ou
  // realtime), fecha imediatamente para quem não pode vê-la.
  useEffect(() => {
    if (selected && isLocked(selected)) setSelectedId(null);
  }, [selected, isLocked]);

  // Janela de 24h: aberta se a última mensagem do CONTATO foi há menos de 24h.
  // Fora dela, a Meta só permite reiniciar com template (WhatsApp) — Instagram
  // não tem template, mas permite responder por atendimento humano até 7 dias
  // (tag HUMAN_AGENT, aplicada automaticamente no backend só pra sends de
  // operador — nunca da IA). Ver send-operator-message/index.ts.
  const hoursSinceLastInbound = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === 'inbound') {
        return (Date.now() - new Date(messages[i].created_at).getTime()) / (60 * 60 * 1000);
      }
    }
    return Infinity;
  }, [messages]);
  const withinWindow = hoursSinceLastInbound < 24;

  // UAZAPI (não oficial) não tem janela de 24h — envio liberado sempre. A
  // trava só vale para a API oficial da Meta (WhatsApp Meta e Instagram).
  const selectedProvider = selected ? providerOf(selected) : 'meta';
  const effectiveWithinWindow = selectedProvider === 'uazapi' ? true : withinWindow;

  // Instagram: 24h-7dias ainda permite texto livre (atendimento humano) —
  // só bloqueia de verdade acima de 7 dias, ou no WhatsApp fora de 24h (só
  // template ali). Sem isso, o composer escondia o campo de texto no
  // Instagram e empurrava pro fluxo de template, que não existe lá.
  const selectedChannel = selected?.channel === 'instagram' ? 'instagram' : 'whatsapp';
  const instagramHumanAgentWindow =
    selectedChannel === 'instagram' && hoursSinceLastInbound >= 24 && hoursSinceLastInbound <= 24 * 7;
  const requiresTemplateRestart =
    selectedProvider !== 'uazapi' && !effectiveWithinWindow && !instagramHumanAgentWindow;

  // Deep-link vindo do drawer do card do funil: ?contact=<uuid> seleciona a
  // conversa daquele contato assim que a lista carrega.
  useEffect(() => {
    const contactId = searchParams.get('contact');
    if (!contactId) return;
    const conv = conversations.find((c) => c.contact?.id === contactId);
    if (conv) setSelectedId(conv.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  // Auto-select the first conversation only on desktop (lg+). No mobile,
  // auto-selecionar esconderia a lista e jogaria o usuário direto na thread.
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) {
      return;
    }
    if (searchParams.get('contact')) return; // deixa o deep-link por contato decidir
    const firstOpen = visibleConversations.find((c) => !isLocked(c));
    if (!selectedId && firstOpen) {
      setSelectedId(firstOpen.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleConversations, selectedId]);

  const toggleClosed = async () => {
    if (!selected) return;
    const closing = selected.status !== 'closed';
    try {
      await setStatus(selected.id, closing ? 'closed' : 'human_active');
      toast.success(closing ? 'Conversa concluída.' : 'Conversa reaberta.');
    } catch (err) {
      toast.error(closing ? 'Falha ao concluir' : 'Falha ao reabrir', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  // Clear unread count when a conversation is open AND visible.
  useEffect(() => {
    if (selected && selected.unread_count > 0) {
      void markRead(selected.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.unread_count]);

  return (
    <div className="inbox-workspace h-full flex flex-col min-h-0">
      {showStartChat && (
        <StartWhatsappChat
          onClose={() => setShowStartChat(false)}
          onOpenConversation={(id) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set('conversation', id);
              return next;
            });
          }}
        />
      )}

      {convError && (
        <div className="mb-3">
          <LoadErrorBanner message={convError} onRetry={() => void reloadConvs()} />
        </div>
      )}

      <div
        className={`inbox-panels flex-1 min-h-0 ${
          panelCollapsed ? 'inbox-details-collapsed' : ''
        }`}
      >
        {/* Left: conversation list — no mobile some quando há conversa aberta */}
        <div
          className={`inbox-column p-0 flex-col overflow-hidden h-full min-w-0 ${
            selectedId ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <div className="inbox-list-header flex items-center justify-between gap-3">
            <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">Conversas</h2>
            <button
              type="button"
              onClick={() => setShowStartChat(true)}
              aria-label="Iniciar conversa"
              title="Iniciar conversa"
              className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-fill)] text-white shadow-[var(--shadow-sm)] transition-colors hover:bg-[var(--accent-fill-hover)]"
            >
              <Plus className="h-6 w-6" />
            </button>
          </div>
          <div className="inbox-list-tools space-y-2.5">
            {/* Abas com contador + busca; filtros avançados/ordenação no ícone. */}
            <InboxQuickBar
              busca={busca}
              onBuscaChange={setBusca}
              chip={quickChip}
              onChipChange={setQuickChip}
              base={baseConversations}
              filters={filters}
              slaLateMinutes={sla.late}
              now={now}
              trailing={
                <InboxFilters
                  compact
                  filters={filters}
                  onChange={updateFilters}
                  sort={sort}
                  onSortChange={setSort}
                  operators={operators}
                  tags={tags}
                  queues={queues}
                />
              }
            />
            {quickChip === 'grupos' && (
              <GroupsBar isAdmin={role === 'admin'} onDone={() => void reloadConvs()} />
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <ConversationList
              conversations={visibleConversations}
              loading={loadingConvs}
              selectedId={selectedId}
              onSelect={setSelectedId}
              aiEnabledForChannel={aiEnabledForChannel}
              operatorName={operatorName}
              isLocked={isLocked}
              providerOf={providerOf}
              sla={sla}
              now={now}
            />
          </div>
        </div>

        {/* Center: thread — no mobile ocupa a tela quando há conversa aberta */}
        <div
          className={`inbox-column p-0 flex-col overflow-hidden h-full min-w-0 ${
            selectedId ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {selected ? (
            <>
              <div className="inbox-conversation-heading flex items-center gap-3 sm:gap-4">
                <button
                  onClick={() => setSelectedId(null)}
                  aria-label="Voltar à lista"
                  className="lg:hidden h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  <ArrowLeft className="h-4.5 w-4.5" />
                </button>
                <Avatar src={selected.contact?.profile_pic_url} name={selected.contact?.name || selected.contact?.phone} size="lg" className="!h-12 !w-12 sm:!h-16 sm:!w-16" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-bold text-[var(--color-text-primary)]">
                    {selected.contact?.name?.trim() || formatPhone(selected.contact?.phone) || '—'}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[15px] text-[var(--color-text-secondary)]">
                    <span className="truncate">{selectedIsGroup ? 'Grupo do WhatsApp' : formatPhoneDisplay(selected.contact?.phone)}</span>
                    {!selectedIsGroup && selected.contact?.phone && (
                      <button
                        type="button"
                        onClick={() => copyText(selected.contact?.phone ?? '', 'Telefone copiado.')}
                        aria-label="Copiar telefone"
                        title="Copiar telefone"
                        className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-[var(--color-text-muted)]">
                    {lastActivityLabel(selected.last_message_at)}
                    {' · '}Responsável: {operatorName(selected.assigned_to) ?? 'ninguém'}
                  </div>
                </div>

                <div className="hidden min-[1440px]:flex min-w-0 flex-col items-end gap-2">
                  <span className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold',
                    selected.channel === 'instagram'
                      ? 'bg-[rgba(225,48,108,0.1)] text-[#C13584]'
                      : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]',
                  )}>
                    {selected.channel === 'instagram' ? <Instagram className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
                    {selected.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}
                  </span>
                  {selected.contact?.id && !selectedIsGroup && (
                    <ContactTagsEditor contactId={selected.contact.id} variant="inline" align="right" />
                  )}
                </div>

                {/* Abaixo de 1440px o painel some: Transferir/Concluir ficam aqui. */}
                <div className="flex items-center gap-2 min-[1440px]:hidden">
                  {perms.can('inbox.transfer') && <TransferMenu
                    operators={operators}
                    assignedTo={selected.assigned_to}
                    userId={userId}
                    onAssign={(uid) => setAssigned(selected.id, uid)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                    <span className="hidden xl:inline">Transferir</span>
                  </TransferMenu>}
                  {perms.can('inbox.close') && <button
                    onClick={() => void toggleClosed()}
                    title={selected.status !== 'closed' ? 'Concluir atendimento' : 'Reabrir atendimento'}
                    className={cn(
                      'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-semibold transition-colors',
                      selected.status !== 'closed'
                        ? 'bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)]'
                        : 'border border-[var(--color-border-card)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]',
                    )}
                  >
                    {selected.status !== 'closed' ? <CheckCircle2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                    <span className="hidden xl:inline">{selected.status !== 'closed' ? 'Concluir' : 'Reabrir'}</span>
                  </button>}
                </div>

                {/* Menu ⋮: favoritar, assumir, compartilhar, detalhes */}
                <div className="relative shrink-0">
                  <button
                    onClick={() => setMoreOpen((v) => !v)}
                    aria-label="Mais opções"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    className="h-9 w-9 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                  >
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setMoreOpen(false)} />
                      <div role="menu" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-60 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
                        <MenuItem icon={<Star className={cn('h-4 w-4', selected.is_favorite && 'fill-[#FBBF24] text-[#FBBF24]')} />} onClick={async () => {
                          setMoreOpen(false);
                          try { await setFavorite(selected.id, !selected.is_favorite); }
                          catch (err) { toast.error('Falha ao favoritar', { description: err instanceof Error ? err.message : String(err) }); }
                        }}>
                          {selected.is_favorite ? 'Remover dos favoritos' : 'Favoritar conversa'}
                        </MenuItem>
                        {selected.status !== 'closed' && selected.assigned_to !== userId && (
                          <MenuItem icon={<UserCheck className="h-4 w-4" />} onClick={async () => {
                            setMoreOpen(false);
                            try { await setAssigned(selected.id, userId); toast.success('Conversa assumida.'); }
                            catch (err) { toast.error('Falha ao assumir', { description: err instanceof Error ? err.message : String(err) }); }
                          }}>
                            Assumir conversa
                          </MenuItem>
                        )}
                        <MenuItem icon={<Share2 className="h-4 w-4" />} onClick={() => { setMoreOpen(false); setShowForward(true); }}>
                          Compartilhar com a equipe
                        </MenuItem>
                        <div className="min-[1440px]:hidden">
                          <MenuItem icon={<Info className="h-4 w-4" />} onClick={() => { setMoreOpen(false); setShowPanelMobile(true); }}>
                            Detalhes do contato
                          </MenuItem>
                        </div>
                        <div className="hidden min-[1440px]:block">
                          <MenuItem icon={panelCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />} onClick={() => { setMoreOpen(false); togglePanel(); }}>
                            {panelCollapsed ? 'Mostrar painel do contato' : 'Ocultar painel do contato'}
                          </MenuItem>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
              {/* Barra do negócio: o painel direito já mostra Pipeline/Etapa. */}
              <div className="min-[1440px]:hidden">
              <ConversationDealBar
                contactId={selected.contact?.id ?? null}
                activeDealId={selected.active_deal_id ?? null}
              />
              </div>
              {selected.pinned_note && (
                <div className="flex items-start gap-2 border-b border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.06)] px-4 py-2 text-sm text-[#FBBF24]">
                  <Pin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span className="text-[var(--color-text-primary)] whitespace-pre-wrap break-words">{selected.pinned_note}</span>
                </div>
              )}
              <MessageThread
                messages={messages}
                loading={loadingMsgs}
                onRetry={retry}
                onDismiss={dismissFailed}
                onReply={selected.status !== 'closed' && perms.can('inbox.reply') ? setReplyTo : undefined}
                onForward={perms.can('inbox.reply') ? (m) => setForwardMsgs([m]) : undefined}
                onToggleSelect={perms.can('inbox.reply') ? toggleSelectMsg : undefined}
                onEdit={perms.can('inbox.reply') ? setEditingMsg : undefined}
                canEdit={(m) => selected.provider === 'uazapi' && selected.channel !== 'instagram'
                  && m.direction === 'outbound' && m.sender_type === 'operator' && m.content_type === 'text'
                  && (m.sender_id === userId || perms.isAdmin)
                  && Date.now() - new Date(m.created_at).getTime() < 15 * 60 * 1000}
                selectedIds={selectedMsgIds}
                contactName={selected.contact?.name?.trim() || null}
              />
              {selectedMsgs ? (
                <div className="flex items-center gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-3">
                  <button type="button" onClick={() => setSelectedMsgs(null)} aria-label="Cancelar seleção"
                    className="rounded-full p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                    <X className="h-5 w-5" />
                  </button>
                  <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)]">
                    {selectedMsgs.size === 0 ? 'Toque nas mensagens para selecionar' : `${selectedMsgs.size} selecionada${selectedMsgs.size > 1 ? 's' : ''}`}
                  </span>
                  <Button size="sm" disabled={selectedMsgs.size === 0}
                    onClick={() => {
                      const list = [...selectedMsgs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
                      setForwardMsgs(list);
                    }}>
                    <CornerUpRight className="h-4 w-4" /> Encaminhar
                  </Button>
                </div>
              ) : selected.status !== 'closed' && perms.can('inbox.reply') && (
                <MessageInput
                  conversationId={selected.id}
                  withinWindow={effectiveWithinWindow}
                  requiresTemplateRestart={requiresTemplateRestart}
                  instagramHumanAgentWindow={instagramHumanAgentWindow}
                  onSendText={sendText}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  channel={selected.channel}
                  contactName={selected.contact?.name?.trim() || null}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-label opacity-60">
                Selecione uma conversa para começar
              </div>
            </div>
          )}
        </div>

        {/* Right: contact panel — coluna fixa só em xl; abaixo disso é overlay.
            Recolhível: vira uma régua estreita com botão de expandir. */}
        <div className="inbox-details hidden min-[1440px]:flex p-0 overflow-hidden h-full flex-col">
          {panelCollapsed ? (
            <button
              onClick={togglePanel}
              aria-label="Expandir painel de detalhes"
              title="Expandir painel"
              className="h-full w-full flex items-start justify-center pt-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
            >
              <PanelRightOpen className="h-4.5 w-4.5" />
            </button>
          ) : selected ? (
            <>
              <div className="flex-1 min-h-0">
                <ContactPanel
                  showTopActions
                  conversation={selected}
                  withinWindow={effectiveWithinWindow}
                  provider={selectedProvider}
                  operators={operators}
                  queues={queues}
                  aiEnabled={aiEnabledForChannel(selected.channel ?? null)}
                  assignedName={operatorName(selected.assigned_to)}
                  onPauseAI={() => setAiPaused(selected.id, true)}
                  onResumeAI={() => setAiPaused(selected.id, false)}
                  onClose={() => setStatus(selected.id, 'closed')}
                  onReopen={() => setStatus(selected.id, 'human_active')}
                  onAssign={(uid) => setAssigned(selected.id, uid)}
                  onSetQueue={(qid) => setQueue(selected.id, qid)}
                  onSetActiveDeal={(dealId) => setActiveDeal(selected.id, dealId)}
                  onPinNote={(note) => setPinnedNote(selected.id, note)}
                  onArchive={(a) => setArchived(selected.id, a)}
                  onContactRefresh={() => void reloadConvs()}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-end px-2 py-2">
                <button
                  onClick={togglePanel}
                  aria-label="Recolher painel de detalhes"
                  title="Recolher painel"
                  className="h-8 w-8 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                >
                  <PanelRightClose className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="text-label opacity-60">Sem conversa selecionada</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Overlay do painel de contato em telas < xl */}
      {selected && showPanelMobile && (
        <div className="fixed inset-0 z-50 min-[1440px]:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowPanelMobile(false)}
          />
          <div className="absolute right-0 top-0 h-full w-80 max-w-[85vw] glass-surface border-l border-[var(--color-border-card)] overflow-y-auto">
            <div className="flex justify-end p-2">
              <button
                onClick={() => setShowPanelMobile(false)}
                aria-label="Fechar detalhes"
                className="h-11 w-11 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ContactPanel
              conversation={selected}
              withinWindow={effectiveWithinWindow}
              provider={selectedProvider}
              operators={operators}
              queues={queues}
              aiEnabled={aiEnabledForChannel(selected.channel ?? null)}
              assignedName={operatorName(selected.assigned_to)}
              onPauseAI={() => setAiPaused(selected.id, true)}
              onResumeAI={() => setAiPaused(selected.id, false)}
              onClose={() => setStatus(selected.id, 'closed')}
              onReopen={() => setStatus(selected.id, 'human_active')}
              onAssign={(uid) => setAssigned(selected.id, uid)}
              onSetQueue={(qid) => setQueue(selected.id, qid)}
              onSetActiveDeal={(dealId) => setActiveDeal(selected.id, dealId)}
              onPinNote={(note) => setPinnedNote(selected.id, note)}
              onArchive={(a) => setArchived(selected.id, a)}
              onContactRefresh={() => void reloadConvs()}
            />
          </div>
        </div>
      )}

      {selected && (
        <ForwardToChatDialog
          open={showForward}
          onClose={() => setShowForward(false)}
          conversationId={selected.id}
          contactLabel={selected.contact?.name?.trim() || formatPhone(selected.contact?.phone) || 'contato'}
        />
      )}

      {editingMsg && <EditMessageDialog message={editingMsg} onClose={() => setEditingMsg(null)} />}
      {forwardMsgs && (
        <ForwardMessageDialog
          messages={forwardMsgs}
          conversations={conversations}
          currentConversationId={selectedId}
          onClose={(sent) => { setForwardMsgs(null); if (sent) setSelectedMsgs(null); void reloadConvs(); }}
        />
      )}
    </div>
  );
}
