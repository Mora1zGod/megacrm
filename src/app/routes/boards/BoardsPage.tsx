import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  Archive, ArchiveRestore, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Inbox, KanbanSquare, Layers, Lock, MoreHorizontal,
  Palette, Pencil, Plus, Search, Users, X,
} from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useOperators } from '@/hooks/useOperators';
import { useTasks } from '@/hooks/useTasks';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { ListColumn } from '@/components/boards/ListColumn';
import { CardModal } from '@/components/boards/CardModal';
import { ShareBoardDialog } from '@/components/boards/ShareBoardDialog';
import { dueState, DUE_CLS } from '@/components/boards/CardMini';
import { AllBoardsView } from './AllBoardsView';
import { BOARD_BG, boardBg } from './boardBg';
export { BOARD_BG, boardBg };
import { positionBetween, useAllBoardMembers, useBoardContent, useBoards, type Board, type BoardCard } from '@/hooks/useBoards';

const TasksPage = lazy(() => import('../tasks/TasksPage'));

// Quadro aberto: ALL = tela inicial com todos os quadros lado a lado (como o quadro principal do Trello).
const ALL = 'todos';
type Mode = 'quadro' | 'caixa' | 'planejador';

// Tarefas e Quadros juntos: o quadro (Trello), a caixa de entrada (tarefas), o planejador (semana) e a troca de quadros.
export default function BoardsPage() {
  const perms = usePermission();
  const canBoards = perms.can('boards.view');
  const canTasks = perms.can('tasks.view');
  const [params, setParams] = useSearchParams();
  const mode: Mode = ((): Mode => {
    const m = params.get('modo');
    if (m === 'caixa' && canTasks) return 'caixa';
    if (m === 'planejador') return 'planejador';
    return canBoards ? 'quadro' : 'caixa';
  })();
  const setMode = (m: Mode) => setParams((p) => { p.set('modo', m); return p; }, { replace: true });
  const [switcher, setSwitcher] = useState(false);

  const { boards, archivedBoards, loading: loadingBoards, error: errBoards, reload: reloadBoards } = useBoards();
  const { userId, role } = useAppUser();
  const { byBoard: boardMembersByBoard, reload: reloadBoardMembers } = useAllBoardMembers();
  const visibleBoards = useMemo(() => boards.filter((b) => {
    const m = boardMembersByBoard.get(b.id);
    if (!m || m.length === 0 || role === 'admin') return true;
    return userId ? m.includes(userId) : false;
  }), [boards, boardMembersByBoard, role, userId]);
  const [boardId, setBoardId] = useState<string>(ALL);
  useEffect(() => {
    if (boardId !== ALL && !visibleBoards.some((b) => b.id === boardId) && !loadingBoards) setBoardId(ALL);
  }, [visibleBoards, boardId, loadingBoards]);
  const board = visibleBoards.find((b) => b.id === boardId) ?? null;
  const [openCardFromPlanner, setOpenCardFromPlanner] = useState<string | null>(null);

  return (
    <div className="relative -m-3 flex h-[calc(100%+1.5rem)] min-h-0 flex-col sm:-m-5 sm:h-[calc(100%+2.5rem)]">
      {(errBoards) && <div className="p-3"><LoadErrorBanner message={errBoards} onRetry={() => void reloadBoards()} /></div>}

      <div className="min-h-0 flex-1">
        {mode === 'quadro' && (
          loadingBoards ? <div className="p-6"><Skeleton className="h-96" /></div>
            : visibleBoards.length === 0 ? <EmptyBoards onCreate={() => setSwitcher(true)} archived={archivedBoards.length} />
            : !board ? <AllBoardsView boards={visibleBoards} onBoardsChanged={reloadBoards} onOpenBoard={setBoardId} onSwitch={() => setSwitcher(true)} />
            : <BoardView key={board.id} board={board} members={boardMembersByBoard.get(board.id) ?? []} onBoardsChanged={reloadBoards}
                onMembersChanged={reloadBoardMembers} onSwitch={() => setSwitcher(true)} onAll={() => setBoardId(ALL)} openCardId={openCardFromPlanner} onCardOpened={() => setOpenCardFromPlanner(null)} />
        )}
        {mode === 'caixa' && (
          <div className="h-full overflow-y-auto p-4 pb-24 md:p-6 md:pb-24">
            <Suspense fallback={<Skeleton className="h-96" />}><TasksPage /></Suspense>
          </div>
        )}
        {mode === 'planejador' && (
          <Planner boards={visibleBoards} canTasks={canTasks} canBoards={canBoards}
            onOpenCard={(bid, cid) => { setBoardId(bid); setOpenCardFromPlanner(cid); setMode('quadro'); }}
            onOpenTasks={() => setMode('caixa')} />
        )}
      </div>

      {/* Barra de baixo, como no Trello */}
      <nav aria-label="Modos" className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--color-border-card)] bg-[var(--color-surface-raised,var(--color-surface))] p-1.5 shadow-[var(--shadow-lg)]">
          {canTasks && <ModeBtn on={mode === 'caixa'} icon={Inbox} label="Caixa de entrada" onClick={() => setMode('caixa')} />}
          <ModeBtn on={mode === 'planejador'} icon={CalendarDays} label="Planejador" onClick={() => setMode('planejador')} />
          {canBoards && <ModeBtn on={mode === 'quadro'} icon={KanbanSquare} label="Quadro" onClick={() => setMode('quadro')} />}
          {canBoards && <>
            <span className="mx-1 h-6 w-px bg-[var(--color-border-card)]" />
            <ModeBtn on={false} icon={Layers} label="Mudar de quadros" onClick={() => setSwitcher(true)} />
          </>}
        </div>
      </nav>

      {switcher && (
        <BoardSwitcher boards={visibleBoards} archived={archivedBoards} currentId={boardId}
          onPick={(id) => { setBoardId(id); setMode('quadro'); setSwitcher(false); }}
          onClose={() => setSwitcher(false)} onChanged={reloadBoards} />
      )}
    </div>
  );
}

function ModeBtn({ on, icon: Icon, label, onClick }: { on: boolean; icon: typeof Inbox; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn('relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        on ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]')}>
      <Icon className="h-4 w-4" /><span className="hidden sm:inline">{label}</span>
      {on && <span className="absolute inset-x-3 -bottom-1 h-0.5 rounded-full bg-[var(--accent-primary)]" />}
    </button>
  );
}

function EmptyBoards({ onCreate, archived }: { onCreate: () => void; archived: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" style={{ background: BOARD_BG.noite }}>
      <KanbanSquare className="h-10 w-10 text-white/80" />
      <p className="text-lg font-semibold text-white">Nenhum quadro aberto</p>
      <p className="max-w-md text-sm text-white/75">{archived ? `Há ${archived} quadro(s) arquivado(s). Restaure ou junte-os em um quadro só.` : 'Crie o primeiro quadro da equipe.'}</p>
      <Button onClick={onCreate}><Layers className="h-4 w-4" /> Abrir quadros</Button>
    </div>
  );
}

// ============================================================================ QUADRO
function BoardView({ board, members, onBoardsChanged, onMembersChanged, onSwitch, onAll, openCardId, onCardOpened }: {
  board: Board; members: string[]; onBoardsChanged: () => Promise<void>; onMembersChanged: () => Promise<void>; onSwitch: () => void; onAll: () => void;
  openCardId: string | null; onCardOpened: () => void;
}) {
  const { lists, cards, labels, loading, error, reload, setCards, moveCard, moveList } = useBoardContent(board.id);
  const { operators } = useOperators();
  const { userId } = useAppUser();
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [newList, setNewList] = useState(false);
  const [filter, setFilter] = useState('');
  const [mine, setMine] = useState(false);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [overList, setOverList] = useState<string | null>(null);
  const [dragList, setDragList] = useState<string | null>(null);
  const [overListHeader, setOverListHeader] = useState<string | null>(null);
  const [moveAllFrom, setMoveAllFrom] = useState<string | null>(null);
  useEffect(() => { if (openCardId) { setOpenCard(openCardId); onCardOpened(); } }, [openCardId, onCardOpened]);

  const sortedLists = useMemo(() => [...lists].sort((a, b) => a.position - b.position), [lists]);
  const t = filter.trim().toLowerCase();
  const byList = useMemo(() => {
    const m = new Map<string, BoardCard[]>();
    for (const l of lists) m.set(l.id, []);
    for (const c of cards) {
      if (mine && !(userId && c.memberIds.includes(userId))) continue;
      if (t && !`${c.title} ${c.description ?? ''}`.toLowerCase().includes(t)) continue;
      m.get(c.list_id)?.push(c);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [lists, cards, t, mine, userId]);
  const cardOpen = cards.find((c) => c.id === openCard) ?? null;

  const dropCard = async (listId: string, beforeId: string | null) => {
    const id = dragCard; setDragCard(null); setOverList(null);
    if (!id) return;
    const dest = (byList.get(listId) ?? []).filter((c) => c.id !== id);
    const idx = beforeId ? dest.findIndex((c) => c.id === beforeId) : -1;
    const before = idx >= 0 ? dest[idx - 1]?.position ?? null : dest[dest.length - 1]?.position ?? null;
    const after = idx >= 0 ? dest[idx].position : null;
    const cur = cards.find((c) => c.id === id);
    if (!cur) return;
    const pos = positionBetween(before, after);
    if (cur.list_id === listId && cur.position === pos) return;
    try {
      await moveCard(id, listId, pos);
      if (cur.list_id !== listId) {
        await getSupabase().from('card_activity').insert({ card_id: id, user_id: userId, kind: 'move',
          content: `Moveu de "${lists.find((l) => l.id === cur.list_id)?.name ?? '—'}" para "${lists.find((l) => l.id === listId)?.name ?? '—'}"` });
      }
    } catch (e) { toast.error('Não consegui mover o cartão.', { description: e instanceof Error ? e.message : undefined }); }
  };
  const dropList = async (destId: string) => {
    const orig = dragList; setDragList(null); setOverListHeader(null);
    if (!orig || orig === destId) return;
    const i = sortedLists.findIndex((l) => l.id === destId);
    try { await moveList(orig, positionBetween(sortedLists[i - 1]?.position ?? null, sortedLists[i]?.position ?? null)); }
    catch (e) { toast.error('Não consegui reordenar a lista.', { description: e instanceof Error ? e.message : undefined }); }
  };
  const createCard = async (listId: string, title: string) => {
    const dest = byList.get(listId) ?? [];
    const sb = getSupabase();
    const { data, error: err } = await sb.from('board_cards').insert({ list_id: listId, title, position: positionBetween(dest[dest.length - 1]?.position ?? null, null) })
      .select('id, list_id, title, description, position, due_date, start_date, checklist, done, archived, cover_color').single();
    if (err) { toast.error('Não consegui criar o cartão.', { description: err.message }); return; }
    setCards((prev) => [...prev, { ...(data as BoardCard), labelIds: [], memberIds: [], watcherIds: [], checklists: [], attachments: [], activity: [] }]);
    await sb.from('card_activity').insert({ card_id: (data as BoardCard).id, user_id: userId, kind: 'create', content: `Adicionou este cartão a "${lists.find((l) => l.id === listId)?.name ?? '—'}"` });
  };
  const createList = async (name: string) => {
    const { error: err } = await getSupabase().from('board_lists').insert({ board_id: board.id, name, position: positionBetween(sortedLists[sortedLists.length - 1]?.position ?? null, null) });
    if (err) { toast.error('Não consegui criar a lista.', { description: err.message }); return; }
    await reload();
  };
  const patchCard = async (cardId: string, patch: Record<string, unknown>) => {
    const prev = cards;
    setCards((p) => p.map((c) => (c.id === cardId ? ({ ...c, ...patch } as BoardCard) : c)));
    const { error: err } = await getSupabase().from('board_cards').update(patch).eq('id', cardId);
    if (err) { setCards(prev); toast.error('Não consegui salvar.', { description: err.message }); }
  };
  const moveAll = async (fromId: string, toId: string) => {
    setMoveAllFrom(null);
    const src = (byList.get(fromId) ?? []);
    const dest = byList.get(toId) ?? [];
    let last = dest[dest.length - 1]?.position ?? null;
    for (const c of src) { last = positionBetween(last, null); await getSupabase().from('board_cards').update({ list_id: toId, position: last }).eq('id', c.id); }
    toast.success(`${src.length} cartão(ões) movido(s).`);
    await reload();
  };
  const boardMembers = members.map((id) => operators.find((o) => o.user_id === id)).filter(Boolean) as typeof operators;

  return (
    <div className="board-canvas flex h-full min-h-0 flex-col" style={{ background: boardBg(board) }}>
      {/* Barra do quadro */}
      <div className="flex flex-wrap items-center gap-2 bg-black/25 px-4 py-2.5 text-white backdrop-blur-sm">
        <button type="button" onClick={onAll} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-white/85 hover:bg-white/15" title="Voltar para todos os quadros">
          <ChevronLeft className="h-4 w-4" /> Todos os quadros
        </button>
        <button type="button" onClick={onSwitch} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-lg font-bold hover:bg-white/15" title="Mudar de quadro">
          {board.name} <ChevronDown className="h-4 w-4 opacity-80" />
        </button>
        {members.length > 0 && <span className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 text-xs" title="Só os membros convidados veem"><Lock className="h-3 w-3" /> Restrito</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/70" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar cartões"
              className="no-focus-ring h-8 w-44 rounded-md bg-white/15 pl-8 pr-2 text-sm text-white outline-none placeholder:text-white/70 focus:bg-white/25" />
          </label>
          <button type="button" onClick={() => setMine((v) => !v)} aria-pressed={mine}
            className={cn('h-8 rounded-md px-2.5 text-sm font-medium', mine ? 'bg-white text-[#172B4D]' : 'bg-white/15 hover:bg-white/25')}>Meus cartões</button>
          {boardMembers.length > 0 && (
            <span className="flex -space-x-2">{boardMembers.slice(0, 5).map((m) => <Avatar key={m.user_id} src={m.avatar_url} name={m.display_name ?? m.email} className="h-7 w-7 text-[10px] ring-2 ring-black/30" />)}</span>
          )}
          <button type="button" onClick={() => setShareOpen(true)} className="flex h-8 items-center gap-1.5 rounded-md bg-white px-3 text-sm font-semibold text-[#172B4D] hover:bg-white/90"><Users className="h-4 w-4" /> Compartilhar</button>
          <button type="button" onClick={() => setMenu(true)} aria-label="Menu do quadro" className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-white/15"><MoreHorizontal className="h-5 w-5" /></button>
        </div>
      </div>
      {error && <div className="p-3"><LoadErrorBanner message={error} onRetry={() => void reload()} /></div>}

      {/* Listas */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full items-start gap-3 p-3 pb-24">
          {sortedLists.map((l) => (
            <ListColumn key={l.id} list={l} cards={byList.get(l.id) ?? []} labels={labels} operators={operators} currentUserId={userId} loading={loading}
              isDropTarget={!!dragCard && overList === l.id} isListDropTarget={!!dragList && overListHeader === l.id} draggingCardId={dragCard}
              onCardDragStart={setDragCard} onCardDragOverList={() => setOverList(l.id)} onCardDrop={(before) => void dropCard(l.id, before)}
              onListDragStart={() => setDragList(l.id)} onListDragOver={() => setOverListHeader(l.id)} onListDrop={() => void dropList(l.id)}
              onOpenCard={setOpenCard} onCreateCard={(title) => void createCard(l.id, title)} onListArchived={() => void reload()}
              onMoveAllCards={() => setMoveAllFrom(l.id)} />
          ))}
          <div className="w-[272px] shrink-0">
            {newList ? <NewListInput onCreate={(n) => { void createList(n); }} onCancel={() => setNewList(false)} />
              : <button type="button" onClick={() => setNewList(true)} className="flex w-full items-center gap-2 rounded-xl bg-white/20 px-3 py-3 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/30"><Plus className="h-4 w-4" /> Adicionar outra lista</button>}
          </div>
        </div>
      </div>

      {cardOpen && (
        <CardModal card={cardOpen} boardId={board.id} lists={sortedLists} labels={labels} operators={operators} currentUserId={userId}
          onClose={() => setOpenCard(null)} onPatch={(p) => patchCard(cardOpen.id, p)} onReload={reload}
          onArchived={() => { setOpenCard(null); void reload(); }} onDeleted={() => { setOpenCard(null); setCards((p) => p.filter((c) => c.id !== cardOpen.id)); }} />
      )}
      {shareOpen && <ShareBoardDialog boardId={board.id} boardName={board.name} operators={operators} onClose={() => setShareOpen(false)} onChanged={() => void onMembersChanged()} />}
      {menu && <BoardMenu board={board} onClose={() => setMenu(false)} onChanged={async () => { await onBoardsChanged(); await reload(); }} />}
      {moveAllFrom && (
        <Dialog open onClose={() => setMoveAllFrom(null)} opaque title="Mover todos os cartões" description={`Da lista "${lists.find((l) => l.id === moveAllFrom)?.name}" para:`}>
          <div className="space-y-1">
            {sortedLists.filter((l) => l.id !== moveAllFrom).map((l) => (
              <button key={l.id} type="button" onClick={() => void moveAll(moveAllFrom, l.id)} className="flex w-full items-center justify-between rounded-md border border-[var(--color-border-card)] px-3 py-2 text-left text-sm hover:border-[var(--accent-primary)]">{l.name}<ChevronRight className="h-4 w-4" /></button>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function NewListInput({ onCreate, onCancel }: { onCreate: (nome: string) => void; onCancel: () => void }) {
  const [txt, setTxt] = useState('');
  const send = () => { const n = txt.trim(); if (n) { onCreate(n); setTxt(''); } };
  return (
    <div className="space-y-2 rounded-xl bg-[var(--board-list)] p-2">
      <input autoFocus value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="Insira o nome da lista…"
        onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') onCancel(); }}
        className="w-full rounded-md border-2 border-[var(--accent-primary)] bg-[var(--board-card)] px-2 py-1.5 text-sm text-[var(--board-card-text)] outline-none" />
      <div className="flex items-center gap-1">
        <button type="button" onClick={send} className="rounded-md bg-[var(--accent-fill)] px-3 py-1.5 text-sm font-semibold text-white">Adicionar lista</button>
        <button type="button" aria-label="Cancelar" onClick={onCancel} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

// Menu do quadro: renomear, fundo, itens arquivados (restaurar), arquivar quadro.
function BoardMenu({ board, onClose, onChanged }: { board: Board; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(board.name);
  const [archived, setArchived] = useState<{ lists: Array<{ id: string; name: string }>; cards: Array<{ id: string; title: string; list: string }> } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const loadArchived = useCallback(async () => {
    const sb = getSupabase();
    const { data: ls } = await sb.from('board_lists').select('id, name, archived').eq('board_id', board.id);
    const all = (ls ?? []) as Array<{ id: string; name: string; archived: boolean }>;
    const { data: cs } = all.length ? await sb.from('board_cards').select('id, title, list_id').in('list_id', all.map((l) => l.id)).eq('archived', true) : { data: [] };
    setArchived({ lists: all.filter((l) => l.archived), cards: ((cs ?? []) as Array<{ id: string; title: string; list_id: string }>).map((c) => ({ id: c.id, title: c.title, list: all.find((l) => l.id === c.list_id)?.name ?? '' })) });
  }, [board.id]);
  useEffect(() => { void loadArchived(); }, [loadArchived]);
  const upd = async (table: string, id: string, patch: Record<string, unknown>, ok: string) => {
    const { error } = await getSupabase().from(table).update(patch).eq('id', id);
    if (error) { toast.error('Não consegui salvar.', { description: error.message }); return false; }
    toast.success(ok); await onChanged(); void loadArchived(); return true;
  };
  return (
    <Dialog open onClose={onClose} opaque title="Menu do quadro" widthClass="max-w-lg">
      <div className="space-y-5">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><Pencil className="h-4 w-4" /> Nome</div>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className="h-10 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm" />
            <Button variant="outline" disabled={!name.trim() || name.trim() === board.name} onClick={() => void upd('boards', board.id, { name: name.trim() }, 'Quadro renomeado.')}>Salvar</Button>
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Palette className="h-4 w-4" /> Fundo</div>
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(BOARD_BG).map(([k, bg]) => (
              <button key={k} type="button" onClick={() => void upd('boards', board.id, { color: k }, 'Fundo trocado.')} aria-label={`Fundo ${k}`}
                className={cn('relative h-12 rounded-md ring-offset-2 ring-offset-[var(--color-surface)]', (board.color ?? 'noite') === k && 'ring-2 ring-[var(--accent-primary)]')} style={{ background: bg }}>
                {(board.color ?? 'noite') === k && <Check className="absolute right-1 top-1 h-4 w-4 text-white" />}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Archive className="h-4 w-4" /> Itens arquivados</div>
          {!archived ? <Skeleton className="h-12" /> : archived.lists.length + archived.cards.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nada arquivado neste quadro.</p> : (
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {archived.lists.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-soft)] px-3 py-1.5 text-sm">
                  <span><span className="text-xs text-[var(--color-text-muted)]">Lista</span> {l.name}</span>
                  <button type="button" onClick={() => void upd('board_lists', l.id, { archived: false }, 'Lista restaurada.')} className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-primary)]"><ArchiveRestore className="h-3.5 w-3.5" /> Restaurar</button>
                </li>
              ))}
              {archived.cards.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-soft)] px-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate">{c.title} <span className="text-xs text-[var(--color-text-muted)]">· {c.list}</span></span>
                  <button type="button" onClick={() => void upd('board_cards', c.id, { archived: false }, 'Cartão restaurado.')} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--accent-primary)]"><ArchiveRestore className="h-3.5 w-3.5" /> Restaurar</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-[var(--color-border-soft)] pt-4">
          {confirmArchive ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Arquivar o quadro "{board.name}"? Ele sai da tela, nada é apagado.</span>
              <Button size="sm" className="bg-[var(--color-error)]" onClick={async () => { if (await upd('boards', board.id, { archived: true }, 'Quadro arquivado.')) onClose(); }}>Arquivar</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmArchive(false)}>Cancelar</Button>
            </div>
          ) : <Button variant="outline" onClick={() => setConfirmArchive(true)}><Archive className="h-4 w-4" /> Arquivar este quadro</Button>}
        </div>
      </div>
    </Dialog>
  );
}

// ============================================================================ MUDAR DE QUADROS
function BoardSwitcher({ boards, archived, currentId, onPick, onClose, onChanged }: {
  boards: Board[]; archived: Board[]; currentId: string | null; onPick: (id: string) => void; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [merge, setMerge] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const sb = getSupabase();
      const [{ data: ls }, { data: cs }] = await Promise.all([
        sb.from('board_lists').select('id, board_id').eq('archived', false),
        sb.from('board_cards').select('list_id').eq('archived', false),
      ]);
      const lb = new Map(((ls ?? []) as Array<{ id: string; board_id: string }>).map((l) => [l.id, l.board_id]));
      const m = new Map<string, number>();
      for (const c of (cs ?? []) as Array<{ list_id: string }>) { const b = lb.get(c.list_id); if (b) m.set(b, (m.get(b) ?? 0) + 1); }
      setCounts(m);
    })();
  }, [boards, archived]);

  const create = async () => {
    const n = newName.trim();
    if (!n) { toast.error('Dê um nome ao quadro.'); return; }
    setBusy(true);
    const sb = getSupabase();
    const { data, error } = await sb.from('boards').insert({ name: n, position: Math.max(0, ...[...boards, ...archived].map((b) => Number(b.position) || 0)) + 1000, color: 'oceano' }).select('id').single();
    if (error) { setBusy(false); toast.error('Não consegui criar.', { description: error.message }); return; }
    const id = (data as { id: string }).id;
    await sb.from('board_lists').insert([{ board_id: id, name: 'A fazer', position: 1000 }, { board_id: id, name: 'Em andamento', position: 2000 }, { board_id: id, name: 'Concluído', position: 3000 }]);
    setBusy(false); toast.success('Quadro criado.');
    await onChanged(); onPick(id);
  };
  const restore = async (id: string) => {
    const { error } = await getSupabase().from('boards').update({ archived: false }).eq('id', id);
    if (error) { toast.error('Não consegui restaurar.', { description: error.message }); return; }
    toast.success('Quadro restaurado.'); await onChanged();
  };
  // Junta quadros: cada quadro escolhido vira uma LISTA do quadro novo (como no Trello), com os cartões, etiquetas e tudo dentro.
  const doMerge = async () => {
    const n = mergeName.trim();
    if (sel.length < 2) { toast.error('Escolha pelo menos 2 quadros.'); return; }
    if (!n) { toast.error('Dê um nome ao quadro novo.'); return; }
    setBusy(true);
    const sb = getSupabase();
    try {
      const { data: nb, error: e1 } = await sb.from('boards').insert({ name: n, position: Math.max(0, ...[...boards, ...archived].map((b) => Number(b.position) || 0)) + 1000, color: 'noite' }).select('id').single();
      if (e1) throw e1;
      const newId = (nb as { id: string }).id;
      const allBoards = [...boards, ...archived];
      let moved = 0;
      for (let i = 0; i < sel.length; i++) {
        const src = allBoards.find((b) => b.id === sel[i]);
        if (!src) continue;
        const { data: nl, error: e2 } = await sb.from('board_lists').insert({ board_id: newId, name: src.name, position: (i + 1) * 1000 }).select('id').single();
        if (e2) throw e2;
        const listId = (nl as { id: string }).id;
        const { data: ls } = await sb.from('board_lists').select('id, position').eq('board_id', src.id).order('position');
        const srcLists = (ls ?? []) as Array<{ id: string; position: number }>;
        if (srcLists.length) {
          const { data: cs } = await sb.from('board_cards').select('id, list_id, position').in('list_id', srcLists.map((l) => l.id)).eq('archived', false);
          const ordered = ((cs ?? []) as Array<{ id: string; list_id: string; position: number }>).sort((a, b) =>
            srcLists.findIndex((l) => l.id === a.list_id) - srcLists.findIndex((l) => l.id === b.list_id) || a.position - b.position);
          for (let j = 0; j < ordered.length; j++) {
            const { error: e3 } = await sb.from('board_cards').update({ list_id: listId, position: (j + 1) * 1000 }).eq('id', ordered[j].id);
            if (e3) throw e3;
            moved++;
          }
        }
        await sb.from('board_labels').update({ board_id: newId }).eq('board_id', src.id);
        if (!src.archived) await sb.from('boards').update({ archived: true }).eq('id', src.id);
      }
      toast.success(`Quadro "${n}" criado com ${sel.length} listas e ${moved} cartão(ões).`, { description: 'Os quadros antigos ficaram arquivados (vazios), nada foi apagado.' });
      await onChanged(); onPick(newId);
    } catch (e) {
      toast.error('Não consegui juntar os quadros.', { description: e instanceof Error ? e.message : (e as { message?: string })?.message });
      await onChanged();
    } finally { setBusy(false); }
  };
  const tile = (b: Board) => (
    <button key={b.id} type="button" onClick={() => (merge ? setSel((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id])) : onPick(b.id))}
      className={cn('relative flex h-24 flex-col justify-between rounded-lg p-3 text-left text-white shadow-sm transition-transform hover:-translate-y-0.5',
        currentId === b.id && !merge && 'ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--color-surface)]', b.archived && 'opacity-80')}
      style={{ background: boardBg(b) }}>
      <span className="line-clamp-2 font-bold drop-shadow">{b.name}</span>
      <span className="text-xs text-white/85">{counts.get(b.id) ?? 0} cartão(ões){b.archived ? ' · arquivado' : ''}</span>
      {merge && <span className={cn('absolute right-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white px-1 text-xs font-bold', sel.includes(b.id) ? 'bg-white text-[#172B4D]' : 'bg-black/20')}>{sel.includes(b.id) ? sel.indexOf(b.id) + 1 : ''}</span>}
    </button>
  );
  return (
    <Dialog open onClose={onClose} opaque title="Mudar de quadros" widthClass="max-w-4xl"
      description={merge ? 'Marque os quadros na ordem em que as listas devem aparecer. Cada quadro vira uma lista do quadro novo.' : 'Escolha o quadro para abrir.'}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {!merge && (
            <button type="button" onClick={() => onPick(ALL)}
              className={cn('relative flex h-24 flex-col justify-between rounded-lg p-3 text-left text-white shadow-sm transition-transform hover:-translate-y-0.5', currentId === ALL && 'ring-2 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--color-surface)]')}
              style={{ background: BOARD_BG.noite }}>
              <span className="font-bold drop-shadow">Todos os quadros</span>
              <span className="text-xs text-white/85">{boards.length} quadro(s) lado a lado · {[...counts.entries()].filter(([k]) => boards.some((b) => b.id === k)).reduce((s, [, v]) => s + v, 0)} cartão(ões)</span>
            </button>
          )}
          {boards.map(tile)}
          {!merge && (creating ? (
            <div className="flex h-24 flex-col gap-2 rounded-lg border border-[var(--color-border-card)] p-2">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setCreating(false); }} placeholder="Nome do quadro"
                className="h-8 rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
              <div className="flex gap-1"><Button size="sm" disabled={busy} onClick={() => void create()}>Criar</Button><Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button></div>
            </div>
          ) : (
            <button type="button" onClick={() => setCreating(true)} className="flex h-24 items-center justify-center gap-2 rounded-lg bg-[var(--color-surface-hover)] text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"><Plus className="h-4 w-4" /> Criar quadro</button>
          ))}
        </div>
        {archived.length > 0 && (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-secondary)]"><Archive className="h-4 w-4" /> Quadros arquivados</h4>
            {merge ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{archived.map(tile)}</div> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {archived.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border-card)] p-2">
                    <span className="h-8 w-12 shrink-0 rounded" style={{ background: boardBg(b) }} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{b.name}</span><span className="text-xs text-[var(--color-text-muted)]">{counts.get(b.id) ?? 0} cartão(ões)</span></span>
                    <Button size="sm" variant="outline" onClick={() => void restore(b.id)}><ArchiveRestore className="h-3.5 w-3.5" /> Restaurar</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-4">
          {merge ? (
            <>
              <input value={mergeName} onChange={(e) => setMergeName(e.target.value)} placeholder="Nome do quadro novo (ex.: Amai Park)"
                className="h-10 min-w-[240px] flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm" />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setMerge(false); setSel([]); }}>Cancelar</Button>
                <Button disabled={busy || sel.length < 2 || !mergeName.trim()} onClick={() => void doMerge()}>Juntar {sel.length || ''} quadro(s)</Button>
              </div>
            </>
          ) : (
            <Button variant="outline" onClick={() => setMerge(true)}><Layers className="h-4 w-4" /> Juntar quadros em um só</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ============================================================================ PLANEJADOR
interface PlanCard { id: string; title: string; due_date: string; done: boolean; board_id: string; board_name: string; list_name: string }
function Planner({ boards, canTasks, canBoards, onOpenCard, onOpenTasks }: {
  boards: Board[]; canTasks: boolean; canBoards: boolean; onOpenCard: (boardId: string, cardId: string) => void; onOpenTasks: () => void;
}) {
  const { tasks } = useTasks();
  const [start, setStart] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; });
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const [cards, setCards] = useState<PlanCard[]>([]);
  const boardsKey = boards.map((b) => b.id).join();
  const reqId = useRef(0);
  useEffect(() => {
    if (!canBoards || boards.length === 0) { setCards([]); return; }
    const my = ++reqId.current;
    void (async () => {
      const sb = getSupabase();
      const { data: ls } = await sb.from('board_lists').select('id, name, board_id').in('board_id', boards.map((b) => b.id)).eq('archived', false);
      const lists = (ls ?? []) as Array<{ id: string; name: string; board_id: string }>;
      if (!lists.length) { setCards([]); return; }
      const { data: cs } = await sb.from('board_cards').select('id, title, due_date, done, list_id').in('list_id', lists.map((l) => l.id)).eq('archived', false)
        .gte('due_date', start.toISOString()).lt('due_date', end.toISOString());
      if (my !== reqId.current) return;
      setCards(((cs ?? []) as Array<{ id: string; title: string; due_date: string; done: boolean; list_id: string }>).map((c) => {
        const l = lists.find((x) => x.id === c.list_id)!;
        return { id: c.id, title: c.title, due_date: c.due_date, done: c.done, board_id: l.board_id, board_name: boards.find((b) => b.id === l.board_id)?.name ?? '', list_name: l.name };
      }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardsKey, start.getTime(), canBoards]);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const today = new Date();
  const weekTasks = canTasks ? tasks.filter((t) => t.due_at && new Date(t.due_at) >= start && new Date(t.due_at) < end) : [];
  const shift = (n: number) => setStart((s) => { const d = new Date(s); d.setDate(d.getDate() + n); return d; });
  const label = `${days[0].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} – ${days[6].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`.replace(/\./g, '');

  return (
    <div className="flex h-full flex-col overflow-hidden p-4 pb-24 md:p-6 md:pb-24">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Planejador</h2>
        <span className="text-sm text-[var(--color-text-secondary)]">Prazos dos cartões e das tarefas da semana.</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => shift(-7)} aria-label="Semana anterior"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setStart(() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })}>Hoje</Button>
          <Button variant="outline" size="sm" onClick={() => shift(7)} aria-label="Próxima semana"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-2 text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-7">
        {days.map((d) => {
          const dc = cards.filter((c) => sameDay(new Date(c.due_date), d));
          const dt = weekTasks.filter((t) => sameDay(new Date(t.due_at!), d));
          const isToday = sameDay(d, today);
          return (
            <div key={d.toISOString()} className={cn('flex min-h-[160px] flex-col rounded-[var(--radius-card)] border bg-[var(--color-surface)] p-2', isToday ? 'border-[var(--accent-primary)]' : 'border-[var(--color-border-card)]')}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="text-xs font-semibold uppercase text-[var(--color-text-muted)]">{d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</span>
                <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold', isToday ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--color-text-primary)]')}>{d.getDate()}</span>
              </div>
              <div className="space-y-1.5">
                {dc.map((c) => {
                  const st = dueState(c);
                  return (
                    <button key={c.id} type="button" onClick={() => onOpenCard(c.board_id, c.id)} className="block w-full rounded-md border border-[var(--color-border-soft)] bg-[var(--color-surface-hover)] px-2 py-1.5 text-left hover:border-[var(--accent-primary)]">
                      <span className={cn('block text-sm leading-snug text-[var(--color-text-primary)]', c.done && 'line-through opacity-60')}>{c.title}</span>
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                        {st && st !== 'ok' && <span className={cn('rounded px-1', DUE_CLS[st])}>{new Date(c.due_date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
                        <span className="truncate">{c.board_name} · {c.list_name}</span>
                      </span>
                    </button>
                  );
                })}
                {dt.map((t) => (
                  <button key={t.id} type="button" onClick={onOpenTasks} className="flex w-full items-start gap-1.5 rounded-md border border-dashed border-[var(--color-border-card)] px-2 py-1.5 text-left text-sm hover:border-[var(--accent-primary)]">
                    <Inbox className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" />
                    <span className={cn('leading-snug text-[var(--color-text-primary)]', t.status === 'done' && 'line-through opacity-60')}>{t.title}</span>
                  </button>
                ))}
                {dc.length + dt.length === 0 && <p className="px-1 text-xs text-[var(--color-text-muted)]">—</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
