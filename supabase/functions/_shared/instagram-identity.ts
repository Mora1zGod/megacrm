// ============================================================================
// _shared/instagram-identity.ts — nome de exibição × @usuário do contato do Instagram
// ----------------------------------------------------------------------------
// contacts.name               = nome de exibição (ex.: "danielalves")
// contacts.instagram_username = o @ (ex.: "danielgato2015.da")
// Regra: o nome só é preenchido automaticamente quando está vazio ou ainda é o próprio @ (ou o id) —
// nome editado pela equipe nunca é sobrescrito. Usado pelo zernio-webhook e pelo backfill.
// ============================================================================

import type { InstagramProfile } from './zernio.ts';

// "Claramente um @": só minúsculas/dígitos/ponto/sublinhado, até 30, e com ponto, sublinhado ou
// dígito (um nome como "danielalves" pode ser os dois — nesse caso não chuta).
export function looksLikeUsername(s: string | null | undefined): boolean {
  if (!s) return false;
  const v = s.trim().replace(/^@/, '');
  return /^[a-z0-9._]{1,30}$/.test(v) && /[._\d]/.test(v);
}

export function cleanUsername(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().replace(/^@/, '');
  return v ? v : null;
}

export interface IgCurrent { name: string | null; username: string | null }
export interface IgPatch { name?: string; instagram_username?: string }

export function nameIsAutomatic(cur: IgCurrent, igId: string, username: string | null): boolean {
  const n = cur.name?.trim();
  return !n || n === cur.username || n === username || n === igId;
}

export function decideIgIdentity(input: {
  current: IgCurrent;
  igId: string;
  payloadName: string | null;
  payloadUsername: string | null;
  profile: InstagramProfile | null;
}): IgPatch {
  const { current, igId, profile } = input;
  const payloadName = input.payloadName?.trim() || null;
  const explicitUser = cleanUsername(profile?.username) ?? cleanUsername(input.payloadUsername);
  const inferredUser = !explicitUser && looksLikeUsername(payloadName) && payloadName !== profile?.name
    ? cleanUsername(payloadName)
    : null;
  const username = explicitUser ?? inferredUser ?? current.username;
  const displayRaw = profile?.name?.trim() || (payloadName && payloadName !== username ? payloadName : null);
  // Nunca deixa o id numérico virar nome.
  const display = displayRaw && displayRaw !== igId ? displayRaw : null;

  const patch: IgPatch = {};
  if (nameIsAutomatic(current, igId, username)) {
    const fallback = current.name?.trim() ? null : (username ?? (payloadName !== igId ? payloadName : null));
    const next = display ?? fallback;
    if (next && next !== current.name) patch.name = next;
  }
  if (username && username !== current.username) patch.instagram_username = username;
  return patch;
}

// Vale a pena consultar o perfil no Zernio? Só quando falta o @ ou o nome ainda é automático, e no
// máximo 1x por semana por contato.
export function needsProfileLookup(cur: IgCurrent, igId: string, checkedAt: string | null): boolean {
  if (checkedAt && Date.now() - new Date(checkedAt).getTime() < 7 * 24 * 3600 * 1000) return false;
  return !cur.username || nameIsAutomatic(cur, igId, cur.username);
}
