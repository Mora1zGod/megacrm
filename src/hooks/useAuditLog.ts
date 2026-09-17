import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

// Registra um evento de auditoria. Nunca lança — falha aqui não pode
// derrubar a ação principal que está sendo registrada.
export async function logAudit(params: {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getSupabase().from('audit_log').insert({
      actor_id: params.actorId,
      actor_email: params.actorEmail,
      action: params.action,
      entity_type: params.entityType ?? null,
      entity_id: params.entityId ?? null,
      meta: params.meta ?? null,
    });
  } catch {
    // silencioso de propósito — log de auditoria nunca deve travar o fluxo.
  }
}

export function useAuditLog(limit = 100) {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await getSupabase()
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (err) setError(err.message);
    else setRows((data ?? []) as AuditLogRow[]);
    setLoading(false);
  }, [limit]);

  useEffect(() => { void load(); }, [load]);

  return { rows, loading, error, reload: load };
}
