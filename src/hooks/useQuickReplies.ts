import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface QuickReply {
  id: string;
  shortcut: string;
  content: string;
}

// Respostas rápidas da org — carregadas uma vez e mantidas em memória; o
// composer do Inbox filtra localmente enquanto o operador digita "/algo".
export function useQuickReplies() {
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('quick_replies')
      .select('id, shortcut, content')
      .order('shortcut');
    setQuickReplies((data ?? []) as QuickReply[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { quickReplies, loading, reload };
}
