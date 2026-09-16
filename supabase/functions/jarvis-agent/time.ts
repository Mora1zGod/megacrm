// ============================================================================
// jarvis-agent/time.ts — janelas de tempo no fuso do usuário
// ----------------------------------------------------------------------------
// "Quantas conversas novas hoje" só está certo se "hoje" for o dia no Acre
// (America/Rio_Branco, UTC-5), não em UTC. Sem dependência externa: Intl já
// resolve o offset de qualquer fuso no runtime do Deno.
// ============================================================================

export type Periodo = 'hoje' | 'ontem' | 'ultimos_7_dias' | 'ultimos_30_dias' | 'este_mes';

export const PERIODOS: Periodo[] = [
  'hoje',
  'ontem',
  'ultimos_7_dias',
  'ultimos_30_dias',
  'este_mes',
];

// Offset do fuso (em minutos) no instante dado. Positivo a leste de Greenwich.
function offsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Intl devolve hour 24 para meia-noite em alguns runtimes; normaliza.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  // Arredonda para minuto inteiro: o Intl não devolve milissegundos, então sem
  // isso os ms do instante vazariam para o offset e a meia-noite local sairia
  // com resto (ex.: 05:00:00.250Z em vez de 05:00:00.000Z).
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

// Instante UTC correspondente à meia-noite local de (hoje + dayOffset).
function startOfLocalDay(timeZone: string, dayOffset: number, base = new Date()): Date {
  const off = offsetMinutes(base, timeZone);
  const local = new Date(base.getTime() + off * 60_000);
  local.setUTCDate(local.getUTCDate() + dayOffset);
  local.setUTCHours(0, 0, 0, 0);
  // Segunda passada com o offset do próprio dia alvo (cobre horário de verão em
  // fusos que têm; o Acre não tem).
  const guess = new Date(local.getTime() - off * 60_000);
  return new Date(local.getTime() - offsetMinutes(guess, timeZone) * 60_000);
}

export interface Janela {
  /** ISO inclusivo. */
  fromISO: string;
  /** ISO exclusivo. */
  toISO: string;
  label: string;
}

export function resolverPeriodo(periodo: string | undefined, timeZone: string): Janela {
  const p = (periodo ?? 'hoje').toLowerCase() as Periodo;
  const hoje = startOfLocalDay(timeZone, 0);
  const amanha = startOfLocalDay(timeZone, 1);

  switch (p) {
    case 'ontem':
      return {
        fromISO: startOfLocalDay(timeZone, -1).toISOString(),
        toISO: hoje.toISOString(),
        label: 'ontem',
      };
    case 'ultimos_7_dias':
      return {
        fromISO: startOfLocalDay(timeZone, -6).toISOString(),
        toISO: amanha.toISOString(),
        label: 'últimos 7 dias (incluindo hoje)',
      };
    case 'ultimos_30_dias':
      return {
        fromISO: startOfLocalDay(timeZone, -29).toISOString(),
        toISO: amanha.toISOString(),
        label: 'últimos 30 dias (incluindo hoje)',
      };
    case 'este_mes': {
      const off = offsetMinutes(new Date(), timeZone);
      const local = new Date(Date.now() + off * 60_000);
      const diasDesdeDia1 = local.getUTCDate() - 1;
      return {
        fromISO: startOfLocalDay(timeZone, -diasDesdeDia1).toISOString(),
        toISO: amanha.toISOString(),
        label: 'este mês (do dia 1 até hoje)',
      };
    }
    case 'hoje':
    default:
      return { fromISO: hoje.toISOString(), toISO: amanha.toISOString(), label: 'hoje' };
  }
}

/** "16/09/2026 14:32" no fuso do usuário — para o modelo saber que horas são. */
export function agoraLocal(timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date());
}

export function dataHoraLocal(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(iso));
}
