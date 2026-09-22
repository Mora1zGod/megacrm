import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Download, FileText, MessageSquareText, Pencil, Trash2, X } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/chatAttachments';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import type { ThreadChatMessage } from '@/types/chat';

interface ChatBubbleProps {
  message: ThreadChatMessage;
  mine: boolean;
  sender: Operator | undefined;
  // Rótulos dos participantes, para destacar as menções no texto.
  memberLabels: string[];
  // URL assinada do anexo (bucket privado) — undefined enquanto não assinou.
  attachmentUrl: string | undefined;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Destaca "@Fulano" no corpo da mensagem. Os rótulos vêm dos participantes da
// sala — assim "@" solto ou e-mail no meio do texto não vira menção falsa.
function renderWithMentions(content: string, memberLabels: string[]): ReactNode {
  const labels = memberLabels.filter(Boolean).sort((a, b) => b.length - a.length);
  if (labels.length === 0) return content;
  const pattern = new RegExp(`@(${labels.map(escapeRegExp).join('|')})`, 'g');
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match = pattern.exec(content);
  let key = 0;
  while (match !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));
    parts.push(
      <span
        key={`m-${key++}`}
        className="rounded px-1 font-semibold text-[var(--accent-primary)] bg-[var(--color-accent-subtle)]"
      >
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
    match = pattern.exec(content);
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function ChatBubble({
  message, mine, sender, memberLabels, attachmentUrl, onEdit, onDelete,
}: ChatBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(message.content ?? ''); }, [message.content]);

  // Eventos da sala (entrou, saiu, renomeou) são uma linha centralizada, não
  // um balão — não têm autor "falando".
  if (message.content_type === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-[var(--color-fill-subtle)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)]">
          {message.content}
        </span>
      </div>
    );
  }

  const deleted = message.deleted_at !== null;

  const commitEdit = async () => {
    const next = draft.trim();
    if (!next || next === message.content) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const ok = await onEdit(message.id, next);
    setBusy(false);
    if (ok) setEditing(false);
  };

  return (
    <div className={cn('flex gap-2.5', mine ? 'flex-row-reverse' : 'flex-row')}>
      <Avatar
        src={sender?.avatar_url}
        name={sender ? operatorLabel(sender) : null}
        size="sm"
        className="mt-1"
      />
      <div className={cn('group min-w-0 max-w-[75%]', mine && 'flex flex-col items-end')}>
        <div className="flex items-baseline gap-2 px-1">
          <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">
            {mine ? 'Você' : (sender ? operatorLabel(sender) : 'Membro')}
          </span>
          <span className="text-[10px] text-[var(--color-text-secondary)]">
            {timeLabel(message.created_at)}
          </span>
          {message.edited_at && !deleted && (
            <span className="text-[10px] text-[var(--color-text-secondary)] opacity-70">editada</span>
          )}
        </div>

        <div
          className={cn(
            'mt-0.5 rounded-2xl px-3.5 py-2 text-sm',
            mine
              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] rounded-tr-sm'
              : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-primary)] rounded-tl-sm',
            message._state === 'pending' && 'opacity-60',
            message._state === 'failed' && 'border border-[rgba(239,68,68,0.4)]',
          )}
        >
          {deleted ? (
            <span className="italic text-[var(--color-text-secondary)]">Mensagem apagada</span>
          ) : editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                autoFocus
                className="w-full min-w-[220px] rounded-lg border border-[rgba(14,154,160,0.25)] bg-black/20 px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)] resize-none"
              />
              <div className="flex items-center gap-1">
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={busy}>
                  <Check className="h-3.5 w-3.5" />
                  Salvar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  <X className="h-3.5 w-3.5" />
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <>
              {message.content_type === 'image' && message.media_path && (
                attachmentUrl ? (
                  <a href={attachmentUrl} target="_blank" rel="noreferrer">
                    <img
                      src={attachmentUrl}
                      alt={message.media_name ?? 'imagem'}
                      className="mb-1 max-h-64 rounded-lg object-cover"
                    />
                  </a>
                ) : (
                  <div className="mb-1 h-32 w-48 animate-pulse rounded-lg bg-[var(--color-fill-subtle)]" />
                )
              )}

              {message.content_type === 'file' && message.media_path && (
                <a
                  href={attachmentUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!attachmentUrl}
                  className={cn(
                    'mb-1 flex items-center gap-2 rounded-lg bg-black/20 px-2.5 py-2',
                    !attachmentUrl && 'pointer-events-none opacity-60',
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {message.media_name ?? 'arquivo'}
                    </span>
                    <span className="block text-[10px] text-[var(--color-text-secondary)]">
                      {formatBytes(message.media_size)}
                    </span>
                  </span>
                  <Download className="ml-1 h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                </a>
              )}

              {message.ref_conversation_id && (
                <Link
                  to={`/inbox?conversation=${message.ref_conversation_id}`}
                  className="mb-1 flex items-center gap-2 rounded-lg border border-[rgba(14,154,160,0.25)] bg-black/20 px-2.5 py-2 hover:border-[var(--accent-primary)]"
                >
                  <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  <span className="text-xs font-medium text-[var(--accent-primary)]">
                    Abrir conversa no Inbox
                  </span>
                </Link>
              )}

              {message.content && (
                <p className="whitespace-pre-wrap break-words">
                  {renderWithMentions(message.content, memberLabels)}
                </p>
              )}
            </>
          )}
        </div>

        {message._state === 'failed' && (
          <span className="px-1 text-[10px] text-[var(--color-error)]">Não enviou</span>
        )}

        {/* Ações do autor: só no hover, e nunca em mensagem já apagada. */}
        {mine && !deleted && !editing && !message._tempId && (
          <div className="mt-0.5 flex items-center gap-0.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
            {message.content !== null && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                aria-label="Editar mensagem"
                title="Editar"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => { void onDelete(message.id); }}
              className="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
              aria-label="Apagar mensagem"
              title="Apagar"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
