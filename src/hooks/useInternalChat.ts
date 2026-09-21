import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import type { ChatListItem, ChatMemberRow } from '@/types/chat';

interface UseInternalChatResult {
  chats: ChatListItem[];
  loading: boolean;
  // Soma das não lidas — alimenta o badge do item "Chat" na sidebar.
  unreadTotal: number;
  reload: () => Promise<void>;
  openDm: (otherUserId: string) => Promise<string | null>;
  createGroup: (name: string, members: string[]) => Promise<string | null>;
  markRead: (chatId: string) => Promise<void>;
  addMembers: (chatId: string, members: string[]) => Promise<boolean>;
  removeMember: (chatId: string, userId: string) => Promise<boolean>;
  rename: (chatId: string, name: string) => Promise<boolean>;
  error: string | null;
}

// Lista de conversas internas do usuário. Tudo vem da RPC chat_list(), que já
// devolve título, prévia e contador de não lidas — a lista NÃO consulta
// chat_messages por sala.
export function useInternalChat(): UseInternalChatResult {
  const { userId } = useAppUser();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    const supabase = getSupabase();
    const { data, error: rpcError } = await supabase.schema('whatsapp_hub').rpc('chat_list');
    if (rpcError) {
      setError(rpcError.message);
    } else {
      setError(null);
      setChats((data ?? []) as ChatListItem[]);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Recarrega em lote: uma rajada de mensagens em salas diferentes vira uma
  // única chamada de chat_list().
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 250);
  }, [reload]);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    const suffix = Math.random().toString(36).slice(2, 10);
    // Sem filtro: o RLS do Realtime já entrega só as mensagens das salas em
    // que este usuário está (policy chat_messages_select).
    const channel = supabase
      .channel(`internal-chat:${userId}:${suffix}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'whatsapp_hub', table: 'chat_messages' },
        () => scheduleReload(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'whatsapp_hub', table: 'chat_channels' },
        () => scheduleReload(),
      )
      .subscribe();
    return () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [userId, scheduleReload]);

  const openDm = useCallback(async (otherUserId: string) => {
    const supabase = getSupabase();
    const { data, error: rpcError } = await supabase
      .schema('whatsapp_hub')
      .rpc('chat_open_dm', { p_other: otherUserId });
    if (rpcError) {
      setError(rpcError.message);
      return null;
    }
    await reload();
    return data as string;
  }, [reload]);

  const createGroup = useCallback(async (name: string, members: string[]) => {
    const supabase = getSupabase();
    const { data, error: rpcError } = await supabase
      .schema('whatsapp_hub')
      .rpc('chat_create_group', { p_name: name, p_members: members });
    if (rpcError) {
      setError(rpcError.message);
      return null;
    }
    await reload();
    return data as string;
  }, [reload]);

  // Otimista: zera o contador na hora para o badge não piscar enquanto a RPC
  // vai e volta.
  const markRead = useCallback(async (chatId: string) => {
    setChats((prev) => prev.map((c) => (c.chat_id === chatId ? { ...c, unread_count: 0 } : c)));
    const supabase = getSupabase();
    await supabase.schema('whatsapp_hub').rpc('chat_mark_read', { p_chat: chatId });
  }, []);

  const addMembers = useCallback(async (chatId: string, members: string[]) => {
    const supabase = getSupabase();
    const { error: rpcError } = await supabase
      .schema('whatsapp_hub')
      .rpc('chat_add_members', { p_chat: chatId, p_members: members });
    if (rpcError) {
      setError(rpcError.message);
      return false;
    }
    await reload();
    return true;
  }, [reload]);

  const removeMember = useCallback(async (chatId: string, targetUserId: string) => {
    const supabase = getSupabase();
    const { error: rpcError } = await supabase
      .schema('whatsapp_hub')
      .rpc('chat_remove_member', { p_chat: chatId, p_user: targetUserId });
    if (rpcError) {
      setError(rpcError.message);
      return false;
    }
    await reload();
    return true;
  }, [reload]);

  const rename = useCallback(async (chatId: string, name: string) => {
    const supabase = getSupabase();
    const { error: rpcError } = await supabase
      .schema('whatsapp_hub')
      .rpc('chat_rename', { p_chat: chatId, p_name: name });
    if (rpcError) {
      setError(rpcError.message);
      return false;
    }
    await reload();
    return true;
  }, [reload]);

  const unreadTotal = chats.reduce((acc, c) => acc + (c.unread_count || 0), 0);

  return {
    chats, loading, unreadTotal, reload,
    openDm, createGroup, markRead, addMembers, removeMember, rename,
    error,
  };
}

// Quem participa de uma sala. Só os user_ids — nome/avatar vêm de
// useOperators(), que já é a lista de membros da org.
export function useChatMembers(chatId: string | null, version = 0) {
  const [members, setMembers] = useState<ChatMemberRow[]>([]);

  useEffect(() => {
    if (!chatId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('chat_members')
        .select('chat_id, user_id, last_read_at, created_at')
        .eq('chat_id', chatId);
      if (!cancelled) setMembers((data ?? []) as ChatMemberRow[]);
    })();
    return () => { cancelled = true; };
  }, [chatId, version]);

  return members;
}
