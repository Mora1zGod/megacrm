// Busca das listas (Contas a pagar/receber, Notas de entrada…): texto + valor.
//
// Valor: "898,85", "1.250", "R$ 1250", "898".
//  - sem vírgula = começo dos reais ("898" acha 898,85; "1250" acha 1.250,00);
//  - com vírgula = reais exatos + começo dos centavos ("898,8" acha 898,80–898,89).
// Texto: sem acento e sem diferença de maiúscula; números (CNPJ, chave, nº da nota) também
// acham digitados com ou sem pontuação ("02.828.376" acha "02828376000155").

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const onlyDigits = (s: string) => s.replace(/\D/g, '');

export function isMoneyQuery(q: string): boolean {
  const t = q.trim().toLowerCase();
  return /^(r\$)?\s*[\d.,\s]+$/.test(t) && /\d/.test(t);
}

export function moneyMatch(q: string, cents: Array<number | null | undefined>): boolean {
  const t = q.trim().toLowerCase();
  if (!isMoneyQuery(t)) return false;
  const exact = t.includes(',');
  const [rPart, cPart = ''] = t.split(',');
  const digits = onlyDigits(t);
  const wantReais = String(Number(onlyDigits(rPart) || '0'));
  const wantCents = onlyDigits(cPart).slice(0, 2);
  return cents.some((c) => {
    if (c === null || c === undefined) return false;
    const abs = Math.abs(c);
    const reais = String(Math.floor(abs / 100));
    if (exact) return reais === wantReais && String(abs % 100).padStart(2, '0').startsWith(wantCents);
    return reais.startsWith(digits);
  });
}

// Texto em qualquer um dos campos (os números também comparados só pelos dígitos).
export function textMatch(q: string, fields: Array<string | null | undefined>): boolean {
  const t = strip(q.trim());
  if (!t) return true;
  const d = onlyDigits(t);
  return fields.some((f) => {
    if (!f) return false;
    if (strip(f).includes(t)) return true;
    return d.length >= 3 && d.length === t.replace(/[\s./-]/g, '').length && onlyDigits(f).includes(d);
  });
}

export function searchMatch(q: string, fields: Array<string | null | undefined>, cents: Array<number | null | undefined> = []): boolean {
  if (!q.trim()) return true;
  return moneyMatch(q, cents) || textMatch(q, fields);
}
