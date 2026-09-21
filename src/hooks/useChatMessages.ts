import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { CHAT_BUCKET, chatAttachmentPath } from '@/lib/chatAttachments';
import type { ChatContentType, ChatMessage, ThreadChatMessage } from '@/types/chat';

const PAGE_SIZE = 50;

// '*' e não a lista de colunas: o parser de tipos do supabase-js só entende
// select strings literais, e a lista quebrada em linhas vira `unknown`.
const SELECT_COLS = '*';

interface SendTextOptions {
  mentions?: string[];
  refConversationId?: string | null;
}

interface UseChatMessagesResult {
  messages: ThreadChatMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  sendText: (text: string, options?: SendTextOptions) => Promise<boolean>;
  sendFile: (file: File, caption?: string) => Promise<boolean>;
  editMessage: (id: string, content: string) => Promise<boolean>;
  deleteMessage: (id: string) => Promise<boolean>;
  error: string | null;
}

// Thread de uma sala do Chat Interno. Envio de texto é OTIMISTA (o balão
// aparece antes do round-trip); anexo não é — o upload precisa terminar antes
// da mensagem existir.
export function useChatMessages(chatId: string | null): UseChatMessagesResult {
  const { userId, orgId } = useAppUser();
  const [messages, setMessages] = useState<ThreadChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // O handler de realtime precisa do valor corrente sem virar dependência do
  // useEffect (senão a subscription é derrubada a cada mensagem).
  const messagesRef = useRef<ThreadChatMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const supabase = getSupabase();
      // Busca a página MAIS RECENTE (desc) e inverte — não dá para pedir as
      // últimas N em ordem crescente sem saber o total.
      const { data, error: qError } = await supabase
        .from('chat_messages')
        .select(SELECT_COLS)
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);
      if (cancelled) return;
      if (qError) {
        setError(qError.message);
        setMessages([]);
      } else {
        const rows = (data ?? []) as ChatMessage[];
        setError(null);
        setMessages([...rows].reverse());
        setHasOlder(rows.length === PAGE_SIZE);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [chatId]);

  const loadOlder = useCallback(async () => {
    if (!chatId || loadingOlder) return;
    const oldest = messagesRef.current.find((m) => !m._tempId);
    if (!oldest) return;
    setLoadingOlder(true);
    const supabase = getSupabase();
    const { data } = await supabase
      .from('chat_messages')
      .select(SELECT_COLS)
      .eq('chat_id', chatId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    const rows = (data ?? []) as ChatMessage[];
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id));
      return [...[...rows].reverse().filter((r) => !known.has(r.id)), ...prev];
    });
    setHasOlder(rows.length === PAGE_SIZE);
    setLoadingOlder(false);
  }, [chatId, loadingOlder]);

  useEffect(() => {
    if (!chatId || !userId) return;
    const supabase = getSupabase();
    const suffix = Math.random().toString(36).slice(2, 10);
    const channel = supabase
      .channel(`chat:${chatId}:${suffix}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'whatsapp_hub',
          table: 'chat_messages',
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as ChatMessage;
            setMessages((prev) => {
              if (prev.some((m) => m.id === row.id)) return prev;
              // Eco do meu próprio envio otimista: troca o balão pendente pelo
              // real em vez de duplicar.
              if (row.sender_id === userId) {
                const tempIdx = prev.findIndex(
                  (m) => m._state === 'pending'
                    && m.content === row.content
                    && m.content_type === row.content_type,
                );
                if (tempIdx >= 0) {
                  const next = [...prev];
                  next[tempIdx] = row;
                  return next;
                }
              }
              return [...prev, row];
            });
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as ChatMessage;
            setMessages((prev) => prev.map((m) => (m.id === row.id ? row : m)));
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as ChatMessage;
            setMessages((prev) => prev.filter((m) => m.id !== row.id));
          }
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [chatId, userId]);

  const insertMessage = useCallback(async (row: {
    content_type: ChatContentType;
    content: string | null;
    media_path?: string | null;
    media_name?: string | null;
    media_size?: number | null;
    mentions?: string[] | null;
    ref_conversation_id?: string | null;
  }) => {
    const supabase = getSupabase();
    // org_id fica de fora de propósito: quem preenche é o DEFAULT da coluna
    // (current_org_id() do JWT), como no resto do schema.
    return supabase
      .from('chat_messages')
      .insert({ chat_id: chatId, sender_id: userId, ...row })
      .select(SELECT_COLS)
      .single();
  }, [chatId, userId]);

  const sendText = useCallback(async (text: string, options?: SendTextOptions) => {
    const content = text.trim();
    if (!chatId || !userId || !content) return false;

    const tempId = crypto.randomUUID();
    const optimistic: ThreadChatMessage = {
      id: tempId,
      chat_id: chatId,
      sender_id: userId,
      content_type: 'text',
      content,
      media_path: null,
      media_name: null,
      media_size: null,
      mentions: options?.mentions?.length ? options.mentions : null,
      ref_conversation_id: options?.refConversationId ?? null,
      edited_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      _tempId: tempId,
      _state: 'pending',
    };
    setMessages((prev) => [...prev, optimistic]);

    const { data, error: insErr } = await insertMessage({
      content_type: 'text',
      content,
      mentions: options?.mentions?.length ? options.mentions : null,
      ref_conversation_id: options?.refConversationId ?? null,
    });

    if (insErr || !data) {
      setError(insErr?.message ?? 'falha ao enviar');
      setMessages((prev) =>
        prev.map((m) => (m._tempId === tempId ? { ...m, _state: 'failed' } : m)));
      return false;
    }

    const row = data as ChatMessage;
    setMessages((prev) => {
      const withoutTemp = prev.filter((m) => m._tempId !== tempId);
      return withoutTemp.some((m) => m.id === row.id) ? withoutTemp : [...withoutTemp, row];
    });
    return true;
  }, [chatId, userId, insertMessage]);

  const sendFile = useCallback(async (file: File, caption?: string) => {
    if (!chatId || !userId || !orgId) return false;
    const supabase = getSupabase();
    const path = chatAttachmentPath(orgId, chatId, file.name);
    const { error: upErr } = await supabase.storage
      .from(CHAT_BUCKET)
      .upload(path, file, { contentType: file.type || undefined });
    if (upErr) {
      setError(upErr.message);
      return false;
    }

    const { error: insErr } = await insertMessage({
      content_type: file.type.startsWith('image/') ? 'image' : 'file',
      content: caption?.trim() || null,
      media_path: path,
      media_name: file.name,
      media_size: file.size,
    });
    if (insErr) {
      // Mensagem não entrou: o arquivo órfão no bucket não serve para nada.
      await supabase.storage.from(CHAT_BUCKET).remove([path]);
      setError(insErr.message);
      return false;
    }
    return true;
  }, [chatId, userId, orgId, insertMessage]);

  const editMessage = useCallback(async (id: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const supabase = getSupabase();
    // edited_at é carimbado pelo trigger _chat_messages_guard, não aqui.
    const { error: updErr } = await supabase
      .from('chat_messages')
      .update({ content: trimmed })
      .eq('id', id);
    if (updErr) {
      setError(updErr.message);
      return false;
    }
    return true;
  }, []);

  const deleteMessage = useCallback(async (id: string) => {
    const supabase = getSupabase();
    const target = messagesRef.current.find((m) => m.id === id);
    const { error: delErr } = await supabase
      .from('chat_messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (delErr) {
      setError(delErr.message);
      return false;
    }
    // O guard já limpou media_path na linha; remove também o objeto do bucket
    // para não deixar anexo acessível depois de apagada a mensagem.
    if (target?.media_path) {
      await supabase.storage.from(CHAT_BUCKET).remove([target.media_path]);
    }
    return true;
  }, []);

  return {
    messages, loading, loadingOlder, hasOlder, loadOlder,
    sendText, sendFile, editMessage, deleteMessage, error,
  };
}
