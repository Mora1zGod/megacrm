import { useEffect, useMemo, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { KanbanSquare, Plus, Users } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useOperators } from '@/hooks/useOperators';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { Dialog } from '@/components/ui/dialog';
import { Label as FieldLabel } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ListColumn } from '@/components/boards/ListColumn';
import { CardModal } from '@/components/boards/CardModal';
import { ShareBoardDialog } from '@/components/boards/ShareBoardDialog';
import { positionBetween, useAllBoardMembers, useBoardContent, useBoards, type BoardCard } from '@/hooks/useBoards';

const STORAGE_KEY = 'amai_board_atual';

export default function BoardsPage() {
  const { boards, loading: loadingBoards, error: errBoards, reload: reloadBoards } = useBoards();
  const [boardId, setBoardId] = useState<string | null>(null);
  const { lists, cards, labels, loading, error, reload, setCards, moveCard, moveList } = useBoardContent(boardId);
  const { operators } = useOperators();
  const { userId, role } = useAppUser();
  const { byBoard: boardMembersByBoard, reload: reloadBoardMembers } = useAllBoardMembers();
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [novoQuadro, setNovoQuadro] = useState(false);
  const [novaListaAberta, setNovaListaAberta] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Quadro sem membros marcados = visível a todos. Com membros, só quem tá na
  // lista (+ admin) enxerga a aba. Filtro no frontend só — reforço via RLS
  // fica pra quando eu vir as policies atuais de boards/board_lists/board_cards.
  const visibleBoards = useMemo(
    () =>
      boards.filter((b) => {
        const membros = boardMembersByBoard.get(b.id);
        if (!membros || membros.length === 0) return true;
        if (role === 'admin') return true;
        return userId ? membros.includes(userId) : false;
      }),
    [boards, boardMembersByBoard, role, userId],
  );

  // Drag de cartão.
  const [arrastandoCard, setArrastandoCard] = useState<string | null>(null);
  const [sobreLista, setSobreLista] = useState<string | null>(null);
  // Drag de lista (reordenar colunas).
  const [arrastandoLista, setArrastandoLista] = useState<string | null>(null);
  const [sobreListaHeader, setSobreListaHeader] = useState<string | null>(null);

  // Lembra o último quadro aberto — quem usa quadro volta sempre ao mesmo.
  useEffect(() => {
    if (visibleBoards.length === 0) return;
    const salvo = localStorage.getItem(STORAGE_KEY);
    const existe = salvo && visibleBoards.some((b) => b.id === salvo);
    setBoardId((atual) => atual ?? (existe ? salvo : visibleBoards[0].id));
  }, [visibleBoards]);

  useEffect(() => {
    if (boardId) localStorage.setItem(STORAGE_KEY, boardId);
  }, [boardId]);

  const cardsPorLista = useMemo(() => {
    const m = new Map<string, BoardCard[]>();
    for (const l of lists) m.set(l.id, []);
    for (const c of cards) m.get(c.list_id)?.push(c);
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [lists, cards]);

  const cardAberto = useMemo(() => cards.find((c) => c.id === openCardId) ?? null, [cards, openCardId]);

  // ---- Cartão: drop numa lista ------------------------------------------
  const soltarNaLista = async (listId: string) => {
    const cardId = arrastandoCard;
    setArrastandoCard(null);
    setSobreLista(null);
    if (!cardId) return;
    const atual = cards.find((c) => c.id === cardId);
    if (!atual || atual.list_id === listId) return;
    const destino = cardsPorLista.get(listId) ?? [];
    const ultimo = destino.length > 0 ? destino[destino.length - 1].position : null;
    try {
      await moveCard(cardId, listId, positionBetween(ultimo, null));
    } catch (e) {
      toast.error('Não consegui mover o cartão.', { description: e instanceof Error ? e.message : undefined });
    }
  };

  // ---- Lista: drop pra reordenar -----------------------------------------
  const soltarLista = async (destId: string) => {
    const origId = arrastandoLista;
    setArrastandoLista(null);
    setSobreListaHeader(null);
    if (!origId || origId === destId) return;
    const ordenadas = [...lists].sort((a, b) => a.position - b.position);
    const destIdx = ordenadas.findIndex((l) => l.id === destId);
    if (destIdx === -1) return;
    const antes = ordenadas[destIdx - 1]?.position ?? null;
    const depois = ordenadas[destIdx]?.position ?? null;
    try {
      await moveList(origId, positionBetween(antes, depois));
    } catch (e) {
      toast.error('Não consegui reordenar a lista.', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const criarCartao = async (listId: string, titulo: string) => {
    const destino = cardsPorLista.get(listId) ?? [];
    const ultimo = destino.length > 0 ? destino[destino.length - 1].position : null;
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('board_cards')
      .insert({ list_id: listId, title: titulo, position: positionBetween(ultimo, null) })
      .select('id, list_id, title, description, position, due_date, start_date, checklist, done, archived, cover_color')
      .single();
    if (err) {
      toast.error('Não consegui criar o cartão.', { description: err.message });
      return;
    }
    const novo = data as Omit<BoardCard, 'labelIds' | 'memberIds' | 'watcherIds' | 'checklists' | 'attachments' | 'activity'>;
    setCards((prev) => [...prev, { ...novo, labelIds: [], memberIds: [], watcherIds: [], checklists: [], attachments: [], activity: [] }]);
    const nomeLista = lists.find((l) => l.id === listId)?.name ?? '—';
    await supabase.from('card_activity').insert({
      card_id: novo.id, user_id: userId, kind: 'create',
      content: `Adicionou este cartão a "${nomeLista}"`,
    });
  };

  const criarLista = async (nome: string) => {
    if (!boardId) return;
    const ultima = lists.length > 0 ? lists[lists.length - 1].position : null;
    const { error: err } = await getSupabase()
      .from('board_lists')
      .insert({ board_id: boardId, name: nome, position: positionBetween(ultima, null) });
    if (err) { toast.error('Não consegui criar a lista.', { description: err.message }); return; }
    await reload();
  };

  // Patch direto em board_cards, com atualização otimista local.
  const patchCard = async (cardId: string, patch: Record<string, unknown>) => {
    const anterior = cards;
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, ...patch } as BoardCard : c)));
    const { error: err } = await getSupabase().from('board_cards').update(patch).eq('id', cardId);
    if (err) {
      setCards(anterior);
      toast.error('Não consegui salvar.', { description: err.message });
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-3 shrink-0 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg glass-card flex items-center justify-center">
            <KanbanSquare className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          <h1 className="text-lg font-bold text-display">Quadros</h1>
        </div>
        <Button variant="outline" onClick={() => setNovoQuadro(true)}>
          <Plus className="h-4 w-4" /> Novo quadro
        </Button>
      </div>

      {(errBoards || error) && (
        <LoadErrorBanner message={errBoards ?? error} onRetry={() => { void reloadBoards(); void reload(); }} />
      )}

      {/* Abas dos quadros */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 shrink-0">
        {visibleBoards.map((b) => {
          const membros = boardMembersByBoard.get(b.id);
          const restrito = Boolean(membros && membros.length > 0);
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setBoardId(b.id)}
              title={restrito ? 'Quadro restrito — só quem foi convidado vê' : undefined}
              className={cn(
                'shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                boardId === b.id
                  ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {restrito && <Users className="h-3 w-3" />}
              {b.name}
            </button>
          );
        })}
        {loadingBoards && <Skeleton className="h-7 w-24 shrink-0" />}
        {boardId && (
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <Users className="h-3.5 w-3.5" /> Compartilhar
          </button>
        )}
      </div>

      {/* Colunas */}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-3 h-full pb-2">
          {lists
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((l) => (
              <ListColumn
                key={l.id}
                list={l}
                cards={cardsPorLista.get(l.id) ?? []}
                labels={labels}
                operators={operators}
                currentUserId={userId}
                loading={loading}
                isDropTarget={sobreLista === l.id}
                isListDropTarget={sobreListaHeader === l.id}
                onCardDragStart={(cardId) => setArrastandoCard(cardId)}
                onCardDrop={() => { setSobreLista(l.id); void soltarNaLista(l.id); }}
                onListDragStart={() => setArrastandoLista(l.id)}
                onListDragOver={() => setSobreListaHeader(l.id)}
                onListDrop={() => void soltarLista(l.id)}
                onOpenCard={(cardId) => setOpenCardId(cardId)}
                onCreateCard={(titulo) => void criarCartao(l.id, titulo)}
                onListArchived={() => void reload()}
              />
            ))}

          {/* Nova lista */}
          {boardId && (
            <div className="w-[280px] shrink-0">
              {novaListaAberta ? (
                <NovaListaInput
                  onCreate={(nome) => { void criarLista(nome); setNovaListaAberta(false); }}
                  onCancel={() => setNovaListaAberta(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setNovaListaAberta(true)}
                  className="flex items-center gap-1.5 rounded-xl border border-dashed border-[var(--color-border-soft)] px-3 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)] w-full"
                >
                  <Plus className="h-4 w-4" /> Adicionar outra lista
                </button>
              )}
            </div>
          )}

          {boardId && lists.length === 0 && !loading && !novaListaAberta && (
            <p className="text-sm text-[var(--color-text-secondary)]">Este quadro ainda não tem colunas.</p>
          )}
        </div>
      </div>

      {cardAberto && boardId && (
        <CardModal
          card={cardAberto}
          boardId={boardId}
          lists={lists}
          labels={labels}
          operators={operators}
          currentUserId={userId}
          onClose={() => setOpenCardId(null)}
          onPatch={(patch) => patchCard(cardAberto.id, patch)}
          onReload={reload}
          onArchived={() => { setOpenCardId(null); void reload(); }}
          onDeleted={() => { setOpenCardId(null); setCards((prev) => prev.filter((c) => c.id !== cardAberto.id)); }}
        />
      )}

      {novoQuadro && (
        <NovoQuadroDialog onClose={() => setNovoQuadro(false)} onCreated={() => { setNovoQuadro(false); void reloadBoards(); }} />
      )}

      {shareOpen && boardId && (
        <ShareBoardDialog
          boardId={boardId}
          boardName={boards.find((b) => b.id === boardId)?.name ?? '—'}
          operators={operators}
          onClose={() => setShareOpen(false)}
          onChanged={() => void reloadBoardMembers()}
        />
      )}
    </div>
  );
}

function NovaListaInput({ onCreate, onCancel }: { onCreate: (nome: string) => void; onCancel: () => void }) {
  const [txt, setTxt] = useState('');
  const enviar = () => {
    const n = txt.trim();
    if (n) onCreate(n); else onCancel();
  };
  return (
    <input
      autoFocus
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') enviar();
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={enviar}
      placeholder="Nome da lista"
      className="w-full rounded-xl border border-[var(--accent-primary)] bg-[var(--color-fill-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--color-text-primary)]"
    />
  );
}

function NovoQuadroDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [salvando, setSalvando] = useState(false);

  const criar = async () => {
    if (!name.trim()) { toast.error('Dê um nome ao quadro.'); return; }
    setSalvando(true);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('boards')
      .insert({ name: name.trim(), position: Date.now() })
      .select('id')
      .single();
    if (err) {
      setSalvando(false);
      toast.error('Não consegui criar.', { description: err.message });
      return;
    }
    // Quadro nasce com as 3 colunas padrão — quadro vazio não serve pra nada.
    const boardId = (data as { id: string }).id;
    await supabase.from('board_lists').insert([
      { board_id: boardId, name: 'A fazer', position: 1000 },
      { board_id: boardId, name: 'Em andamento', position: 2000 },
      { board_id: boardId, name: 'Concluído', position: 3000 },
    ]);
    setSalvando(false);
    toast.success('Quadro criado.');
    onCreated();
  };

  return (
    <Dialog open onClose={onClose} title="Novo quadro">
      <div>
        <FieldLabel htmlFor="nb-name">Nome</FieldLabel>
        <input
          id="nb-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
          placeholder="Ex.: Obras, Marketing"
          className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
        />
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void criar()} disabled={salvando}>
          {salvando ? 'Criando...' : 'Criar'}
        </Button>
      </div>
    </Dialog>
  );
}
