import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface Queue {
  id: string;
  name: string;
  color: string | null;
  is_default: boolean;
  position: number;
}

// Lista as filas visíveis ao usuário logado. RLS decide o alcance: admin vê
// todas; operador só as que participa (se a policy de `queues` seguir o mesmo
// padrão de `conversations`) — o filtro do Inbox nunca oferece uma fila que a
// pessoa não pode mesmo acessar.
export function useQueues() {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('queues')
        .select('id, name, color, is_default, position')
        .order('position');
      if (!cancelled) {
        setQueues((data ?? []) as Queue[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { queues, loading };
}
