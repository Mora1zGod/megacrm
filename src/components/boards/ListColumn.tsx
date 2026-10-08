import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Archive, ArrowLeftRight, MoreHorizontal, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { CardMini } from './CardMini';
import type { BoardCard, BoardList, Label } from '@/hooks/useBoards';
import type { Operator } from '@/hooks/useOperators';

interface ListColumnProps {
  list: BoardList;
  cards: BoardCard[];
  labels: Label[];
  operators: Operator[];
  currentUserId: string | null;
  isDropTarget: boolean;
  isListDropTarget: boolean;
  draggingCardId?: string | null;
  onCardDragStart: (cardId: string) => void;
  onCardDrop: (beforeCardId: string | null) => void;
  onCardDragOverList?: () => void;
  onListDragStart: () => void;
  onListDragOver: () => void;
  onListDrop: () => void;
  onOpenCard: (cardId: string) => void;
  onCreateCard: (title: string) => void;
  onListArchived: () => void;
  onMoveAllCards?: () => void;
  loading: boolean;
}

// Lista do quadro, no visual do Trello: título em cima (clique renomeia), cartões, "+ Adicionar um cartão".
export function ListColumn({
  list, cards, labels, operators, currentUserId, isDropTarget, isListDropTarget, draggingCardId,
  onCardDragStart, onCardDrop, onCardDragOverList, onListDragStart, onListDragOver, onListDrop,
  onOpenCard, onCreateCard, onListArchived, onMoveAllCards, loading,
}: ListColumnProps) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(list.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [overCard, setOverCard] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setName(list.name), [list.name]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenuOpen(false); setConfirmArchive(false); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const salvarNome = async () => {
    setEditingName(false);
    const n = name.trim();
    if (!n || n === list.name) { setName(list.name); return; }
    const { error } = await getSupabase().from('board_lists').update({ name: n }).eq('id', list.id);
    if (error) { toast.error('Não consegui renomear.', { description: error.message }); setName(list.name); }
  };

  const arquivarLista = async () => {
    const { error } = await getSupabase().from('board_lists').update({ archived: true }).eq('id', list.id);
    if (error) { toast.error('Não consegui arquivar.', { description: error.message }); return; }
    toast.success(`Lista "${list.name}" arquivada.`);
    onListArchived();
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!draggingCardId) onListDragOver(); else onCardDragOverList?.(); }}
      onDrop={(e) => { e.preventDefault(); if (draggingCardId) { onCardDrop(overCard); setOverCard(null); } else onListDrop(); }}
      className={cn(
        'flex max-h-full w-[272px] shrink-0 flex-col rounded-xl bg-[var(--board-list)] text-[var(--board-list-text)] shadow-[0_1px_1px_rgba(9,30,66,0.25)] transition-[outline]',
        isListDropTarget && 'outline outline-2 outline-[var(--accent-primary)]',
        isDropTarget && 'outline outline-2 outline-offset-0 outline-[var(--accent-primary)]',
      )}
    >
      <div draggable onDragStart={(e) => { e.stopPropagation(); onListDragStart(); }}
        className="flex cursor-grab items-start gap-1 px-2 pb-1 pt-2 active:cursor-grabbing">
        {editingName ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void salvarNome()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(list.name); setEditingName(false); } }}
            className="min-w-0 flex-1 rounded-md border-2 border-[var(--accent-primary)] bg-[var(--board-card)] px-2 py-1 text-sm font-semibold text-[var(--board-list-text)] outline-none" />
        ) : (
          <h3 onClick={() => setEditingName(true)} className="min-w-0 flex-1 cursor-text break-words rounded-md px-2 py-1 text-sm font-semibold leading-snug">{list.name}</h3>
        )}
        <span className="shrink-0 px-1 pt-1.5 text-xs text-[var(--board-list-muted)]">{cards.length}</span>
        <div ref={menuRef} className="relative shrink-0">
          <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="Ações da lista"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 text-[var(--color-text-primary)] shadow-[var(--shadow-lg)]">
              <div className="mb-1 flex items-center justify-between px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)]">
                Ações da lista <button type="button" aria-label="Fechar" onClick={() => setMenuOpen(false)}><X className="h-3.5 w-3.5" /></button>
              </div>
              <button type="button" onClick={() => { setMenuOpen(false); setAdding(true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]"><Plus className="h-4 w-4" /> Adicionar cartão</button>
              {onMoveAllCards && cards.length > 0 && (
                <button type="button" onClick={() => { setMenuOpen(false); onMoveAllCards(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]"><ArrowLeftRight className="h-4 w-4" /> Mover todos os cartões…</button>
              )}
              <div className="my-1 border-t border-[var(--color-border-soft)]" />
              {confirmArchive ? (
                <div className="space-y-2 px-2 py-1.5 text-sm">
                  <p>Arquivar "{list.name}"? Os {cards.length} cartão(ões) dela saem do quadro junto (dá para restaurar depois).</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void arquivarLista()} className="rounded-md bg-[var(--color-error)] px-3 py-1.5 text-xs font-semibold text-white">Arquivar</button>
                    <button type="button" onClick={() => setConfirmArchive(false)} className="rounded-md px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]">Cancelar</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmArchive(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]"><Archive className="h-4 w-4" /> Arquivar esta lista</button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={cn('min-h-[8px] flex-1 space-y-2 overflow-y-auto px-2 pb-1 pt-0.5', isDropTarget && !cards.length && 'min-h-[48px]')}>
        {cards.map((c) => (
          <div key={c.id} onDragOver={(e) => { if (draggingCardId && draggingCardId !== c.id) { e.preventDefault(); setOverCard(c.id); } }}
            className={cn(overCard === c.id && draggingCardId && 'border-t-[3px] border-[var(--accent-primary)] pt-1')}>
            <CardMini card={c} labels={labels} operators={operators} currentUserId={currentUserId} dragging={draggingCardId === c.id}
              onOpen={() => onOpenCard(c.id)} onDragStart={() => onCardDragStart(c.id)} />
          </div>
        ))}
        {cards.length === 0 && !loading && !adding && isDropTarget && <div className="h-10 rounded-lg bg-[var(--board-hover)]" />}
      </div>

      <NovoCartao open={adding} setOpen={setAdding} onCreate={onCreateCard} />
    </div>
  );
}

function NovoCartao({ open, setOpen, onCreate }: { open: boolean; setOpen: (v: boolean) => void; onCreate: (title: string) => void }) {
  const [txt, setTxt] = useState('');
  const enviar = (keepOpen: boolean) => {
    const t = txt.trim();
    if (t) onCreate(t);
    setTxt('');
    if (!keepOpen || !t) setOpen(keepOpen && Boolean(t));
  };
  if (!open) {
    return (
      <div className="px-2 pb-2 pt-1">
        <button type="button" onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--board-list-muted)] hover:bg-[var(--board-hover)] hover:text-[var(--board-list-text)]">
          <Plus className="h-4 w-4" /> Adicionar um cartão
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2 px-2 pb-2 pt-1">
      <textarea autoFocus rows={3} value={txt} onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(true); } if (e.key === 'Escape') { setOpen(false); setTxt(''); } }}
        placeholder="Insira um título ou cole um link"
        className="w-full resize-none rounded-lg bg-[var(--board-card)] px-3 py-2 text-sm text-[var(--board-card-text)] shadow-[0_1px_1px_rgba(9,30,66,0.25)] outline-none placeholder:text-[var(--board-card-muted)]" />
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => enviar(true)} className="rounded-md bg-[var(--accent-fill)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">Adicionar cartão</button>
        <button type="button" aria-label="Cancelar" onClick={() => { setOpen(false); setTxt(''); }} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--board-list-muted)] hover:bg-[var(--board-hover)]"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
