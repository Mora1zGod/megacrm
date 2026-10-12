import { useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export interface Operator {
  user_id: string;
  email: string;
  role: 'admin' | 'operator';
  display_name: string | null;
  avatar_url: string | null;
  // 'active' | 'inactive' | 'blocked' (20261012120000_operators_status.sql). Sem o SQL vem vazio = tratado como ativo.
  status?: string | null;
}

export const isActiveOperator = (o: Pick<Operator, 'status'>) => !o.status || o.status === 'active';

// Nome exibível de um operador: display_name do perfil, senão a parte local do
// e-mail. Usado em badges de atribuição, seletores e listas de equipe.
export function operatorLabel(op: Pick<Operator, 'display_name' | 'email'> | undefined | null): string {
  if (!op) return '';
  return op.display_name?.trim() || op.email.split('@')[0];
}

// Membros da organização (RPC list_operators).
// - operators: só os ATIVOS — use em todo seletor (nova conversa, atribuir, compartilhar, responsável…).
// - allOperators: todos, inclusive desativados — use só para mostrar o nome de quem fez algo (histórico, autor).
export function useOperators() {
  const [allOperators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.schema('whatsapp_hub').rpc('list_operators');
      if (!cancelled) {
        setOperators((data ?? []) as Operator[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const operators = useMemo(() => allOperators.filter(isActiveOperator), [allOperators]);
  return { operators, allOperators, loading };
}
