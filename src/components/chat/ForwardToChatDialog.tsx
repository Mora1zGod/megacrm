import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, Send, Users } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useInternalChat } from '@/hooks/useInternalChat';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { chatTitle } from '@/types/chat';

interface ForwardToChatDialogProps {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  contactLabel: string;
}

// "Compartilhar com a equipe": manda o link da conversa do Inbox para uma sala
// do Chat Interno. O destino pode ser uma conversa que já existe ou um colega
// com quem ainda não há DM aberta (a DM é criada na hora).
export function ForwardToChatDialog({
  open, onClose, conversationId, contactLabel,
}: ForwardToChatDialogProps) {
  const navigate = useNavigate();
  const { userId } = useAppUser();
  const { chats, openDm } = useInternalChat();
  const { operators } = useOperators();
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  // 'chat:<id>' ou 'user:<id>' — um destino só, para não virar disparo interno.
  const [target, setTarget] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Colegas que ainda não têm DM na lista — evita oferecer o mesmo destino
  // duas vezes (uma como conversa, outra como pessoa).
  const dmPeers = useMemo(
    () => new Set(chats.filter((c) => c.kind === 'dm').map((c) => c.peer_user_id)),
    [chats],
  );

  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromChats = chats.map((c) => ({
      key: `chat:${c.chat_id}`,
      label: chatTitle(c),
      hint: c.kind === 'group' ? `${c.member_count} participantes` : 'Conversa direta',
      avatar: c.kind === 'dm' ? c.peer_avatar_url : null,
      isGroup: c.kind === 'group',
    }));
    const fromPeople = operators
      .filter((op) => op.user_id !== userId && !dmPeers.has(op.user_id))
      .map((op) => ({
        key: `user:${op.user_id}`,
        label: operatorLabel(op),
        hint: op.email,
        avatar: op.avatar_url,
        isGroup: false,
      }));
    return [...fromChats, ...fromPeople].filter(
      (o) => !q || o.label.toLowerCase().includes(q),
    );
  }, [chats, operators, userId, dmPeers, search]);

  const close = () => {
    setSearch('');
    setNote('');
    setTarget(null);
    onClose();
  };

  const send = async () => {
    if (!target || !userId) return;
    setSending(true);

    let chatId: string | null;
    if (target.startsWith('chat:')) {
      chatId = target.slice(5);
    } else {
      chatId = await openDm(target.slice(5));
    }
    if (!chatId) {
      setSending(false);
      toast.error('Não foi possível abrir a conversa de destino.');
      return;
    }

    const supabase = getSupabase();
    const body = note.trim()
      ? `${note.trim()}\n\n↪ Conversa com ${contactLabel}`
      : `↪ Conversa com ${contactLabel}`;
    // org_id fica de fora: quem preenche é o DEFAULT da coluna (JWT).
    const { error } = await supabase.from('chat_messages').insert({
      chat_id: chatId,
      sender_id: userId,
      content_type: 'text',
      content: body,
      ref_conversation_id: conversationId,
    });
    setSending(false);

    if (error) {
      toast.error('Falha ao compartilhar', { description: error.message });
      return;
    }
    const destino = chatId;
    toast.success('Conversa compartilhada com a equipe.', {
      action: { label: 'Abrir chat', onClick: () => navigate(`/chat?chat=${destino}`) },
    });
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Compartilhar com a equipe"
      description={`Manda o link desta conversa com ${contactLabel} para o Chat Interno.`}
      widthClass="max-w-md"
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-secondary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversa ou colega..."
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] pl-9 pr-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>

        <div className="max-h-56 space-y-1 overflow-y-auto">
          {options.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
              Nenhum destino encontrado.
            </div>
          ) : (
            options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setTarget(o.key)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                  target === o.key ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-white/5',
                )}
              >
                {o.isGroup ? (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
                    <Users className="h-4 w-4 text-[var(--accent-primary)]" />
                  </span>
                ) : (
                  <Avatar src={o.avatar} name={o.label} size="sm" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--color-text-primary)]">{o.label}</span>
                  <span className="block truncate text-[11px] text-[var(--color-text-secondary)]">{o.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div>
          <Label htmlFor="forward-note">Comentário (opcional)</Label>
          <textarea
            id="forward-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Ex.: dá uma olhada nessa, o cliente quer desconto"
            className="mt-1 w-full resize-none rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={() => void send()} disabled={!target || sending}>
            <Send className="h-4 w-4" />
            Compartilhar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
