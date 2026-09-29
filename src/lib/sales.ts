// Regras puras da Nova Venda: calendário de parcelas, datas e formatação.
// Sem acesso a banco — testável isoladamente.

export type PaymentType = 'avista' | 'parcelado' | 'recorrente';
export type Frequency = 'semanal' | 'quinzenal' | 'mensal' | 'trimestral' | 'semestral' | 'anual';

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  semanal: 'Semanal',
  quinzenal: 'Quinzenal',
  mensal: 'Mensal',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};

export interface InstallmentDraft {
  number: number;
  total_count: number;
  due_date: string; // YYYY-MM-DD
  amount: number;
  status: 'pendente' | 'pago';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

// Soma um período a uma data YYYY-MM-DD. Meses respeitam o fim do mês
// (31/01 + 1 mês = 28/02 ou 29/02), sem "pular" para março.
export function addPeriod(iso: string, freq: Frequency, times: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (freq === 'semanal' || freq === 'quinzenal') {
    const days = (freq === 'semanal' ? 7 : 14) * times;
    const dt = new Date(y, m - 1, d + days);
    return toISODate(dt);
  }
  const months = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[freq] * times;
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  return toISODate(target);
}

const cents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => c / 100;

// Divide um valor em N parcelas em centavos exatos: a diferença do
// arredondamento vai para a última parcela, então a soma sempre fecha.
export function splitAmount(total: number, count: number): number[] {
  const t = cents(total);
  const base = Math.floor(t / count);
  const out = Array.from({ length: count }, () => base);
  out[count - 1] += t - base * count;
  return out.map(fromCents);
}

export interface ScheduleInput {
  type: PaymentType;
  total: number; // à vista / parcelado: total da venda. recorrente: valor de cada ciclo.
  firstDue: string;
  count: number; // parcelas (parcelado) ou ciclos (recorrente); à vista = 1
  frequency: Frequency;
  entry?: number; // parcelado: entrada diferente (1ª parcela)
  firstPaid?: boolean; // 1ª parcela (ou à vista) já recebida
}

export function buildSchedule(input: ScheduleInput): InstallmentDraft[] {
  const { type, total, firstDue, frequency } = input;
  const count = type === 'avista' ? 1 : Math.max(1, Math.floor(input.count || 1));
  let amounts: number[];
  if (type === 'avista') {
    amounts = [total];
  } else if (type === 'recorrente') {
    amounts = Array.from({ length: count }, () => total);
  } else if (input.entry && input.entry > 0 && count > 1) {
    const rest = Math.max(0, total - input.entry);
    amounts = [input.entry, ...splitAmount(rest, count - 1)];
  } else {
    amounts = splitAmount(total, count);
  }
  return amounts.map((amount, i) => ({
    number: i + 1,
    total_count: count,
    due_date: i === 0 ? firstDue : addPeriod(firstDue, frequency, i),
    amount,
    status: i === 0 && input.firstPaid ? 'pago' : 'pendente',
  }));
}

// Valor do negócio: soma das parcelas (no recorrente = ciclo × quantidade).
export function scheduleTotal(rows: InstallmentDraft[]): number {
  return fromCents(rows.reduce((s, r) => s + cents(r.amount), 0));
}

export function formatBRL(v: number, hidden = false): string {
  if (hidden) return 'R$ •••••';
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatBRLShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (Math.abs(v) >= 10_000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return formatBRL(v);
}

// "1.234,56" / "1234.56" / "1234" → número. Vazio/ inválido → NaN.
export function parseMoney(raw: string): number {
  const s = raw.trim().replace(/\s|R\$/g, '');
  if (!s) return NaN;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(normalized);
}

export function monthStartISO(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

export function monthRange(d = new Date()): { fromISO: string; toISO: string; fromDate: string; toDate: string } {
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { fromISO: from.toISOString(), toISO: to.toISOString(), fromDate: toISODate(from), toDate: toISODate(last) };
}
