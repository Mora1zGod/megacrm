import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

// Normalize a raw phone input to E.164 (+55…). Used by contact CRUD and the
// CSV importer to reject or repair input consistently across the app.
//
// Defaults country code to BR — change via the second arg when we internationalize.
export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode = 'BR',
): { ok: true; e164: string } | { ok: false; error: string } {
  if (!raw) return { ok: false, error: 'Telefone vazio' };
  const cleaned = raw.trim();
  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (!parsed || !parsed.isValid()) {
      return { ok: false, error: 'Número inválido' };
    }
    return { ok: true, e164: parsed.format('E.164') };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao validar',
    };
  }
}

// Máscara de digitação BR: "68999428493" → "(68) 99942-8493" (fixo: "(68) 3224-1234").
// Aceita valores já salvos com +55 e remove o código do país.
export function maskPhoneBR(raw: string | null | undefined): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  const split = rest.length === 9 ? 5 : 4;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

// Exibição: +5568999238046 → +55 68 99923-8046 (BR). Outros formatos ficam como estão.
export function formatPhoneDisplay(phone: string | null | undefined): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(4);
    return `+55 ${d.slice(2, 4)} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return phone;
}
