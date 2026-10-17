// Mídia privada (20261017140000_private_media.sql): o bucket whatsapp-hub-media deixa de ser público.
// O banco continua guardando a URL "pública" como identificador do arquivo (messages.media_url,
// contacts.profile_pic_url). Quem precisa do conteúdo:
//   * o servidor baixa pelo Storage com a service role (fetchMediaBytes);
//   * Zernio/UAZAPI (precisam buscar o arquivo por URL) recebem um link ASSINADO (signedMediaUrl).
import type { getAdminClient } from './supabase-admin.ts';

type Admin = ReturnType<typeof getAdminClient>;

export const MEDIA_BUCKET = 'whatsapp-hub-media';

// Caminho dentro do bucket a partir da URL guardada (public/sign/authenticated); null = URL de fora.
export function mediaPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/whatsapp-hub-media\/([^?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface MediaFetchResult {
  ok: boolean;
  status: number;
  bytes: Uint8Array;
  contentType: string;
}

// Baixa o arquivo: do nosso bucket pela Storage API (funciona com o bucket privado); de fora por fetch.
export async function fetchMediaBytes(admin: Admin, url: string, init?: RequestInit): Promise<MediaFetchResult> {
  const path = mediaPathFromUrl(url);
  if (path) {
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) return { ok: false, status: 404, bytes: new Uint8Array(), contentType: '' };
    return { ok: true, status: 200, bytes: new Uint8Array(await data.arrayBuffer()), contentType: (data.type || '').toLowerCase() };
  }
  const res = await fetch(url, init);
  if (!res.ok) return { ok: false, status: res.status, bytes: new Uint8Array(), contentType: '' };
  return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), contentType: (res.headers.get('content-type') ?? '').toLowerCase() };
}

// Link assinado para quem está fora (provedor de WhatsApp, IA). URL de fora volta igual.
export async function signedMediaUrl(admin: Admin, url: string, seconds: number): Promise<string> {
  const path = mediaPathFromUrl(url);
  if (!path) return url;
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error(`Não consegui gerar o link do arquivo: ${error?.message ?? 'sem link'}`);
  return data.signedUrl;
}
