import { getSupabase } from '@/lib/supabase';

// Anexos do Chat Interno vivem num bucket PRIVADO (whatsapp-hub-chat), então
// não existe `getPublicUrl` como nos avatares — cada exibição precisa de uma
// URL assinada. Para não disparar uma assinatura por balão, o thread junta
// todos os paths visíveis e pede em lote (createSignedUrls), com cache em
// memória enquanto a URL não expira.

export const CHAT_BUCKET = 'whatsapp-hub-chat';
export const CHAT_MAX_BYTES = 25 * 1024 * 1024;

const TTL_SECONDS = 60 * 60;
// Renova um pouco antes do fim para uma URL não vencer no meio da sessão.
const RENEW_MARGIN_MS = 5 * 60 * 1000;

const cache = new Map<string, { url: string; expiresAt: number }>();

function cached(path: string): string | null {
  const hit = cache.get(path);
  if (!hit) return null;
  if (hit.expiresAt - RENEW_MARGIN_MS < Date.now()) {
    cache.delete(path);
    return null;
  }
  return hit.url;
}

// Assina os paths que ainda não estão em cache e devolve o mapa completo
// path → URL. Paths que o Storage recusar (arquivo removido, sem permissão)
// simplesmente não aparecem no resultado.
export async function signChatAttachments(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const result: Record<string, string> = {};
  const missing: string[] = [];

  for (const path of unique) {
    const hit = cached(path);
    if (hit) result[path] = hit;
    else missing.push(path);
  }
  if (missing.length === 0) return result;

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(CHAT_BUCKET)
    .createSignedUrls(missing, TTL_SECONDS);
  if (error || !data) return result;

  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  for (const entry of data) {
    if (!entry.signedUrl || !entry.path) continue;
    cache.set(entry.path, { url: entry.signedUrl, expiresAt });
    result[entry.path] = entry.signedUrl;
  }
  return result;
}

// Extensão a partir do nome do arquivo, para compor o path no bucket. Sem
// extensão o Storage ainda aceita, mas o download perde o "abrir com".
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot).toLowerCase();
}

// Path OBRIGATÓRIO pelas policies do bucket: <org_id>/<chat_id>/<uuid><ext>.
// A policy usa a 2ª pasta (chat_id) para checar pertencimento à sala.
export function chatAttachmentPath(orgId: string, chatId: string, fileName: string): string {
  return `${orgId}/${chatId}/${crypto.randomUUID()}${extensionOf(fileName)}`;
}

export function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
