import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface AmaiaOverview {
  isActive: boolean;
  conversasAtivasIA: number;
  conversasHumano: number;
  mensagensPeriodo: number;
  conversasAtendidasPeriodo: number;
  custoPeriodoUsd: number;
  transferenciasPeriodo: number;
}

// Janela fixa de 7 dias — simples e honesto; sem seletor de período nesta
// primeira leva (adiciona depois se precisar).
export function useAmaiaOverview() {
  const [data, setData] = useState<AmaiaOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const supabase = getSupabase();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [configRes, convStatusRes, usageRes, handoffRes] = await Promise.all([
        supabase.from('ai_agent_config').select('is_active').maybeSingle(),
        supabase.from('conversations').select('status'),
        supabase.from('ai_usage_log').select('conversation_id, estimated_cost_usd, kind').gte('created_at', since),
        // Aproximação real de "transferido pra humano": conversas em
        // human_active com ai_paused=true criadas/atualizadas no período —
        // não temos motivo categorizado, só a contagem.
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('status', 'human_active').eq('ai_paused', true).gte('updated_at', since),
      ]);

      const statusRows = (convStatusRes.data ?? []) as Array<{ status: string }>;
      const usageRows = (usageRes.data ?? []) as Array<{ conversation_id: string | null; estimated_cost_usd: number | string; kind: string }>;

      setData({
        isActive: (configRes.data as { is_active?: boolean } | null)?.is_active ?? false,
        conversasAtivasIA: statusRows.filter((r) => r.status === 'ai_active').length,
        conversasHumano: statusRows.filter((r) => r.status === 'human_active').length,
        mensagensPeriodo: usageRows.filter((r) => r.kind === 'chat').length,
        conversasAtendidasPeriodo: new Set(usageRows.map((r) => r.conversation_id).filter(Boolean)).size,
        custoPeriodoUsd: usageRows.reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0),
        transferenciasPeriodo: handoffRes.count ?? 0,
      });
      setLoading(false);
    })();
  }, []);

  return { data, loading };
}
