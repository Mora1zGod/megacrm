import { useEffect, useMemo, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { signChatAttachments } from '@/lib/chatAttachments';
import type { Operator } from '@/hooks/useOperators';
import type { ThreadChatMessage } from '@/types/chat';
import { ChatBubble } from './ChatBubble';

interface ChatThreadProps {
  messages: ThreadChatMessage[];
  userId: string | null;
  operatorsById: Map<string, Operator>;
  memberLabels: string[];
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Hoje';
  if (sameDay(date, yesterday)) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export function ChatThread({
  messages, userId, operatorsById, memberLabels,
  loading, hasOlder, loadingOlder, loadOlder, onEdit, onDelete,
}: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<Record<string, string>>({});

  // Anexos vivem em bucket privado: assina em LOTE os paths visíveis em vez de
  // uma requisição por balão.
  const paths = useMemo(
    () => messages.map((m) => m.media_path).filter((p): p is string => Boolean(p)),
    [messages],
  );
  const pathsKey = paths.join('|');

  useEffect(() => {
    if (paths.length === 0) return;
    let cancelled = false;
    void (async () => {
      const signed = await signChatAttachments(paths);
      if (!cancelled) setAttachments((prev) => ({ ...prev, ...signed }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  // Rola para o fim quando chega mensagem nova (ou ao trocar de sala).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (loading) {
    return (
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center text-sm text-[var(--color-text-secondary)]">
          <MessagesSquare className="mx-auto mb-2 h-6 w-6 opacity-50" />
          Nenhuma mensagem ainda. Diga oi para a equipe.
        </div>
      </div>
    );
  }

  let lastDay = '';

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {hasOlder && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={loadingOlder}
          className="mx-auto block rounded-full border border-[rgba(14,154,160,0.2)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-60"
        >
          {loadingOlder ? 'Carregando...' : 'Carregar mensagens anteriores'}
        </button>
      )}

      {messages.map((message) => {
        const day = dayLabel(message.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <div key={message._tempId ?? message.id} className="space-y-3">
            {showDay && (
              <div className="flex justify-center">
                <span className="rounded-full bg-[var(--color-fill-subtle)] px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {day}
                </span>
              </div>
            )}
            <ChatBubble
              message={message}
              mine={message.sender_id === userId}
              sender={operatorsById.get(message.sender_id)}
              memberLabels={memberLabels}
              attachmentUrl={message.media_path ? attachments[message.media_path] : undefined}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
