import { getSupabase } from '@/lib/supabase';

// Login/logout na auditoria. A Edge Function log-access grava IP e dispositivo;
// se ela não estiver publicada, cai na RPC log_access_event (sem IP).
// Nunca lança: auditoria não pode atrapalhar entrar/sair.
export async function logAccess(action: 'auth.login' | 'auth.logout'): Promise<void> {
  const supabase = getSupabase();
  const user_agent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;
  try {
    const { data, error } = await supabase.functions.invoke('log-access', { body: { action, user_agent } });
    if (!error && data?.ok) return;
  } catch {
    // cai no fallback
  }
  try {
    await supabase.rpc('log_access_event', { p_action: action, p_user_agent: user_agent });
  } catch {
    // best-effort
  }
}
