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
