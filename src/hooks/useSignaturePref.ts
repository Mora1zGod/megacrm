import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

// Assinatura do atendente ("*Maria:*" no começo da mensagem). Preferência
// pessoal, salva em app_users.sign_messages (vale em qualquer computador).
export function useSignaturePref() {
  const { userId, displayName } = useAppUser();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void getSupabase()
      .from('app_users')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setEnabled(Boolean((data as { sign_messages?: boolean } | null)?.sign_messages));
      });
    return () => { alive = false; };
  }, [userId]);

  const toggle = useCallback(async () => {
    if (!userId) return;
    const next = !enabled;
    setEnabled(next);
    const { error } = await getSupabase().from('app_users').update({ sign_messages: next }).eq('user_id', userId);
    if (error) {
      setEnabled(!next);
      toast.error('Não consegui salvar a assinatura', {
        description: /sign_messages/.test(error.message) ? 'Falta rodar o SQL do painel de atendimento.' : error.message,
      });
      return;
    }
    toast.success(next ? 'Assinatura ligada: suas mensagens saem com o seu nome.' : 'Assinatura desligada.');
  }, [enabled, userId]);

  const name = displayName?.trim() || null;

  // WhatsApp mostra *negrito*; Instagram não tem formatação.
  const sign = useCallback((text: string, channel: 'whatsapp' | 'instagram' | null | undefined) => {
    if (!enabled || !name) return text;
    return channel === 'instagram' ? `${name}:\n${text}` : `*${name}:*\n${text}`;
  }, [enabled, name]);

  return { enabled, toggle, sign, name };
}
