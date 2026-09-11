import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  tag_ids: string[];
  created_at: string;
  count: number;
}

export function useSegments() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('campaign_segments')
      .select('id, name, description, tag_ids, created_at')
      .order('created_at', { ascending: false });
    if (err) { setError(err.message); setLoading(false); return; }
    const rows = (data ?? []) as Array<{ id: string; name: string; description: string | null; tag_ids: string[]; created_at: string }>;

    // Contagem por segmento: contatos com ALGUMA das tags do segmento.
    // Sem tag nenhuma no segmento, contagem é 0 (evita "todo mundo" por engano).
    const withCount = await Promise.all(rows.map(async (r) => {
      if (r.tag_ids.length === 0) return { ...r, count: 0 };
      const { data: ct } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', r.tag_ids);
      const uniq = new Set((ct ?? []).map((x: { contact_id: string }) => x.contact_id));
      return { ...r, count: uniq.size };
    }));
    setSegments(withCount);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createSegment = useCallback(async (input: { name: string; description?: string; tagIds: string[] }) => {
    const { error: err } = await getSupabase().from('campaign_segments').insert({
      name: input.name,
      description: input.description || null,
      tag_ids: input.tagIds,
    });
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const deleteSegment = useCallback(async (id: string) => {
    const { error: err } = await getSupabase().from('campaign_segments').delete().eq('id', id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  return { segments, loading, error, reload: load, createSegment, deleteSegment };
}
