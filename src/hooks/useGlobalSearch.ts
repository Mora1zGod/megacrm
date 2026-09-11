import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface SearchResult {
  kind: 'contact' | 'deal' | 'visit';
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

// Busca real em contatos (nome/telefone), negócios (título) e visitas (nome
// do contato). Sem resultado fake — se não achar, a lista fica vazia.
export function useGlobalSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    const supabase = getSupabase();
    const timer = setTimeout(async () => {
      try {
        const [contactsRes, dealsRes, visitsRes] = await Promise.all([
          supabase.from('contacts').select('id, name, phone').or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(5),
          supabase.from('deals').select('id, title, value').ilike('title', `%${q}%`).limit(5),
          supabase.from('park_visits').select('id, visit_date, contact:contact_id(name, phone)').limit(20),
        ]);
        const contacts: SearchResult[] = ((contactsRes.data ?? []) as Array<{ id: string; name: string | null; phone: string | null }>).map((c) => ({
          kind: 'contact', id: c.id, title: c.name || c.phone || 'Sem nome', subtitle: c.phone ?? '', href: `/contacts/${c.id}`,
        }));
        const deals: SearchResult[] = ((dealsRes.data ?? []) as Array<{ id: string; title: string | null; value: number | null }>).map((d) => ({
          kind: 'deal', id: d.id, title: d.title || 'Negócio sem título', subtitle: d.value ? `R$ ${Number(d.value).toLocaleString('pt-BR')}` : '', href: '/funil',
        }));
        // Visitas não têm busca textual direta no banco — filtra pelo nome do
        // contato já carregado (client-side, sobre um lote pequeno).
        const visits: SearchResult[] = ((visitsRes.data ?? []) as unknown as Array<{ id: string; visit_date: string; contact: { name: string | null; phone: string | null } | null }>)
          .filter((v) => (v.contact?.name ?? '').toLowerCase().includes(q.toLowerCase()) || (v.contact?.phone ?? '').includes(q))
          .slice(0, 5)
          .map((v) => ({
            kind: 'visit', id: v.id, title: v.contact?.name || v.contact?.phone || 'Visita', subtitle: v.visit_date, href: '/visitas',
          }));
        setResults([...contacts, ...deals, ...visits]);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return { results, loading };
}
