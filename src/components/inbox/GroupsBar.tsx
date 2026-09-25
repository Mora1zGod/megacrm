import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';

// Aba Grupos do Inbox. Grupos só existem nos números UAZAPI (API não
// oficial); a API oficial da Meta não entrega mensagens de grupo.
// O botão (admin) liga o recebimento de grupos no webhook do número e traz
// as mensagens dos grupos dos últimos 7 dias (função uazapi-import-history).
// Mensagens de grupo nunca acionam a IA nem geram notificação.

interface Channel { id: string; label: string }

export function GroupsBar({ isAdmin, onDone }: { isAdmin: boolean; onDone: () => void }) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await getSupabase()
        .schema('whatsapp_hub')
        .from('channels')
        .select('id, label')
        .eq('provider', 'uazapi')
        .eq('is_active', true);
      if (alive) setChannels((data ?? []) as Channel[]);
    })();
    return () => { alive = false; };
  }, []);

  const invoke = async (body: Record<string, unknown>) => {
    const { data, error } = await getSupabase().functions.invoke('uazapi-import-history', { body });
    if (error || !data) throw new Error(await extractFunctionErrorMessage(error, data?.error));
    if (data.ok === false && !(data.chats_processed > 0)) {
      throw new Error((data.errors as string[] | undefined)?.[0] ?? data.error ?? 'Falha.');
    }
    return data as Record<string, number & boolean & unknown>;
  };

  const run = async () => {
    if (!channels?.length) return;
    setRunning(true);
    let total = 0;
    let grupos = 0;
    try {
      for (const ch of channels) {
        setProgress(`${ch.label}: ligando grupos...`);
        await invoke({ channel_id: ch.id, action: 'enable_groups' });
        let offset = 0;
        for (let round = 0; round < 50; round++) {
          const d = await invoke({ channel_id: ch.id, groups: true, days: 7, chat_offset: offset });
          total += Number(d.imported) || 0;
          grupos += Number(d.chats_with_messages) || 0;
          setProgress(`${ch.label}: ${grupos} grupos · ${total} mensagens`);
          offset = Number(d.next_offset) || offset;
          if (d.done) break;
        }
      }
      // Fotos, áudios e documentos antigos vêm sem arquivo: busca um por um.
      let midias = 0;
      for (const ch of channels) {
        for (let round = 0; round < 40; round++) {
          const d = await invoke({ channel_id: ch.id, action: 'fetch_media' });
          midias += Number(d.fixed) || 0;
          setProgress(`${ch.label}: carregando mídias (${midias})... faltam ${Number(d.remaining) || 0}`);
          if (d.done) break;
        }
      }
      toast.success(`Grupos atualizados: ${grupos} grupos, ${total} mensagens, ${midias} mídias carregadas.`);
      onDone();
    } catch (e) {
      toast.error('Não consegui buscar os grupos.', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  if (channels === null) return null;
  if (channels.length === 0) {
    return (
      <div className="rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] p-2.5 text-xs text-[var(--color-text-secondary)]">
        Grupos só funcionam em números conectados pela UAZAPI. A API oficial do WhatsApp não entrega mensagens de grupo.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] p-2 text-xs text-[var(--color-text-secondary)]">
      <Users className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {progress ?? 'Grupos do WhatsApp. A IA não responde em grupo.'}
      </span>
      {isAdmin && (
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          title="Liga o recebimento de grupos e traz as mensagens dos últimos 7 dias"
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent-fill)] px-2 py-1 font-semibold text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-60"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Buscar grupos (7 dias)
        </button>
      )}
    </div>
  );
}
