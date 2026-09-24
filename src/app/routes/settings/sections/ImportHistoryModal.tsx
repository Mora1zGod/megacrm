import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, History, Loader2, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';

// Importa as conversas antigas do celular de um número UAZAPI (função
// uazapi-import-history). A função trabalha em lotes de ~90s; aqui chamamos
// em sequência até ela responder done=true, mostrando o andamento.
// Seguro rodar de novo: mensagens já importadas são ignoradas.

const PERIODS = [
  { days: 30, label: '30 dias' },
  { days: 90, label: '3 meses' },
  { days: 180, label: '6 meses' },
  { days: 365, label: '1 ano' },
];

interface Progress {
  chats: number;
  imported: number;
  created: number;
  total: number | null;
}

export function ImportHistoryModal({
  channelId,
  label,
  onClose,
}: {
  channelId: string;
  label: string;
  onClose: () => void;
}) {
  const [days, setDays] = useState(90);
  const [status, setStatus] = useState<{ totalChats: number | null; syncNote: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({ chats: 0, imported: 0, created: 0, total: null });
  const cancelRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error: err } = await getSupabase().functions.invoke('uazapi-import-history', {
        body: { channel_id: channelId, action: 'status' },
      });
      if (!alive) return;
      if (err || !data?.ok) {
        setStatus({ totalChats: null, syncNote: await extractFunctionErrorMessage(err, data?.error) });
        return;
      }
      const sync = (data.sync ?? {}) as { progress?: number; processingComplete?: boolean };
      const note = typeof sync.progress === 'number' && sync.progress < 100 && !sync.processingComplete
        ? `O WhatsApp ainda está sincronizando o histórico com o servidor (${sync.progress}%). Dá para importar agora e rodar de novo depois para pegar o restante.`
        : null;
      setStatus({ totalChats: typeof data.total_chats === 'number' ? data.total_chats : null, syncNote: note });
    })();
    return () => { alive = false; };
  }, [channelId]);

  const run = async () => {
    cancelRef.current = false;
    setRunning(true);
    setDone(false);
    setError(null);
    setProgress({ chats: 0, imported: 0, created: 0, total: status?.totalChats ?? null });
    let offset = 0;
    try {
      for (let round = 0; round < 200; round++) {
        if (cancelRef.current) break;
        const { data, error: err } = await getSupabase().functions.invoke('uazapi-import-history', {
          body: { channel_id: channelId, days, chat_offset: offset },
        });
        if (err || !data) throw new Error(await extractFunctionErrorMessage(err, data?.error));
        if (!data.ok && (data.chats_processed ?? 0) === 0) {
          throw new Error((data.errors as string[] | undefined)?.[0] ?? data.error ?? 'Falha na importação.');
        }
        setProgress((p) => ({
          chats: p.chats + (data.chats_processed ?? 0),
          imported: p.imported + (data.imported ?? 0),
          created: p.created + (data.conversations_created ?? 0),
          total: data.total_chats ?? p.total,
        }));
        offset = data.next_offset ?? offset;
        if (data.done) { setDone(true); break; }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const pct = progress.total ? Math.min(100, Math.round((progress.chats / progress.total) * 100)) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="import-h">
      <div className="w-full max-w-md space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-6 shadow-[var(--shadow-lg)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-[var(--color-text-muted)]">UAZAPI · {label}</div>
            <h3 id="import-h" className="text-lg font-semibold text-[var(--color-text-primary)]">Importar conversas antigas</h3>
          </div>
          <button
            onClick={() => { cancelRef.current = true; onClose(); }}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-[var(--color-text-secondary)]">
          Traz para o CRM as mensagens que já estavam no celular deste número. A IA não responde,
          ninguém é notificado e as conversas novas entram como concluídas. Mensagens já importadas
          são ignoradas, então pode rodar de novo.
        </p>

        {status === null ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Consultando o servidor...
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            {status.totalChats !== null && (
              <div className="text-[var(--color-text-primary)]">{status.totalChats} conversas encontradas no aparelho.</div>
            )}
            {status.syncNote && <div className="text-[var(--color-warning)]">{status.syncNote}</div>}
          </div>
        )}

        <div>
          <div className="mb-1.5 text-sm font-medium text-[var(--color-text-secondary)]">Período</div>
          <div className="grid grid-cols-4 gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-bg-primary)] p-1">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                disabled={running}
                aria-pressed={days === p.days}
                onClick={() => setDays(p.days)}
                className={`h-9 rounded-md text-sm font-medium transition ${days === p.days ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {(running || done || progress.chats > 0) && (
          <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-bg-primary)] p-3 text-sm">
            {pct !== null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                <div className="h-full rounded-full bg-[var(--accent-fill)] transition-[width]" style={{ width: `${done ? 100 : pct}%` }} />
              </div>
            )}
            <div className="flex items-center gap-2 text-[var(--color-text-primary)]">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" /> : null}
              {running ? 'Importando...' : done ? 'Importação concluída.' : 'Importação interrompida.'}
            </div>
            <div className="text-[var(--color-text-secondary)]">
              {progress.chats} conversas lidas · {progress.imported} mensagens importadas · {progress.created} conversas novas
            </div>
          </div>
        )}

        {error && <div className="text-sm text-[var(--color-error)]" role="alert">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => { cancelRef.current = true; onClose(); }}
            className="h-10 rounded-[var(--radius-control)] px-4 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            {done ? 'Fechar' : 'Cancelar'}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || status === null}
            className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
            {done ? 'Importar de novo' : 'Importar'}
          </button>
        </div>
      </div>
    </div>
  );
}
