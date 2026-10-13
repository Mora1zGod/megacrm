import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

// Assinatura do atendente ("*Maria:*" no começo da mensagem). Preferência
// pessoal, salva em app_users.sign_messages (vale em qualquer computador).
export function useSignaturePref() {
  const { userId, displayName, orgId } = useAppUser();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void getSupabase()
      .from('app_users')
      .select('org_id, sign_messages')
      .eq('user_id', userId)
      .then(({ data }) => {
        const rows = (data ?? []) as Array<{ org_id: string; sign_messages?: boolean }>;
        if (alive) setEnabled(Boolean((rows.find((r) => r.org_id === orgId) ?? rows[0])?.sign_messages));
      });
    return () => { alive = false; };
  }, [userId, orgId]);

  const toggle = useCallback(async () => {
    if (!userId) return;
    const next = !enabled;
    setEnabled(next);
    const { error } = await getSupabase().from('app_users').update({ sign_messages: next }).eq('user_id', userId).eq('org_id', orgId ?? '');
    if (error) {
      setEnabled(!next);
      toast.error('Não consegui salvar a assinatura', {
        description: /sign_messages/.test(error.message) ? 'Falta rodar o SQL do painel de atendimento.' : error.message,
      });
      return;
    }
    toast.success(next ? 'Assinatura ligada: suas mensagens saem com o seu nome.' : 'Assinatura desligada.');
  }, [enabled, userId, orgId]);

  const name = displayName?.trim() || null;

  // WhatsApp mostra *negrito*; Instagram não tem formatação.
  const sign = useCallback((text: string, channel: 'whatsapp' | 'instagram' | null | undefined) => {
    if (!enabled || !name) return text;
    return channel === 'instagram' ? `${name}:\n${text}` : `*${name}:*\n${text}`;
  }, [enabled, name]);

  return { enabled, toggle, sign, name };
}
