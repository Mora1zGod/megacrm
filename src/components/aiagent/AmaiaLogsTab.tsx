import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { getSupabase } from '@/lib/supabase';

interface LogRow {
  id: string;
  kind: string;
  provider: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | string;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  chat: 'Resposta ao cliente',
  embedding: 'Busca na base (embedding)',
  vision: 'Leitura de imagem',
  auto_move: 'Classificação de estágio',
};

export function AmaiaLogsTab() {
  const [rows, setRows] = useState<LogRow[] | null>(null);

  useEffect(() => {
    void getSupabase()
      .from('ai_usage_log')
      .select('id, kind, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, created_at')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setRows((data ?? []) as LogRow[]));
  }, []);

  if (rows === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (rows.length === 0) return <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">Nenhum log ainda.</div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
        Últimas 200 chamadas de IA — sem chave/token/segredo nenhum exposto aqui, só volume e custo.
      </p>
      <div className="glass-card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[rgba(14,154,160,0.12)] text-left text-xs text-[var(--color-text-secondary)]">
              <th className="px-4 py-2 font-medium">Quando</th>
              <th className="px-4 py-2 font-medium">Evento</th>
              <th className="px-4 py-2 font-medium">Modelo</th>
              <th className="px-4 py-2 font-medium">Tokens</th>
              <th className="px-4 py-2 font-medium">Custo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[rgba(14,154,160,0.08)] last:border-0">
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)] whitespace-nowrap">{new Date(r.created_at).toLocaleString('pt-BR')}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-primary)]">{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{r.model ?? '—'} <span className="opacity-60">({r.provider})</span></td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{r.total_tokens.toLocaleString('pt-BR')}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(Number(r.estimated_cost_usd))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
