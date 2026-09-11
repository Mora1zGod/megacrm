import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers/AuthProvider';

export interface IntegrationStatus {
  key: string;
  label: string;
  configured: boolean;
}

const KEYS: Array<{ key: string; label: string }> = [
  { key: 'zernio_api_key', label: 'Zernio (WhatsApp Meta oficial + Instagram)' },
  { key: 'openai_api_key', label: 'OpenAI (embeddings, visão, transcrição)' },
  { key: 'llm_api_key', label: 'LLM do agente (OpenAI/Claude/Gemini)' },
  { key: 'smtp_host', label: 'SMTP (e-mails transacionais)' },
];

export function useIntegrationsStatus() {
  const { session } = useAuth();
  const [statuses, setStatuses] = useState<IntegrationStatus[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    fetch(`/api/credentials?keys=${KEYS.map((k) => k.key).join(',')}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((body: Record<string, { exists?: boolean }>) => {
        setStatuses(
          KEYS.map((k) => ({ key: k.key, label: k.label, configured: Boolean(body?.[k.key]?.exists) })),
        );
      })
      .catch(() => setStatuses(KEYS.map((k) => ({ key: k.key, label: k.label, configured: false }))))
      .finally(() => setLoading(false));
  }, [session]);

  return { statuses: statuses ?? [], loading };
}
