import { useState } from 'react';
import { toast } from 'sonner';
import { Archive, MoreHorizontal, Plus } from 'lucide-react';
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
  onCardDragStart: (cardId: string) => void;
  onCardDrop: () => void;
  onListDragStart: () => void;
  onListDragOver: () => void;
  onListDrop: () => void;
  onOpenCard: (cardId: string) => void;
  onCreateCard: (title: string) => void;
  onListArchived: () => void;
  loading: boolean;
}

export function ListColumn({
  list, cards, labels, operators, currentUserId, isDropTarget, isListDropTarget,
  onCardDragStart, onCardDrop, onListDragStart, onListDragOver, onListDrop,
  onOpenCard, onCreateCard, onListArchived, loading,
}: ListColumnProps) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(list.name);
  const [menuOpen, setMenuOpen] = useState(false);

  const salvarNome = async () => {
    setEditingName(false);
    const n = name.trim();
    if (!n || n === list.name) { setName(list.name); return; }
    const { error } = await getSupabase().from('board_lists').update({ name: n }).eq('id', list.id);
    if (error) { toast.error('Não consegui renomear.', { description: error.message }); setName(list.name); return; }
  };

  const arquivarLista = async () => {
    if (!confirm(`Arquivar a lista "${list.name}"? Os cartões dela somem do quadro junto.`)) return;
    const { error } = await getSupabase().from('board_lists').update({ archived: true }).eq('id', list.id);
    if (error) { toast.error('Não consegui arquivar.', { description: error.message }); return; }
    onListArchived();
  };

  return (
    <div
      draggable
      onDragStart={(e) => { e.stopPropagation(); onListDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onListDragOver(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onListDrop(); }}
      className={cn(
        'w-[280px] shrink-0 flex flex-col rounded-xl border p-2 transition-colors max-h-full',
        isListDropTarget
          ? 'border-[var(--accent-secondary,#F2B937)] bg-[rgba(242,185,55,0.05)]'
          : 'border-[var(--color-border-soft)]',
      )}
    >
      <div className="flex items-center justify-between gap-1 px-1 pb-2 shrink-0 cursor-grab active:cursor-grabbing">
        {editingName ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void salvarNome()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setName(list.name); setEditingName(false); }
            }}
            className="min-w-0 flex-1 rounded-md border border-[var(--accent-primary)] bg-white/[0.03] px-1.5 py-0.5 text-xs font-bold text-[var(--color-text-primary)]"
          />
        ) : (
          <span
            onClick={() => setEditingName(true)}
            className="min-w-0 flex-1 truncate cursor-text rounded-md px-1 text-xs font-bold text-display hover:bg-white/5"
          >
            {list.name}
          </span>
        )}
        <span className="shrink-0 text-[0.65rem] text-[var(--color-text-secondary)]">{cards.length}</span>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Opções da lista"
            className="h-6 w-6 flex items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 rounded-lg border border-[rgba(14,154,160,0.25)] bg-[#0F1223] p-1 shadow-lg z-10">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); void arquivarLista(); }}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:bg-white/5"
              >
                <Archive className="h-3.5 w-3.5" /> Arquivar lista
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onCardDrop(); }}
        className={cn(
          'flex-1 min-h-[40px] overflow-y-auto space-y-1.5 rounded-lg transition-colors',
          isDropTarget && 'bg-[rgba(14,154,160,0.06)] ring-1 ring-[var(--accent-primary)]',
        )}
      >
        {cards.map((c) => (
          <CardMini
            key={c.id}
            card={c}
            labels={labels}
            operators={operators}
            currentUserId={currentUserId}
            onOpen={() => onOpenCard(c.id)}
            onDragStart={() => onCardDragStart(c.id)}
          />
        ))}
        {cards.length === 0 && !loading && (
          <p className="px-1 py-3 text-[0.7rem] text-[var(--color-text-secondary)]">
            Nada aqui. Arraste um cartão ou crie abaixo.
          </p>
        )}
      </div>

      <NovoCartao onCreate={onCreateCard} />
    </div>
  );
}

function NovoCartao({ onCreate }: { onCreate: (title: string) => void }) {
  const [aberto, setAberto] = useState(false);
  const [txt, setTxt] = useState('');

  const enviar = () => {
    const t = txt.trim();
    if (t) onCreate(t);
    setTxt('');
    setAberto(false);
  };

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="mt-1.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)] shrink-0"
      >
        <Plus className="h-3.5 w-3.5" /> Adicionar um cartão
      </button>
    );
  }

  return (
    <div className="mt-1.5 shrink-0">
      <textarea
        autoFocus
        rows={2}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
          if (e.key === 'Escape') { setAberto(false); setTxt(''); }
        }}
        onBlur={enviar}
        placeholder="Título do cartão"
        className="w-full rounded-lg border border-[rgba(14,154,160,0.25)] bg-white/[0.03] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
      />
    </div>
  );
}
