// Dinheiro SEMPRE em centavos (inteiro). Nada de float para conta.
// Formatação e leitura feitas por texto/inteiro.

export function formatBRL(cents: number | null | undefined, opts: { sign?: boolean } = {}): string {
  const c = Math.trunc(Number(cents ?? 0));
  const neg = c < 0;
  const abs = Math.abs(c);
  const reais = Math.trunc(abs / 100);
  const cent = String(abs % 100).padStart(2, '0');
  const int = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const prefix = neg ? '-' : opts.sign && c > 0 ? '+' : '';
  return `${prefix}R$ ${int},${cent}`;
}

// "1.234,56" → 123456. Aceita "1234", "1234,5", "R$ 1.234,56". Retorna null se inválido.
export function parseBRL(text: string): number | null {
  const t = text.replace(/R\$|\s/g, '').trim();
  if (!t) return null;
  if (!/^-?[\d.]*(,\d{0,2})?$/.test(t)) return null;
  const neg = t.startsWith('-');
  const [intPart, decPart = ''] = t.replace('-', '').split(',');
  const int = intPart.replace(/\./g, '') || '0';
  if (!/^\d+$/.test(int)) return null;
  const cents = Number(int) * 100 + Number(decPart.padEnd(2, '0') || '0');
  return neg ? -cents : cents;
}

// Máscara de digitação estilo app de banco: só dígitos, vírgula fixa nas 2 últimas casas.
export function maskMoneyInput(text: string): { cents: number; display: string } {
  const digits = text.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
  const cents = digits ? Number(digits) : 0;
  return { cents, display: digits ? formatBRL(cents).replace('R$ ', '') : '' };
}

// Divide em parcelas como o banco faz: resto na 1ª.
export function splitInstallments(totalCents: number, n: number): number[] {
  if (n < 1 || totalCents <= 0) return [];
  const base = Math.trunc(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i === 0 ? rest : 0));
}
