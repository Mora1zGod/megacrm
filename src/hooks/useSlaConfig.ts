import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export interface SlaConfig {
  warn: number; // minutos até ficar amarelo
  late: number; // minutos até ficar vermelho
}

export const DEFAULT_SLA: SlaConfig = { warn: 5, late: 15 };

// Tempo de resposta (SLA) da org — app_settings.sla_warn_minutes/sla_late_minutes.
// Sem o SQL do painel de atendimento, cai no padrão 5/15 min.
export function useSlaConfig() {
  const { orgId } = useAppUser();
  const [sla, setSla] = useState<SlaConfig>(DEFAULT_SLA);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    void getSupabase()
      .from('app_settings')
      .select('*')
      .eq('org_id', orgId)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        const row = data as { sla_warn_minutes?: number; sla_late_minutes?: number } | null;
        if (row?.sla_warn_minutes && row?.sla_late_minutes) setSla({ warn: row.sla_warn_minutes, late: row.sla_late_minutes });
        setLoading(false);
      });
    return () => { alive = false; };
  }, [orgId]);

  const save = useCallback(async (next: SlaConfig): Promise<string | null> => {
    if (!orgId) return 'Sem organização.';
    const { error } = await getSupabase()
      .from('app_settings')
      .update({ sla_warn_minutes: next.warn, sla_late_minutes: next.late })
      .eq('org_id', orgId);
    if (error) return error.message;
    setSla(next);
    return null;
  }, [orgId]);

  return { sla, loading, save };
}
