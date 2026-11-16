import { useEffect, useState } from 'react';

// Celular = abaixo de 768 px (mesmo corte do `md:` do Tailwind). Usado onde montar as DUAS versões
// (celular e computador) duplicaria carregamentos/assinaturas — ex.: botões do topo.
const QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}
