import { Bot, Inbox, Instagram, Lock, MessageCircle, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/skeleton';
import type { WhatsappProvider } from '@/hooks/useWhatsappProvider';
import type { ConversationChannel, ConversationWithContact } from '@/types/inbox';

// Badge de canal/provedor: WhatsApp Meta (oficial), UAZAPI (não oficial, sem
// janela de 24h) ou Instagram. Quando o número do canal é conhecido, mostra o
// telefone em vez do nome genérico do provedor — útil pra diferenciar quando
// há mais de um número conectado (ex.: vários canais UAZAPI).
function channelBadge(
  channel: ConversationChannel | undefined,
  provider: WhatsappProvider,
  channelPhone: string | null,
  channelLabel: string | null,
) {
  if (channel === 'instagram') {
    return { Icon: Instagram, label: 'Instagram', chip: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]' };
  }
  const phoneLabel = channelPhone || channelLabel;
  if (provider === 'uazapi') {
    return {
      Icon: MessageCircle,
      label: phoneLabel || 'UAZAPI',
      chip: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]',
    };
  }
  return {
    Icon: MessageCircle,
    label: phoneLabel || 'WhatsApp',
    chip: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]',
  };
}

interface ConversationListProps {
  conversations: ConversationWithContact[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  aiEnabledForChannel?: (channel: string | null) => boolean;
  operatorName?: (userId: string | null) => string | null;
  isLocked?: (conv: ConversationWithContact) => boolean;
  providerOf?: (conv: ConversationWithContact) => WhatsappProvider;
}

function statusChip(c: ConversationWithContact, aiEnabled: boolean, assignedName: string | null) {
  if (c.status === 'closed') {
    return { Icon: Inbox, label: 'Fechada', className: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]' };
  }
  if (assignedName) {
    return { Icon: User, label: assignedName, className: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]' };
  }
  if (c.status === 'ai_active' && aiEnabled) {
    return { Icon: Bot, label: 'AMAIA', className: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' };
  }
  return { Icon: User, label: 'Não atribuído', className: 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]' };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function ConversationList({
  conversations,
  loading,
  selectedId,
  onSelect,
  aiEnabledForChannel,
  operatorName,
  isLocked,
  providerOf,
}: ConversationListProps) {
  if (loading) {
    return (
      <div className="space-y-1 px-2 py-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
            <Skeleton className="h-10 w-10 rounded-full shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5 pt-0.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="text-sm font-medium text-[var(--color-text-primary)] mb-1">Nenhuma conversa ainda</div>
        <p className="text-xs text-[var(--color-text-secondary)] max-w-[240px] mx-auto">
          Conversas aparecem aqui assim que um contato enviar a primeira mensagem.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2 py-2">
      {conversations.map((c) => {
        const locked = isLocked?.(c) ?? false;
        const assignedName = operatorName?.(c.assigned_to) ?? null;
        const aiEnabled = aiEnabledForChannel?.(c.channel ?? null) ?? true;
        const status = statusChip(c, aiEnabled, assignedName);
        const StatusIcon = status.Icon;
        const chan = channelBadge(
          c.channel,
          providerOf?.(c) ?? (c.channel === 'instagram' ? 'instagram' : 'meta'),
          c.channelPhone,
          c.channelLabel,
        );
        const isActive = c.id === selectedId;
        const contact = c.contact;
        const displayName = contact?.name?.trim() || contact?.phone || '—';

        return (
          <button
            key={c.id}
            type="button" aria-pressed={isActive} disabled={locked}
            onClick={() => { if (!locked) onSelect(c.id); }}
            title={locked ? `Conversa atribuída a ${assignedName ?? 'outro operador'}` : undefined}
            className={cn(
              'inbox-conversation-row w-full text-left rounded-[var(--radius-card)] px-3 py-2.5 transition-colors duration-150 border',
              locked
                ? 'opacity-50 cursor-not-allowed border-transparent'
                : isActive
                  ? 'bg-[var(--color-accent-subtle)] border-[var(--accent-primary)]'
                  : 'border-transparent hover:bg-[var(--color-surface-hover)]',
            )}
          >
            <div className="flex items-start gap-2.5">
              <div className="relative shrink-0">
                <Avatar src={contact?.profile_pic_url} name={displayName} size="md" />
                {c.is_favorite && (
                  <span className="absolute -top-1 -right-1 text-[10px]">⭐</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                    {displayName}
                  </span>
                  <span className="text-[11px] text-[var(--color-text-secondary)] shrink-0 inline-flex items-center gap-1">
                    {locked && <Lock className="h-3 w-3" />}
                    {formatTimestamp(c.last_message_at)}
                  </span>
                </div>
                <p className="text-sm text-[var(--color-text-secondary)] truncate mt-1">
                  {locked ? <span className="italic opacity-70">Conversa em atendimento</span> : (c.lastMessagePreview ?? '—')}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', chan.chip)}>
                    <chan.Icon className="h-2.5 w-2.5" /> {chan.label}
                  </span>
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', status.className)}>
                    <StatusIcon className="h-2.5 w-2.5" /> {status.label}
                  </span>
                  {c.ai_paused && aiEnabled && (
                    <span className="inline-flex items-center rounded-full bg-[var(--color-fill-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
                      AMAIA pausada
                    </span>
                  )}
                  {c.unread_count > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-[var(--accent-primary)] px-2 py-0.5 text-[10px] font-bold text-white">
                      {c.unread_count}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
