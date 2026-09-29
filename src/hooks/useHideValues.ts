import { useCallback, useEffect, useState } from 'react';

// "Olho" para ocultar valores em R$ (preferência do navegador, compartilhada
// entre os componentes abertos via evento).
const KEY = 'megacrm_hide_values';
const EVENT = 'megacrm:hide-values';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function useHideValues() {
  const [hidden, setHidden] = useState(read);
  useEffect(() => {
    const on = () => setHidden(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const toggle = useCallback(() => {
    try {
      localStorage.setItem(KEY, read() ? '0' : '1');
    } catch { /* sem storage: só nesta tela */ }
    setHidden((v) => !v);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { hidden, toggle };
}
