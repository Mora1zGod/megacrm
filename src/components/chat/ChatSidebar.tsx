import { useMemo, useState } from 'react';
import { Plus, Search, Users } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { chatTitle, type ChatListItem } from '@/types/chat';

interface ChatSidebarProps {
  chats: ChatListItem[];
  loading: boolean;
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onNew: () => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function ChatSidebar({ chats, loading, activeChatId, onSelect, onNew }: ChatSidebarProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => chatTitle(c).toLowerCase().includes(q));
  }, [chats, search]);

  return (
    <aside className="flex w-full flex-col border-r border-[var(--color-border-card)] sm:w-[300px] sm:shrink-0">
      <div className="space-y-3 border-b border-[var(--color-border-card)] p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-label">Conversas</h2>
          <Button type="button" size="sm" variant="ghost" onClick={onNew}>
            <Plus className="h-3.5 w-3.5" />
            Nova
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-secondary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar..."
            className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] pl-9 pr-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
            <Users className="mx-auto mb-2 h-6 w-6 opacity-50" />
            {search
              ? 'Nenhuma conversa com esse nome.'
              : 'Nenhuma conversa ainda. Comece uma com “Nova”.'}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((chat) => {
              const title = chatTitle(chat);
              const active = chat.chat_id === activeChatId;
              return (
                <li key={chat.chat_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(chat.chat_id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                      active ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-fill-subtle)]',
                    )}
                  >
                    {chat.kind === 'group' ? (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-fill-subtle)]">
                        <Users className="h-4 w-4 text-[var(--accent-primary)]" />
                      </span>
                    ) : (
                      <Avatar src={chat.peer_avatar_url} name={title} size="sm" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            chat.unread_count > 0
                              ? 'font-semibold text-[var(--color-text-primary)]'
                              : 'text-[var(--color-text-primary)]',
                          )}
                        >
                          {title}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">
                          {relativeTime(chat.last_message_at)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
                          {chat.last_message_preview || 'Sem mensagens'}
                        </span>
                        {chat.unread_count > 0 && (
                          <span className="shrink-0 rounded-full bg-[var(--accent-fill)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {chat.unread_count > 99 ? '99+' : chat.unread_count}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
