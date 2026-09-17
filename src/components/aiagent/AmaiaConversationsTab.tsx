import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import { getSupabase } from '@/lib/supabase';

interface ConvRow {
  id: string;
  status: string;
  ai_paused: boolean;
  channel: string;
  last_message_at: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

const STATUS_LABEL: Record<string, string> = {
  ai_active: 'Resolvida pela IA / em andamento',
  human_active: 'Transferida / humano assumiu',
  closed: 'Fechada',
};

export function AmaiaConversationsTab() {
  const [rows, setRows] = useState<ConvRow[] | null>(null);

  useEffect(() => {
    void getSupabase()
      .from('conversations')
      .select('id, status, ai_paused, channel, last_message_at, contact:contact_id(name, phone)')
      .order('last_message_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setRows((data ?? []) as unknown as ConvRow[]));
  }, []);

  if (rows === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (rows.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhuma conversa ainda.</div>;

  return (
    <div className="glass-card overflow-hidden p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[rgba(14,154,160,0.12)] text-left text-xs text-[var(--color-text-secondary)]">
            <th className="px-4 py-2 font-medium">Contato</th>
            <th className="px-4 py-2 font-medium">Canal</th>
            <th className="px-4 py-2 font-medium">Resultado</th>
            <th className="px-4 py-2 font-medium">Última interação</th>
            <th className="px-4 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-[rgba(14,154,160,0.08)] last:border-0">
              <td className="px-4 py-2.5 text-[var(--color-text-primary)]">{c.contact?.name || c.contact?.phone || '—'}</td>
              <td className="px-4 py-2.5 text-[var(--color-text-secondary)] capitalize">{c.channel}</td>
              <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{STATUS_LABEL[c.status] ?? c.status}</td>
              <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">
                {c.last_message_at ? new Date(c.last_message_at).toLocaleString('pt-BR') : '—'}
              </td>
              <td className="px-4 py-2.5">
                <Link to={`/inbox?conversation=${c.id}`} className="text-xs font-semibold text-[var(--accent-primary)] hover:opacity-80">
                  Abrir na Inbox
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
