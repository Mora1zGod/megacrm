import { useEffect, useState } from 'react';
import type { SlaConfig } from '@/hooks/useSlaConfig';

export type SlaLevel = 'ok' | 'warn' | 'late';

// Há quanto tempo o contato espera resposta e em que faixa do SLA está.
export function slaState(waitingSince: string | null | undefined, sla: SlaConfig, now: number): { minutes: number; level: SlaLevel } | null {
  if (!waitingSince) return null;
  const minutes = Math.max(0, Math.floor((now - new Date(waitingSince).getTime()) / 60000));
  const level: SlaLevel = minutes >= sla.late ? 'late' : minutes >= sla.warn ? 'warn' : 'ok';
  return { minutes, level };
}

export function formatWait(minutes: number): string {
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = minutes % 60;
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Relógio que re-renderiza a cada `ms` (padrão 30s) — mantém os contadores de
// espera vivos sem depender de mensagens novas.
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
