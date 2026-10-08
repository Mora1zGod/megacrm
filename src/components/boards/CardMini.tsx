import { AlignLeft, CheckSquare, Clock, Eye, MessageSquare, Paperclip } from 'lucide-react';
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
  dragging?: boolean;
  // Nome da lista (A fazer, Em andamento…) — usado na tela "Todos os quadros", onde a coluna é o quadro.
  listName?: string;
}

// Situação do prazo, como no Trello: vencido (vermelho), vence em 24 h (âmbar), concluído (verde).
export function dueState(card: Pick<BoardCard, 'due_date' | 'done'>): 'done' | 'late' | 'soon' | 'ok' | null {
  if (!card.due_date) return null;
  if (card.done) return 'done';
  const t = new Date(card.due_date).getTime() - Date.now();
  if (t < 0) return 'late';
  if (t < 24 * 3600 * 1000) return 'soon';
  return 'ok';
}
export const DUE_CLS = {
  done: 'bg-[#1F845A] text-white',
  late: 'bg-[#C9372C] text-white',
  soon: 'bg-[#F5CD47] text-[#172B4D]',
  ok: 'text-[var(--color-text-secondary)]',
} as const;

export function CardMini({ card, labels, operators, currentUserId, onOpen, onDragStart, dragging, listName }: CardMiniProps) {
  const cardLabels = card.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  const checklistTotal = card.checklists.reduce((s, cl) => s + cl.items.length, 0);
  const checklistDone = card.checklists.reduce((s, cl) => s + cl.items.filter((i) => i.done).length, 0);
  const commentCount = card.activity.filter((a) => a.kind === 'comment').length;
  const attachmentCount = card.attachments.length;
  const isWatching = currentUserId ? card.watcherIds.includes(currentUserId) : false;
  const members = card.memberIds.map((id) => operators.find((o) => o.user_id === id)).filter(Boolean) as Operator[];
  const due = dueState(card);
  const hasBadges = isWatching || card.description || due || checklistTotal > 0 || commentCount > 0 || attachmentCount > 0 || members.length > 0;

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      role="button"
      tabIndex={0}
      className={cn(
        'group cursor-pointer overflow-hidden rounded-lg bg-[var(--board-card,#FFFFFF)] text-[var(--board-card-text,#172B4D)] shadow-[0_1px_1px_rgba(9,30,66,0.25),0_0_1px_rgba(9,30,66,0.31)] outline-none ring-[var(--accent-primary)] transition-shadow hover:ring-2 focus-visible:ring-2',
        dragging && 'rotate-2 opacity-60',
      )}
    >
      {card.cover_color && <div className="h-8 w-full" style={{ background: card.cover_color }} />}
      <div className="space-y-1.5 px-3 py-2">
        {cardLabels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {cardLabels.map((l) => (
              <span key={l.id} title={l.name ?? undefined}
                className={cn('inline-flex h-2 min-w-[40px] items-center rounded-full', l.name && 'h-4 px-2 text-[10px] font-semibold leading-none text-white')}
                style={{ background: l.color }}>
                {l.name ? <span className="truncate">{l.name}</span> : null}
              </span>
            ))}
          </div>
        )}
        {listName && <span className="inline-block rounded bg-[var(--board-hover,rgba(9,30,66,0.08))] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--board-card-muted,#44546F)]">{listName}</span>}
        <div className={cn('break-words text-sm leading-snug', card.done && 'text-[var(--board-card-muted,#626F86)] line-through')}>{card.title}</div>

        {hasBadges && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--board-card-muted,#44546F)]">
            {isWatching && <span title="Você está seguindo"><Eye className="h-3.5 w-3.5" /></span>}
            {due && (
              <span className={cn('inline-flex items-center gap-1 rounded px-1 py-0.5', DUE_CLS[due])} title={due === 'late' ? 'Prazo vencido' : due === 'soon' ? 'Vence em breve' : due === 'done' ? 'Concluído' : 'Prazo'}>
                <Clock className="h-3 w-3" />
                {new Date(card.due_date!).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '')}
              </span>
            )}
            {card.description && <span title="Este cartão tem descrição"><AlignLeft className="h-3.5 w-3.5" /></span>}
            {commentCount > 0 && <span className="inline-flex items-center gap-0.5" title="Comentários"><MessageSquare className="h-3.5 w-3.5" /> {commentCount}</span>}
            {attachmentCount > 0 && <span className="inline-flex items-center gap-0.5" title="Anexos"><Paperclip className="h-3.5 w-3.5" /> {attachmentCount}</span>}
            {checklistTotal > 0 && (
              <span className={cn('inline-flex items-center gap-0.5 rounded px-1 py-0.5', checklistDone === checklistTotal && 'bg-[#1F845A] text-white')} title="Checklist">
                <CheckSquare className="h-3.5 w-3.5" /> {checklistDone}/{checklistTotal}
              </span>
            )}
            {members.length > 0 && (
              <span className="ml-auto flex -space-x-1.5">
                {members.slice(0, 4).map((m) => (
                  <Avatar key={m.user_id} src={m.avatar_url} name={m.display_name ?? m.email} className="h-6 w-6 text-[10px] ring-2 ring-[var(--board-card,#FFFFFF)]" />
                ))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
