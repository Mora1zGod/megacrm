import { AlignLeft, CheckSquare, Eye, MessageSquare, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';
import type { BoardCard, Label } from '@/hooks/useBoards';
import type { Operator } from '@/hooks/useOperators';

interface CardMiniProps {
  card: BoardCard;
  labels: Label[];
  operators: Operator[];
  currentUserId: string | null;
  onOpen: () => void;
  onDragStart: () => void;
}

export function CardMini({ card, labels, operators, currentUserId, onOpen, onDragStart }: CardMiniProps) {
  const cardLabels = card.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  const checklistTotal = card.checklists.reduce((s, cl) => s + cl.items.length, 0);
  const checklistDone = card.checklists.reduce((s, cl) => s + cl.items.filter((i) => i.done).length, 0);
  const commentCount = card.activity.filter((a) => a.kind === 'comment').length;
  const attachmentCount = card.attachments.length;
  const isWatching = currentUserId ? card.watcherIds.includes(currentUserId) : false;
  const members = card.memberIds.map((id) => operators.find((o) => o.user_id === id)).filter(Boolean) as Operator[];
  const atrasado = card.due_date && !card.done && new Date(card.due_date) < new Date();

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        'cursor-pointer overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] hover:border-[var(--accent-primary)]',
        card.done && 'opacity-60',
      )}
    >
      {/* Barra de etiquetas coloridas no topo */}
      {cardLabels.length > 0 && (
        <div className="flex h-1.5 w-full">
          {cardLabels.map((l) => (
            <span key={l.id} className="flex-1" style={{ background: l.color }} title={l.name ?? undefined} />
          ))}
        </div>
      )}

      <div className="p-2 text-xs space-y-1.5">
        <div className={cn('leading-snug', card.done && 'line-through opacity-70')}>{card.title}</div>

        <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
          {isWatching && <span title="Você está observando"><Eye className="h-3 w-3" /></span>}
          {card.description && <span title="Tem descrição"><AlignLeft className="h-3 w-3" /></span>}
          {(card.due_date || card.start_date) && (
            <span className={cn('inline-flex items-center gap-0.5', atrasado && 'text-[#F87171] font-semibold')}>
              {new Date(card.due_date ?? card.start_date!).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
            </span>
          )}
          {checklistTotal > 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5',
                checklistDone === checklistTotal && 'text-[var(--color-success)]',
              )}
            >
              <CheckSquare className="h-3 w-3" /> {checklistDone}/{checklistTotal}
            </span>
          )}
          {commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <MessageSquare className="h-3 w-3" /> {commentCount}
            </span>
          )}
          {attachmentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Paperclip className="h-3 w-3" /> {attachmentCount}
            </span>
          )}
          {members.length > 0 && (
            <span className="ml-auto flex -space-x-1.5">
              {members.slice(0, 3).map((m) => (
                <Avatar
                  key={m.user_id}
                  src={m.avatar_url}
                  name={m.display_name ?? m.email}
                  className="h-5 w-5 text-[9px] ring-2 ring-[#062720]"
                />
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
