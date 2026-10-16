import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { hydrateConversations } from '@/hooks/useConversations';
import type { Conversation, ConversationWithContact } from '@/types/inbox';

// Listas que vêm do SERVIDOR, paginadas (20261016100000_inbox_search_instagram.sql):
//   * mode 'search'  → inbox_search: todas as conversas da organização, de qualquer status, por nome,
//                      @usuário do Instagram, telefone e texto das mensagens.
//   * mode 'closed'  → conversas concluídas (status closed), mais recentes primeiro.
// O banco aplica o RLS (organização + conversas por responsável). Sem o SQL novo, `unavailable`
// fica true e a inbox continua com a busca antiga (na lista carregada).
export type RemoteMode = 'search' | 'closed';
const PAGE = 30;

type SearchRow = { conversation_id: string; match_field: 'name' | 'username' | 'phone' | 'message'; snippet: string | null };

let searchRpcMissing = false;

async function fetchPage(mode: RemoteMode, query: string, offset: number): Promise<{ items: ConversationWithContact[]; hasMore: boolean; total: number | null }> {
  const supabase = getSupabase();
  if (mode === 'search') {
    const { data, error } = await supabase.rpc('inbox_search', { p_q: query, p_limit: PAGE + 1, p_offset: offset });
    if (error) throw error;
    const hits = (data ?? []) as SearchRow[];
    const page = hits.slice(0, PAGE);
    if (!page.length) return { items: [], hasMore: false, total: null };
    const { data: convs, error: cErr } = await supabase.from('conversations').select('*').in('id', page.map((h) => h.conversation_id));
    if (cErr) throw cErr;
    const byId = new Map(((convs ?? []) as Conversation[]).map((c) => [c.id, c]));
    const ordered = page.map((h) => byId.get(h.conversation_id)).filter((c): c is Conversation => Boolean(c));
    const hydrated = await hydrateConversations(ordered);
    const match = new Map(page.map((h) => [h.conversation_id, h]));
    return {
      items: hydrated.map((c) => {
        const m = match.get(c.id);
        return { ...c, searchMatch: m ? { field: m.match_field, snippet: m.snippet } : null };
      }),
      hasMore: hits.length > PAGE,
      total: null,
    };
  }
  const { data, error, count } = await supabase
    .from('conversations')
    .select('*', { count: 'exact' })
    .eq('status', 'closed')
    .eq('archived', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('id')
    .range(offset, offset + PAGE - 1);
  if (error) throw error;
  const rows = (data ?? []) as Conversation[];
  const items = await hydrateConversations(rows);
  return { items, hasMore: count != null ? offset + rows.length < count : rows.length === PAGE, total: count ?? null };
}

export function useInboxRemoteList(mode: RemoteMode | null, query: string) {
  const [items, setItems] = useState<ConversationWithContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(searchRpcMissing);
  // Descarta respostas atrasadas (a pessoa continuou digitando).
  const seq = useRef(0);
  const key = mode ? `${mode}:${query}` : '';

  const handleError = useCallback((e: unknown) => {
    const msg = (e as { message?: string })?.message ?? String(e);
    if (mode === 'search' && /inbox_search|schema cache|could not find the function|PGRST202/i.test(msg)) {
      searchRpcMissing = true;
      setUnavailable(true);
      return;
    }
    setError(msg);
  }, [mode]);

  const load = useCallback(async (silent = false) => {
    const my = ++seq.current;
    if (!mode || (mode === 'search' && (searchRpcMissing || query.trim().length < 2))) {
      setItems([]); setHasMore(false); setTotal(null); setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await fetchPage(mode, query.trim(), 0);
      if (my !== seq.current) return;
      setItems(r.items); setHasMore(r.hasMore); setTotal(r.total);
    } catch (e) {
      if (my !== seq.current) return;
      handleError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, handleError]);

  useEffect(() => { void load(false); }, [load]);

  const loadMore = useCallback(async () => {
    if (!mode || loadingMore || !hasMore) return;
    const my = seq.current;
    setLoadingMore(true);
    try {
      const r = await fetchPage(mode, query.trim(), items.length);
      if (my !== seq.current) return;
      setItems((cur) => {
        const seen = new Set(cur.map((c) => c.id));
        return [...cur, ...r.items.filter((c) => !seen.has(c.id))];
      });
      setHasMore(r.hasMore);
      if (r.total != null) setTotal(r.total);
    } catch (e) {
      if (my === seq.current) handleError(e);
    } finally {
      setLoadingMore(false);
    }
  }, [mode, query, items.length, hasMore, loadingMore, handleError]);

  // Recarrega a 1ª página sem piscar (ex.: a conversa foi reaberta/concluída).
  const refresh = useCallback(() => { void load(true); }, [load]);

  return { items, loading, loadingMore, hasMore, total, error, unavailable, loadMore, refresh };
}
