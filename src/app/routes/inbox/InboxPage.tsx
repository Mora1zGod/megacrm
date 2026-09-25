import { Avatar } from '@/components/ui/Avatar';
import './inbox.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRightLeft, CheckCircle2, Inbox as InboxIcon, Info, MessageSquarePlus, PanelRightClose, PanelRightOpen, Pin, RotateCcw, Share2, Star, UserCheck, X } from 'lucide-react';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { cn } from '@/lib/utils';
import { useAiChannels } from '@/hooks/useAiChannels';
import { useWhatsappProvider } from '@/hooks/useWhatsappProvider';
import { useConversations } from '@/hooks/useConversations';
import type { ConversationWithContact } from '@/types/inbox';
import { useMessages } from '@/hooks/useMessages';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { useQueues } from '@/hooks/useQueues';
import { useTags } from '@/hooks/useTags';
import { ConversationList } from '@/components/inbox/ConversationList';
import { StartWhatsappChat } from '@/components/inbox/StartWhatsappChat';
import { ConversationDealBar } from '@/components/inbox/ConversationDealBar';
import { Button } from '@/components/ui/button';
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
  // No mobile (<lg) mostramos uma coluna por vez: lista quando nada está
  // selecionado, senão a thread. O painel de contato vira um overlay.
  const [showPanelMobile, setShowPanelMobile] = useState(false);
  // "Compartilhar com a equipe": joga a conversa no Chat Interno.
  const [showForward, setShowForward] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  useEffect(() => { setTransferOpen(false); }, [selectedId]);
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

  // Conversa atribuída a OUTRO operador fica bloqueada para quem não é admin.
  // Sem atribuição, todo mundo vê; admin vê tudo.
  const isLocked = useCallback(
    (c: ConversationWithContact) => role !== 'admin' && Boolean(c.assigned_to) && c.assigned_to !== userId,
    [role, userId],
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
      (c) => matchesQuickChip(c, quickChip) && matchesBusca(c, busca),
    );
    return sortConversations(filtered, sort);
  }, [baseConversations, quickChip, busca, sort]);

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

  // Clear unread count when a conversation is open AND visible.
  useEffect(() => {
    if (selected && selected.unread_count > 0) {
      void markRead(selected.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.unread_count]);

  return (
    <div className="inbox-workspace h-full flex flex-col min-h-0">
      {/* Cabeçalho compacto: no Inbox cada pixel vertical é conversa visível.
          O ícone grande + rótulo "Seção" das outras telas custava ~40px de
          lista sem acrescentar informação. */}
      <div className="inbox-page-heading flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg glass-card flex items-center justify-center">
            <InboxIcon className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          <div><h1 className="text-xl font-bold text-display">Atendimento</h1><p className="text-xs text-[var(--color-text-secondary)]">Suas conversas, em um só lugar</p></div>
        </div>
        <Button variant="outline" onClick={() => setShowStartChat(true)}>
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden sm:inline">Iniciar conversa</span>
        </Button>
      </div>

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
          <div className="inbox-list-tools space-y-3">
            {/* Busca sempre visível + chips rápidos. Os filtros avançados
                continuam no popover abaixo, para casos específicos. */}
            <InboxQuickBar
              busca={busca}
              onBuscaChange={setBusca}
              chip={quickChip}
              onChipChange={setQuickChip}
              base={baseConversations}
              filters={filters}
            />
            <InboxFilters
              filters={filters}
              onChange={updateFilters}
              sort={sort}
              onSortChange={setSort}
              operators={operators}
              tags={tags}
              queues={queues}
            />
            {quickChip === 'grupos' && (
              <GroupsBar isAdmin={role === 'admin'} onDone={() => void reloadConvs()} />
            )}
            <div className="flex justify-end">
              <span className="text-[11px] text-[var(--color-text-secondary)] whitespace-nowrap">
                {visibleConversations.length} conversa{visibleConversations.length !== 1 ? 's' : ''}
              </span>
            </div>
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
              <div className="inbox-conversation-heading flex items-center gap-3">
                <button
                  onClick={() => setSelectedId(null)}
                  aria-label="Voltar à lista"
                  className="lg:hidden h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                >
                  <ArrowLeft className="h-4.5 w-4.5" />
                </button>
                <Avatar src={selected.contact?.profile_pic_url} name={selected.contact?.name || selected.contact?.phone} size="md" /><div className="min-w-0 flex-1">
                  <div className="font-semibold text-[var(--color-text-primary)] text-sm truncate">
                    {selected.contact?.name?.trim() || selected.contact?.phone || '—'}
                  </div>
                  <div className="text-[13px] text-[var(--color-text-muted)] truncate mt-0.5">
                    {selectedIsGroup ? 'Grupo do WhatsApp' : selected.contact?.phone}
                    {selectedIsGroup || selected.contact?.phone ? ' · ' : ''}
                    Responsável: <span className="text-[var(--color-text-secondary)]">{operatorName(selected.assigned_to) ?? 'ninguém'}</span>
                    {selected.status !== 'closed' && !selectedIsGroup && (
                      <>
                        {' · '}
                        <span className={selected.ai_paused ? 'font-medium text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'}>
                          {selected.ai_paused ? 'AMAIA pausada' : 'AMAIA ativa'}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await setFavorite(selected.id, !selected.is_favorite);
                    } catch (err) {
                      toast.error('Falha ao favoritar', { description: err instanceof Error ? err.message : String(err) });
                    }
                  }}
                  aria-label={selected.is_favorite ? 'Remover dos favoritos' : 'Favoritar conversa'}
                  title={selected.is_favorite ? 'Remover dos favoritos' : 'Favoritar conversa'}
                  className="shrink-0 h-9 w-9 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-150"
                >
                  <Star className={cn('h-4 w-4', selected.is_favorite && 'fill-[#FBBF24] text-[#FBBF24]')} />
                </button>
                {selected.status !== 'closed' && selected.assigned_to !== userId && (
                  <button
                    onClick={async () => {
                      try {
                        await setAssigned(selected.id, userId);
                        toast.success('Conversa assumida.');
                      } catch (err) {
                        toast.error('Falha ao assumir', { description: err instanceof Error ? err.message : String(err) });
                      }
                    }}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Assumir</span>
                  </button>
                )}
                <div className="relative shrink-0">
                  <button
                    onClick={() => setTransferOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={transferOpen}
                    title="Transferir conversa"
                    className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                    <span className="hidden md:inline">Transferir</span>
                  </button>
                  {transferOpen && (
                    <>
                      <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setTransferOpen(false)} />
                      <div role="menu" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-64 max-h-80 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
                        <div className="px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-muted)]">Transferir para</div>
                        {operators.filter((o) => o.user_id !== selected.assigned_to).map((o) => (
                          <button
                            key={o.user_id}
                            role="menuitem"
                            onClick={async () => {
                              setTransferOpen(false);
                              try {
                                await setAssigned(selected.id, o.user_id);
                                toast.success(`Conversa transferida para ${operatorLabel(o)}.`);
                              } catch (err) {
                                toast.error('Falha ao transferir', { description: err instanceof Error ? err.message : String(err) });
                              }
                            }}
                            className="flex w-full min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
                          >
                            <Avatar src={o.avatar_url} name={operatorLabel(o)} size="sm" />
                            <span className="truncate">{operatorLabel(o)}{o.user_id === userId ? ' (você)' : ''}</span>
                          </button>
                        ))}
                        {operators.filter((o) => o.user_id !== selected.assigned_to).length === 0 && (
                          <div className="px-2.5 py-2 text-sm text-[var(--color-text-muted)]">Nenhum outro membro na equipe.</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={async () => {
                    const closing = selected.status !== 'closed';
                    try {
                      await setStatus(selected.id, closing ? 'closed' : 'human_active');
                      toast.success(closing ? 'Conversa concluída.' : 'Conversa reaberta.');
                    } catch (err) {
                      toast.error(closing ? 'Falha ao concluir' : 'Falha ao reabrir', { description: err instanceof Error ? err.message : String(err) });
                    }
                  }}
                  title={selected.status !== 'closed' ? 'Concluir atendimento' : 'Reabrir atendimento'}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-semibold transition-colors duration-150',
                    selected.status !== 'closed'
                      ? 'bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)]'
                      : 'border border-[var(--color-border-card)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  {selected.status !== 'closed' ? <CheckCircle2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                  <span className="hidden md:inline">{selected.status !== 'closed' ? 'Concluir' : 'Reabrir'}</span>
                </button>
                <button
                  onClick={() => setShowForward(true)}
                  aria-label="Compartilhar com a equipe"
                  title="Compartilhar esta conversa no Chat Interno"
                  className="shrink-0 h-9 w-9 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-150"
                >
                  <Share2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setShowPanelMobile(true)}
                  aria-label="Detalhes da conversa"
                  className="min-[1440px]:hidden h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                >
                  <Info className="h-4.5 w-4.5" />
                </button>
              </div>
              <ConversationDealBar
                contactId={selected.contact?.id ?? null}
                activeDealId={selected.active_deal_id ?? null}
              />
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
              />
              {selected.status !== 'closed' && (
                <MessageInput
                  conversationId={selected.id}
                  withinWindow={effectiveWithinWindow}
                  requiresTemplateRestart={requiresTemplateRestart}
                  instagramHumanAgentWindow={instagramHumanAgentWindow}
                  onSendText={sendText}
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
              <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border-card)]">
                <span className="text-label">Detalhes</span>
                <button
                  onClick={togglePanel}
                  aria-label="Recolher painel de detalhes"
                  title="Recolher painel"
                  className="h-8 w-8 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
                >
                  <PanelRightClose className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 min-h-0">
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
          contactLabel={selected.contact?.name?.trim() || selected.contact?.phone || 'contato'}
        />
      )}
    </div>
  );
}
