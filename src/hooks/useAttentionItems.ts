import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface AttentionItem {
  kind: 'conversas_aguardando' | 'visitas_sem_confirmacao' | 'negocios_parados';
  label: string;
  count: number;
  href: string;
}

export interface TodayVisit {
  id: string;
  visit_time: string;
  status: string;
  party_size: number;
  contact_name: string | null;
}

// "Precisam de atenção": só 3 condições que consigo calcular com segurança
// hoje (sem inventar SLA/score que o banco não guarda):
//   - conversas em atendimento humano sem IA, paradas há mais de 30min
//   - visitas de hoje/futuras ainda com status 'pending' (não confirmadas)
//   - negócios abertos sem atualização há mais de 7 dias
export function useAttentionItems() {
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const today = new Date().toISOString().slice(0, 10);

      const [convsRes, visitsRes, dealsRes] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .eq('status', 'human_active').lte('last_message_at', thirtyMinAgo),
        supabase.from('park_visits').select('id', { count: 'exact', head: true })
          .eq('status', 'pending').gte('visit_date', today),
        supabase.from('deals').select('id', { count: 'exact', head: true })
          .eq('status', 'open').lte('updated_at', sevenDaysAgo),
      ]);

      setItems([
        { kind: 'conversas_aguardando', label: 'conversas sem resposta há mais de 30 min', count: convsRes.count ?? 0, href: '/inbox' },
        { kind: 'visitas_sem_confirmacao', label: 'visitas sem confirmação', count: visitsRes.count ?? 0, href: '/visitas' },
        { kind: 'negocios_parados', label: 'negócios parados há mais de 7 dias', count: dealsRes.count ?? 0, href: '/funil' },
      ]);
    })();
  }, []);

  return { items: items ?? [], loading: items === null };
}

export function useTodayVisits() {
  const [visits, setVisits] = useState<TodayVisit[] | null>(null);

  useEffect(() => {
    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await getSupabase()
        .from('park_visits')
        .select('id, visit_time, status, party_size, contact:contact_id(name)')
        .eq('visit_date', today)
        .order('visit_time');
      setVisits(
        ((data ?? []) as unknown as Array<{ id: string; visit_time: string; status: string; party_size: number; contact: { name: string | null } | null }>)
          .map((v) => ({ id: v.id, visit_time: v.visit_time, status: v.status, party_size: v.party_size, contact_name: v.contact?.name ?? null })),
      );
    })();
  }, []);

  return { visits: visits ?? [], loading: visits === null };
}
