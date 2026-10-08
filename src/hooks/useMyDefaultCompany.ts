import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Empresa padrão de quem está logado (Configurações → Empresas → Usuários). null = usa a padrão do grupo.
let cache: Promise<string | null> | null = null;
export function useMyDefaultCompany(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    cache ??= Promise.resolve(getSupabase().rpc('my_default_company')).then(({ data, error }) => (error || !data ? null : String(data))).catch(() => null);
    let alive = true;
    void cache.then((v) => { if (alive) setId(v); });
    return () => { alive = false; };
  }, []);
  return id;
}
