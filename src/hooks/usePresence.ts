import { useEffect, useSyncExternalStore } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

// Quem está com o CRM aberto agora (bolinha verde no Chat Interno).
// Usa o Presence do Supabase Realtime: cada aba entra no canal da org com a chave = user_id;
// fechar a aba/perder a conexão tira a pessoa da lista sozinho (~30 s). Nada vai para o banco.
// NÃO é o `app_users.is_online` — aquele é o "disponível para o rodízio" do Atendimento.

let online = new Set<string>();
let ready = false; // false = ainda sem resposta do Realtime → não mostra bolinha (nem verde nem cinza)
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const getOnline = () => online;
const getReady = () => ready;

export function useOnlineUsers() { return useSyncExternalStore(subscribe, getOnline, getOnline); }
// true/false quando já sabemos; undefined enquanto o Realtime não respondeu.
export function useIsOnline(userId: string | null | undefined): boolean | undefined {
  const set = useSyncExternalStore(subscribe, getOnline, getOnline);
  const ok = useSyncExternalStore(subscribe, getReady, getReady);
  if (!ok || !userId) return undefined;
  return set.has(userId);
}
export function usePresenceReady() { return useSyncExternalStore(subscribe, getReady, getReady); }

export function usePresenceTracker() {
  const { userId, orgId } = useAppUser();
  useEffect(() => {
    if (!userId || !orgId) return;
    const supabase = getSupabase();
    const ch = supabase.channel(`presence:${orgId}`, { config: { presence: { key: userId } } });
    ch.on('presence', { event: 'sync' }, () => {
      online = new Set(Object.keys(ch.presenceState()));
      online.add(userId);
      ready = true;
      emit();
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ at: new Date().toISOString() });
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { ready = false; emit(); }
    });
    return () => {
      ready = false; online = new Set(); emit();
      void supabase.removeChannel(ch);
    };
  }, [userId, orgId]);
}

// Componente sem tela: montado uma vez no layout.
export function PresenceTracker() { usePresenceTracker(); return null; }
