import { Bot, Inbox, Instagram, Lock, MessageCircle, PauseCircle, User, Users } from 'lucide-react';
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
    <div className="space-y-0.5 px-2 pb-2">
      {conversations.map((c) => {
        const locked = isLocked?.(c) ?? false;
        const assignedName = operatorName?.(c.assigned_to) ?? null;
        const aiEnabled = aiEnabledForChannel?.(c.channel ?? null) ?? true;
        const status = statusChip(c, aiEnabled, assignedName);
        const StatusIcon = status.Icon;
        const isGroup = (c.contact?.phone ?? '').endsWith('@g.us');
        const chan = channelBadge(
          c.channel,
          providerOf?.(c) ?? (c.channel === 'instagram' ? 'instagram' : 'meta'),
          c.channelPhone,
          c.channelLabel,
        );
        const isActive = c.id === selectedId;
        const contact = c.contact;
        const displayName = contact?.name?.trim() || (isGroup ? 'Grupo' : contact?.phone) || '—';

        const unread = c.unread_count > 0;
        const isInstagram = c.channel === 'instagram';

        return (
          <button
            key={c.id}
            type="button" aria-pressed={isActive} disabled={locked}
            onClick={() => { if (!locked) onSelect(c.id); }}
            title={locked ? `Conversa atribuída a ${assignedName ?? 'outro operador'}` : undefined}
            className={cn(
              'inbox-conversation-row w-full text-left transition-colors duration-150',
              locked && 'opacity-50 cursor-not-allowed',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="relative shrink-0">
                <Avatar src={contact?.profile_pic_url} name={displayName} size="md" className="!h-12 !w-12" />
                {c.is_favorite && (
                  <span className="absolute -top-1 -right-1 text-[10px]">⭐</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-semibold text-[var(--color-text-primary)] truncate">
                    {displayName}
                  </span>
                  <span className={cn('text-xs shrink-0 inline-flex items-center gap-1', unread ? 'font-semibold text-[var(--accent-primary)]' : 'text-[var(--color-text-muted)]')}>
                    {locked && <Lock className="h-3 w-3" />}
                    {formatTimestamp(c.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className={cn('flex-1 truncate text-[13.5px]', unread ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]')}>
                    {locked ? <span className="italic opacity-70">Conversa em atendimento</span> : (c.lastMessagePreview ?? '—')}
                  </p>
                  {unread && (
                    <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] px-1.5 text-[11px] font-bold text-white">
                      {c.unread_count}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                    {isInstagram
                      ? <Instagram className="h-3 w-3 text-[#E1306C]" />
                      : <MessageCircle className="h-3 w-3 text-[var(--inbox-wa,#25D366)]" />}
                    {isInstagram ? 'Instagram' : chan.label}
                  </span>
                  {isGroup && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-fill-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                      <Users className="h-3 w-3" /> Grupo
                    </span>
                  )}
                  {!isGroup && c.ai_paused && aiEnabled && c.status !== 'closed' ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[rgba(245,158,11,0.14)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--inbox-warn-text)]">
                      <PauseCircle className="h-3 w-3" /> AMAIA pausada
                    </span>
                  ) : !isGroup && (
                    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', status.className)}>
                      <StatusIcon className="h-3 w-3" /> {status.label}
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
