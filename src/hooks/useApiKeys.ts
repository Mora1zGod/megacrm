import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers/AuthProvider';

export interface ApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function useApiKeys() {
  const { session } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/api-keys', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = (await res.json()) as { keys?: ApiKeyRow[] };
      setKeys(body.keys ?? []);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const createKey = useCallback(async (label: string): Promise<string> => {
    if (!session) throw new Error('Sessão expirada.');
    const res = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ label }),
    });
    const body = (await res.json()) as { success?: boolean; message?: string; fullKey?: string };
    if (!res.ok || !body.success || !body.fullKey) throw new Error(body.message ?? 'Falha ao gerar a chave.');
    await load();
    return body.fullKey;
  }, [session, load]);

  const revokeKey = useCallback(async (id: string) => {
    if (!session) throw new Error('Sessão expirada.');
    const res = await fetch('/api/api-keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json()) as { success?: boolean; message?: string };
    if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao revogar.');
    await load();
  }, [session, load]);

  return { keys: keys ?? [], loading, reload: load, createKey, revokeKey };
}
