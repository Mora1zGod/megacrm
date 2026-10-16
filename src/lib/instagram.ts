// @ do Instagram para mostrar embaixo do nome de exibição (em cinza). Não repete quando o nome
// ainda é o próprio @ (contato antigo, nome de exibição ainda não veio).
export function instagramHandle(contact: { name?: string | null; instagram_username?: string | null } | null | undefined): string | null {
  const u = contact?.instagram_username?.trim().replace(/^@/, '');
  if (!u) return null;
  if ((contact?.name ?? '').trim().replace(/^@/, '').toLowerCase() === u.toLowerCase()) return null;
  return `@${u}`;
}
