import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, CornerUpRight, Loader2, Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';
import { formatPhoneDisplay } from '@/lib/phone';
import type { ConversationWithContact, Message } from '@/types/inbox';

const MAX_TARGETS = 5;

function preview(m: Message): string {
  if (m.content_type === 'text' || m.content_type === 'template') return m.content ?? '';
  const label = { image: '📷 Imagem', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📄 Documento' }[m.content_type as string] ?? 'Mídia';
  return m.content ? `${label} · ${m.content}` : label;
}

function isMedia(m: Message): boolean {
  return !['text', 'template', 'note'].includes(m.content_type);
}

// Envia UMA mensagem para UMA conversa. Texto sai pelo send-operator-message;
// mídia pelo send-operator-media com forward_message_id (o servidor baixa o
// arquivo original e reenvia).
async function forwardOne(message: Message, convId: string): Promise<void> {
  const supabase = getSupabase();
  if (isMedia(message)) {
    const form = new FormData();
    form.append('conversation_id', convId);
    form.append('forward_message_id', message.id);
    if (message.content?.trim() && message.content_type !== 'audio') form.append('content', message.content.trim());
    const { data, error } = await supabase.functions.invoke('send-operator-media', { body: form });
    if (error || !data?.ok) throw new Error(await extractFunctionErrorMessage(error, data?.error));
    return;
  }
  const { data, error } = await supabase.functions.invoke('send-operator-message', {
    body: { conversation_id: convId, content: message.content ?? '', forwarded: true },
  });
  if (error || !data?.ok) throw new Error(await extractFunctionErrorMessage(error, data?.error));
  if (data.zernio_error) throw new Error(data.zernio_error as string);
}

// Encaminhar uma ou várias mensagens (na ordem em que foram enviadas) para até
// 5 conversas.
export function ForwardMessageDialog({ messages, conversations, currentConversationId, onClose }: {
  messages: Message[];
  conversations: ConversationWithContact[];
  currentConversationId: string | null;
  onClose: (sent: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');
    return conversations
      .filter((c) => c.id !== currentConversationId && c.status !== 'closed' && !(c.contact?.phone ?? '').endsWith('@g.us'))
      .filter((c) => {
        if (!term) return true;
        const name = (c.contact?.name ?? '').toLowerCase();
        const phone = (c.contact?.phone ?? '').replace(/\D/g, '');
        return name.includes(term) || (digits.length > 0 && phone.includes(digits));
      })
      .slice(0, 60);
  }, [conversations, currentConversationId, q]);

  const toggle = (id: string) => {
    setPicked((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_TARGETS) { toast.info(`Até ${MAX_TARGETS} conversas por vez.`); return cur; }
      return [...cur, id];
    });
  };

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const many = messages.length > 1;

  const send = async () => {
    if (!picked.length) return;
    setSending(true);
    const total = picked.length * messages.length;
    let done = 0;
    let okConvs = 0;
    const failures: string[] = [];
    setProgress({ done, total });
    for (const convId of picked) {
      const conv = conversations.find((c) => c.id === convId);
      const who = conv?.contact?.name || conv?.contact?.phone || 'contato';
      let convFailed = 0;
      // Uma de cada vez, na ordem original — assim chegam na sequência certa.
      for (const m of messages) {
        try {
          await forwardOne(m, convId);
        } catch (e) {
          convFailed++;
          const what = many ? ` (${preview(m).slice(0, 40) || 'mensagem'})` : '';
          failures.push(`${who}${what}: ${e instanceof Error ? e.message : String(e)}`);
        }
        setProgress({ done: ++done, total });
      }
      if (convFailed < messages.length) okConvs++;
    }
    setSending(false);
    setProgress(null);
    const noun = many ? `${messages.length} mensagens encaminhadas` : 'Mensagem encaminhada';
    if (okConvs) toast.success(okConvs === 1 ? `${noun}.` : `${noun} para ${okConvs} conversas.`);
    if (failures.length) toast.error('Algumas não foram entregues', { description: failures.slice(0, 6).join('\n') });
    if (!failures.length) onClose(true);
  };

  return (
    <Dialog open onClose={() => onClose(false)} title={many ? `Encaminhar ${messages.length} mensagens` : 'Encaminhar mensagem'} description="Escolha até 5 conversas.">
      <div className="mb-3 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
        {messages.map((m) => (
          <div key={m.id} className={cn('whitespace-pre-wrap break-words', many ? 'line-clamp-1' : 'line-clamp-3')}>{preview(m) || '—'}</div>
        ))}
      </div>
      <label className="relative mb-2 block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou telefone" aria-label="Buscar conversa"
          className="h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] pl-8 pr-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
      </label>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto">
        {list.length === 0 && <li className="px-2 py-4 text-center text-sm text-[var(--color-text-muted)]">Nenhuma conversa encontrada.</li>}
        {list.map((c) => {
          const name = c.contact?.name?.trim() || c.contact?.phone || '—';
          const on = picked.includes(c.id);
          return (
            <li key={c.id}>
              <button type="button" onClick={() => toggle(c.id)} aria-pressed={on}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                  on ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-surface-hover)]')}>
                <Avatar src={c.contact?.profile_pic_url} name={name} size="sm" className="!h-8 !w-8" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{name}</span>
                  {c.contact?.phone && <span className="block truncate text-xs text-[var(--color-text-muted)]">{formatPhoneDisplay(c.contact.phone)}</span>}
                </span>
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full border-2',
                  on ? 'border-[var(--accent-fill)] bg-[var(--accent-fill)] text-white' : 'border-[var(--color-border-card)]')}>
                  {on && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 pt-4">
        <span className="text-xs text-[var(--color-text-muted)]">
          {progress ? `Enviando ${progress.done}/${progress.total}…` : `${picked.length}/${MAX_TARGETS} selecionadas`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onClose(false)} disabled={sending}>Cancelar</Button>
          <Button onClick={() => void send()} disabled={!picked.length || sending}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CornerUpRight className="h-4 w-4" />}
            Encaminhar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
