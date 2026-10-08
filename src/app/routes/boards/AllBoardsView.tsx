import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Archive, ChevronDown, ExternalLink, MoreHorizontal, Pencil, Plus, Search, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useOperators, type Operator } from '@/hooks/useOperators';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { CardMini } from '@/components/boards/CardMini';
import { CardModal } from '@/components/boards/CardModal';
import { positionBetween, useBoardContent, type Board, type BoardCard, type BoardList, type Label } from '@/hooks/useBoards';
import { BOARD_BG, boardBg } from './boardBg';

// Tela inicial de "Tarefas e quadros", como o quadro principal do Trello: TODOS os quadros lado a lado,
// cada quadro é uma coluna com todos os cartões dele (de todas as listas: A fazer, Em andamento…).
// Arrastar entre colunas leva o cartão para o outro quadro (lista de mesmo nome, ou a primeira).
export function AllBoardsView({ boards, onBoardsChanged, onOpenBoard, onSwitch }: {
  boards: Board[]; onBoardsChanged: () => Promise<void>; onOpenBoard: (id: string) => void; onSwitch: () => void;
}) {
  const sortedBoards = useMemo(() => [...boards].sort((a, b) => a.position - b.position), [boards]);
  const ids = useMemo(() => sortedBoards.map((b) => b.id), [sortedBoards]);
  const { lists, cards, labels, loading, error, reload, setCards, moveCard } = useBoardContent(ids);
  const { operators } = useOperators();
  const { userId } = useAppUser();
  const [filter, setFilter] = useState('');
  const [mine, setMine] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [overBoard, setOverBoard] = useState<string | null>(null);
  const [dragBoard, setDragBoard] = useState<string | null>(null);
  const [overBoardHeader, setOverBoardHeader] = useState<string | null>(null);
  const [newBoard, setNewBoard] = useState(false);

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const listsByBoard = useMemo(() => {
    const m = new Map<string, BoardList[]>();
    for (const l of [...lists].sort((a, b) => a.position - b.position)) (m.get(l.board_id) ?? m.set(l.board_id, []).get(l.board_id)!).push(l);
    return m;
  }, [lists]);
  const t = filter.trim().toLowerCase();
  // Cartões de cada quadro, na ordem: lista (posição) e depois o cartão (posição).
  const byBoard = useMemo(() => {
    const m = new Map<string, BoardCard[]>();
    for (const b of sortedBoards) m.set(b.id, []);
    for (const c of cards) {
      const l = listById.get(c.list_id);
      if (!l) continue;
      if (mine && !(userId && c.memberIds.includes(userId))) continue;
      if (t && !`${c.title} ${c.description ?? ''}`.toLowerCase().includes(t)) continue;
      m.get(l.board_id)?.push(c);
    }
    for (const arr of m.values()) arr.sort((a, b) => (listById.get(a.list_id)!.position - listById.get(b.list_id)!.position) || a.position - b.position);
    return m;
  }, [sortedBoards, cards, listById, mine, userId, t]);
  const cardOpen = cards.find((c) => c.id === openCard) ?? null;
  const openList = cardOpen ? listById.get(cardOpen.list_id) : undefined;
  const boardName = (id: string) => sortedBoards.find((b) => b.id === id)?.name ?? '';
  // No cartão aberto dá para mover para qualquer lista de qualquer quadro ("Compras · A fazer").
  const allListsNamed = useMemo(() => sortedBoards.flatMap((b) => (listsByBoard.get(b.id) ?? []).map((l) => ({ ...l, name: `${b.name} · ${l.name}` }))), [sortedBoards, listsByBoard]);

  const ensureList = async (boardId: string): Promise<BoardList | null> => {
    const ex = listsByBoard.get(boardId)?.[0];
    if (ex) return ex;
    const { data, error: err } = await getSupabase().from('board_lists').insert({ board_id: boardId, name: 'A fazer', position: 1000 }).select('id, board_id, name, position, archived').single();
    if (err) { toast.error('Este quadro não tem lista e não consegui criar uma.', { description: err.message }); return null; }
    await reload();
    return data as BoardList;
  };

  const dropCard = async (boardId: string, beforeId: string | null) => {
    const id = dragCard; setDragCard(null); setOverBoard(null);
    if (!id) return;
    const cur = cards.find((c) => c.id === id);
    if (!cur) return;
    const curList = listById.get(cur.list_id);
    let destList: string;
    let pos: number;
    if (beforeId && beforeId !== id) {
      const target = cards.find((c) => c.id === beforeId)!;
      destList = target.list_id;
      const inList = cards.filter((c) => c.list_id === destList && c.id !== id && !c.archived).sort((a, b) => a.position - b.position);
      const i = inList.findIndex((c) => c.id === beforeId);
      pos = positionBetween(inList[i - 1]?.position ?? null, target.position);
    } else {
      const bl = listsByBoard.get(boardId) ?? [];
      const same = curList?.board_id === boardId ? curList : bl.find((l) => l.name.trim().toLowerCase() === curList?.name.trim().toLowerCase());
      const dl = same ?? bl[0] ?? (await ensureList(boardId));
      if (!dl) return;
      destList = dl.id;
      const inList = cards.filter((c) => c.list_id === destList && c.id !== id).sort((a, b) => a.position - b.position);
      pos = positionBetween(inList[inList.length - 1]?.position ?? null, null);
    }
    if (cur.list_id === destList && cur.position === pos) return;
    try {
      await moveCard(id, destList, pos);
      if (cur.list_id !== destList) {
        const to = listById.get(destList);
        await getSupabase().from('card_activity').insert({ card_id: id, user_id: userId, kind: 'move',
          content: `Moveu de "${boardName(curList?.board_id ?? '')} · ${curList?.name ?? '—'}" para "${boardName(to?.board_id ?? boardId)} · ${to?.name ?? '—'}"` });
      }
    } catch (e) { toast.error('Não consegui mover o cartão.', { description: e instanceof Error ? e.message : undefined }); }
  };

  // Reordena os quadros (arrastar o título da coluna). Poucos quadros: renumera todos com inteiros.
  const dropBoard = async (destId: string) => {
    const orig = dragBoard; setDragBoard(null); setOverBoardHeader(null);
    if (!orig || orig === destId) return;
    const order = sortedBoards.map((b) => b.id).filter((x) => x !== orig);
    order.splice(order.indexOf(destId), 0, orig);
    const sb = getSupabase();
    try {
      for (let i = 0; i < order.length; i++) {
        const { error: err } = await sb.from('boards').update({ position: (i + 1) * 1000 }).eq('id', order[i]);
        if (err) throw err;
      }
    } catch (e) { toast.error('Não consegui reordenar.', { description: (e as { message?: string })?.message }); }
    await onBoardsChanged();
  };

  const createCard = async (boardId: string, title: string) => {
    const dl = await ensureList(boardId);
    if (!dl) return;
    const inList = cards.filter((c) => c.list_id === dl.id).sort((a, b) => a.position - b.position);
    const sb = getSupabase();
    const { data, error: err } = await sb.from('board_cards').insert({ list_id: dl.id, title, position: positionBetween(inList[inList.length - 1]?.position ?? null, null) })
      .select('id, list_id, title, description, position, due_date, start_date, checklist, done, archived, cover_color').single();
    if (err) { toast.error('Não consegui criar o cartão.', { description: err.message }); return; }
    setCards((prev) => [...prev, { ...(data as BoardCard), labelIds: [], memberIds: [], watcherIds: [], checklists: [], attachments: [], activity: [] }]);
    await sb.from('card_activity').insert({ card_id: (data as BoardCard).id, user_id: userId, kind: 'create', content: `Adicionou este cartão a "${boardName(boardId)} · ${dl.name}"` });
  };

  const createBoard = async (name: string) => {
    const sb = getSupabase();
    const pos = Math.max(0, ...boards.map((b) => Number(b.position) || 0)) + 1000;
    const { data, error: err } = await sb.from('boards').insert({ name, position: Math.min(pos, 2_000_000_000), color: 'oceano' }).select('id').single();
    if (err) { toast.error('Não consegui criar o quadro.', { description: err.message }); return; }
    const id = (data as { id: string }).id;
    await sb.from('board_lists').insert([{ board_id: id, name: 'A fazer', position: 1000 }, { board_id: id, name: 'Em andamento', position: 2000 }, { board_id: id, name: 'Concluído', position: 3000 }]);
    setNewBoard(false);
    toast.success(`Quadro "${name}" criado.`);
    await onBoardsChanged();
  };

  const patchCard = async (cardId: string, patch: Record<string, unknown>) => {
    const prev = cards;
    setCards((p) => p.map((c) => (c.id === cardId ? ({ ...c, ...patch } as BoardCard) : c)));
    const { error: err } = await getSupabase().from('board_cards').update(patch).eq('id', cardId);
    if (err) { setCards(prev); toast.error('Não consegui salvar.', { description: err.message }); }
  };

  const total = [...byBoard.values()].reduce((s, a) => s + a.length, 0);

  return (
    <div className="board-canvas flex h-full min-h-0 flex-col" style={{ background: BOARD_BG.noite }}>
      <div className="flex flex-wrap items-center gap-2 bg-black/25 px-4 py-2.5 text-white backdrop-blur-sm">
        <button type="button" onClick={onSwitch} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-lg font-bold hover:bg-white/15" title="Mudar de quadro">
          Todos os quadros <ChevronDown className="h-4 w-4 opacity-80" />
        </button>
        <span className="text-xs text-white/75">{sortedBoards.length} quadro(s) · {total} cartão(ões)</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/70" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar cartões"
              className="no-focus-ring h-8 w-44 rounded-md bg-white/15 pl-8 pr-2 text-sm text-white outline-none placeholder:text-white/70 focus:bg-white/25" />
          </label>
          <button type="button" onClick={() => setMine((v) => !v)} aria-pressed={mine}
            className={cn('h-8 rounded-md px-2.5 text-sm font-medium', mine ? 'bg-white text-[#172B4D]' : 'bg-white/15 hover:bg-white/25')}>Meus cartões</button>
        </div>
      </div>
      {error && <div className="p-3"><LoadErrorBanner message={error} onRetry={() => void reload()} /></div>}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full items-start gap-3 p-3 pb-24">
          {sortedBoards.map((b) => (
            <BoardColumn key={b.id} board={b} cards={byBoard.get(b.id) ?? []} lists={listsByBoard.get(b.id) ?? []} listById={listById}
              labels={labels.filter((l) => l.board_id === b.id)} operators={operators} currentUserId={userId} loading={loading}
              draggingCardId={dragCard} isDropTarget={!!dragCard && overBoard === b.id} isHeaderTarget={!!dragBoard && overBoardHeader === b.id}
              onCardDragStart={setDragCard} onCardDragOver={() => setOverBoard(b.id)} onCardDrop={(before) => void dropCard(b.id, before)}
              onHeaderDragStart={() => setDragBoard(b.id)} onHeaderDragOver={() => setOverBoardHeader(b.id)} onHeaderDrop={() => void dropBoard(b.id)}
              onOpenCard={setOpenCard} onCreateCard={(title) => void createCard(b.id, title)} onOpenBoard={() => onOpenBoard(b.id)}
              onChanged={onBoardsChanged} />
          ))}
          <div className="w-[272px] shrink-0">
            {newBoard ? <NewBoardInput onCreate={(n) => void createBoard(n)} onCancel={() => setNewBoard(false)} />
              : <button type="button" onClick={() => setNewBoard(true)} className="flex w-full items-center gap-2 rounded-xl bg-white/20 px-3 py-3 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/30"><Plus className="h-4 w-4" /> Adicionar outro quadro</button>}
          </div>
        </div>
      </div>

      {cardOpen && openList && (
        <CardModal card={cardOpen} boardId={openList.board_id} lists={allListsNamed} labels={labels.filter((l) => l.board_id === openList.board_id)}
          operators={operators} currentUserId={userId}
          onClose={() => setOpenCard(null)} onPatch={(p) => patchCard(cardOpen.id, p)} onReload={reload}
          onArchived={() => { setOpenCard(null); void reload(); }} onDeleted={() => { setOpenCard(null); setCards((p) => p.filter((c) => c.id !== cardOpen.id)); }} />
      )}
    </div>
  );
}

function BoardColumn({
  board, cards, lists, listById, labels, operators, currentUserId, loading, draggingCardId, isDropTarget, isHeaderTarget,
  onCardDragStart, onCardDragOver, onCardDrop, onHeaderDragStart, onHeaderDragOver, onHeaderDrop, onOpenCard, onCreateCard, onOpenBoard, onChanged,
}: {
  board: Board; cards: BoardCard[]; lists: BoardList[]; listById: Map<string, BoardList>; labels: Label[]; operators: Operator[];
  currentUserId: string | null; loading: boolean; draggingCardId: string | null; isDropTarget: boolean; isHeaderTarget: boolean;
  onCardDragStart: (id: string) => void; onCardDragOver: () => void; onCardDrop: (beforeId: string | null) => void;
  onHeaderDragStart: () => void; onHeaderDragOver: () => void; onHeaderDrop: () => void;
  onOpenCard: (id: string) => void; onCreateCard: (title: string) => void; onOpenBoard: () => void; onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(board.name);
  const [menu, setMenu] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [overCard, setOverCard] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setName(board.name), [board.name]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenu(false); setConfirmArchive(false); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);
  // Etiqueta da lista só quando o cartão já saiu da primeira (Em andamento, Concluído…) — a primeira fica limpa, como no Trello.
  const firstListId = lists[0]?.id;

  const rename = async () => {
    setEditing(false);
    const n = name.trim();
    if (!n || n === board.name) { setName(board.name); return; }
    const { error } = await getSupabase().from('boards').update({ name: n }).eq('id', board.id);
    if (error) { toast.error('Não consegui renomear.', { description: error.message }); setName(board.name); return; }
    await onChanged();
  };
  const archive = async () => {
    const { error } = await getSupabase().from('boards').update({ archived: true }).eq('id', board.id);
    if (error) { toast.error('Não consegui arquivar.', { description: error.message }); return; }
    toast.success(`Quadro "${board.name}" arquivado.`, { description: 'Restaure em "Mudar de quadros".' });
    await onChanged();
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (draggingCardId) onCardDragOver(); else onHeaderDragOver(); }}
      onDrop={(e) => { e.preventDefault(); if (draggingCardId) { onCardDrop(overCard); setOverCard(null); } else onHeaderDrop(); }}
      className={cn('flex max-h-full w-[272px] shrink-0 flex-col overflow-hidden rounded-xl bg-[var(--board-list)] text-[var(--board-list-text)] shadow-[0_1px_1px_rgba(9,30,66,0.25)]',
        (isDropTarget || isHeaderTarget) && 'outline outline-2 outline-[var(--accent-primary)]')}
    >
      <div className="h-1.5 w-full shrink-0" style={{ background: boardBg(board) }} />
      <div draggable onDragStart={(e) => { e.stopPropagation(); onHeaderDragStart(); }} className="flex cursor-grab items-start gap-1 px-2 pb-1 pt-1.5 active:cursor-grabbing">
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(board.name); setEditing(false); } }}
            className="min-w-0 flex-1 rounded-md border-2 border-[var(--accent-primary)] bg-[var(--board-card)] px-2 py-1 text-sm font-semibold text-[var(--board-list-text)] outline-none" />
        ) : (
          <h3 onClick={() => setEditing(true)} className="min-w-0 flex-1 cursor-text break-words rounded-md px-2 py-1 text-sm font-bold uppercase leading-snug">{board.name}</h3>
        )}
        <span className="shrink-0 px-1 pt-1.5 text-xs text-[var(--board-list-muted)]">{cards.length}</span>
        <div ref={menuRef} className="relative shrink-0">
          <button type="button" onClick={() => setMenu((v) => !v)} aria-label="Ações do quadro" className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]"><MoreHorizontal className="h-4 w-4" /></button>
          {menu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 text-[var(--color-text-primary)] shadow-[var(--shadow-lg)]">
              <div className="mb-1 flex items-center justify-between px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)]">Ações do quadro <button type="button" aria-label="Fechar" onClick={() => setMenu(false)}><X className="h-3.5 w-3.5" /></button></div>
              <MenuBtn icon={Plus} onClick={() => { setMenu(false); setAdding(true); }}>Adicionar cartão</MenuBtn>
              <MenuBtn icon={ExternalLink} onClick={() => { setMenu(false); onOpenBoard(); }}>Abrir quadro (ver por listas)</MenuBtn>
              <MenuBtn icon={Pencil} onClick={() => { setMenu(false); setEditing(true); }}>Renomear</MenuBtn>
              <div className="my-1 border-t border-[var(--color-border-soft)]" />
              {confirmArchive ? (
                <div className="space-y-2 px-2 py-1.5 text-sm">
                  <p>Arquivar o quadro "{board.name}"? Ele sai da tela com os {cards.length} cartão(ões); nada é apagado.</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void archive()} className="rounded-md bg-[var(--color-error)] px-3 py-1.5 text-xs font-semibold text-white">Arquivar</button>
                    <button type="button" onClick={() => setConfirmArchive(false)} className="rounded-md px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]">Cancelar</button>
                  </div>
                </div>
              ) : <MenuBtn icon={Archive} onClick={() => setConfirmArchive(true)}>Arquivar este quadro</MenuBtn>}
            </div>
          )}
        </div>
      </div>

      <div className={cn('min-h-[8px] flex-1 space-y-2 overflow-y-auto px-2 pb-1 pt-0.5', isDropTarget && !cards.length && 'min-h-[48px]')}>
        {cards.map((c) => (
          <div key={c.id} onDragOver={(e) => { if (draggingCardId && draggingCardId !== c.id) { e.preventDefault(); setOverCard(c.id); } }}
            className={cn(overCard === c.id && draggingCardId && 'border-t-[3px] border-[var(--accent-primary)] pt-1')}>
            <CardMini card={c} labels={labels} operators={operators} currentUserId={currentUserId} dragging={draggingCardId === c.id}
              listName={c.list_id !== firstListId ? listById.get(c.list_id)?.name : undefined}
              onOpen={() => onOpenCard(c.id)} onDragStart={() => onCardDragStart(c.id)} />
          </div>
        ))}
        {cards.length === 0 && !loading && !adding && <p className="px-2 py-1 text-xs text-[var(--board-list-muted)]">{isDropTarget ? 'Solte aqui' : 'Sem cartões'}</p>}
      </div>
      <NewCard open={adding} setOpen={setAdding} onCreate={onCreateCard} />
    </div>
  );
}

function MenuBtn({ icon: Icon, onClick, children }: { icon: typeof Plus; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]"><Icon className="h-4 w-4" /> {children}</button>;
}

function NewCard({ open, setOpen, onCreate }: { open: boolean; setOpen: (v: boolean) => void; onCreate: (title: string) => void }) {
  const [txt, setTxt] = useState('');
  const send = () => { const t = txt.trim(); if (t) onCreate(t); setTxt(''); if (!t) setOpen(false); };
  if (!open) {
    return (
      <div className="px-2 pb-2 pt-1">
        <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--board-list-muted)] hover:bg-[var(--board-hover)] hover:text-[var(--board-list-text)]"><Plus className="h-4 w-4" /> Adicionar um cartão</button>
      </div>
    );
  }
  return (
    <div className="space-y-2 px-2 pb-2 pt-1">
      <textarea autoFocus rows={3} value={txt} onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') { setOpen(false); setTxt(''); } }}
        placeholder="Insira um título" className="w-full resize-none rounded-lg bg-[var(--board-card)] px-3 py-2 text-sm text-[var(--board-card-text)] shadow-[0_1px_1px_rgba(9,30,66,0.25)] outline-none placeholder:text-[var(--board-card-muted)]" />
      <div className="flex items-center gap-1">
        <button type="button" onClick={send} className="rounded-md bg-[var(--accent-fill)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">Adicionar cartão</button>
        <button type="button" aria-label="Cancelar" onClick={() => { setOpen(false); setTxt(''); }} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function NewBoardInput({ onCreate, onCancel }: { onCreate: (nome: string) => void; onCancel: () => void }) {
  const [txt, setTxt] = useState('');
  const send = () => { const n = txt.trim(); if (n) onCreate(n); };
  return (
    <div className="space-y-2 rounded-xl bg-[var(--board-list)] p-2">
      <input autoFocus value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="Nome do quadro…"
        onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') onCancel(); }}
        className="w-full rounded-md border-2 border-[var(--accent-primary)] bg-[var(--board-card)] px-2 py-1.5 text-sm text-[var(--board-card-text)] outline-none" />
      <p className="px-1 text-[11px] text-[var(--board-list-muted)]">Nasce com as listas A fazer, Em andamento e Concluído.</p>
      <div className="flex items-center gap-1">
        <button type="button" onClick={send} className="rounded-md bg-[var(--accent-fill)] px-3 py-1.5 text-sm font-semibold text-white">Criar quadro</button>
        <button type="button" aria-label="Cancelar" onClick={onCancel} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
