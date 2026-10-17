import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Mídia privada (20261017140000_private_media.sql): o bucket whatsapp-hub-media deixa de ser público.
// O banco continua guardando a URL "pública" (messages.media_url, contacts.profile_pic_url) só como
// identificador do arquivo; a tela troca por um link ASSINADO (vale 1 h) na hora de mostrar.
// Quem pode assinar: membro da org com acesso à conversa daquela mídia (policy em storage.objects).
// Pedidos de vários arquivos na mesma tela vão juntos (createSignedUrls) e ficam em cache ~50 min.

export const MEDIA_BUCKET = 'whatsapp-hub-media';
const TTL_S = 3600;
const REUSE_MS = 50 * 60 * 1000;

export function mediaPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/whatsapp-hub-media\/([^?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

const cache = new Map<string, { url: string; at: number }>();
const waiting = new Map<string, Array<(u: string | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const paths = [...waiting.keys()];
  const cbs = new Map(waiting);
  waiting.clear();
  for (let i = 0; i < paths.length; i += 100) {
    const part = paths.slice(i, i + 100);
    let signed: Array<{ path: string | null; signedUrl: string | null; error: string | null }> = [];
    try {
      const { data, error } = await getSupabase().storage.from(MEDIA_BUCKET).createSignedUrls(part, TTL_S);
      if (!error && data) signed = data as typeof signed;
    } catch { /* sem permissão ou rede: devolve null (a tela cai na URL original) */ }
    const byPath = new Map(signed.filter((s) => s.path && s.signedUrl && !s.error).map((s) => [s.path as string, s.signedUrl as string]));
    for (const p of part) {
      const u = byPath.get(p) ?? null;
      if (u) cache.set(p, { url: u, at: Date.now() });
      for (const cb of cbs.get(p) ?? []) cb(u);
    }
  }
}

// Link assinado de um arquivo do bucket; URL de fora (Zernio, CDN, etc.) volta igual.
export function signMediaUrl(url: string): Promise<string> {
  const path = mediaPath(url);
  if (!path) return Promise.resolve(url);
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < REUSE_MS) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    const list = waiting.get(path) ?? [];
    // Sem link assinado (ex.: SQL ainda não rodado e bucket ainda público): usa a URL original.
    list.push((u) => resolve(u ?? url));
    waiting.set(path, list);
    if (!timer) timer = setTimeout(() => void flush(), 15);
  });
}

// Para <img>/<video>/<a>: devolve null enquanto assina (não pisca link quebrado).
export function useMediaUrl(url: string | null | undefined): string | null {
  const path = mediaPath(url);
  const cached = path ? cache.get(path) : undefined;
  const fresh = cached && Date.now() - cached.at < REUSE_MS ? cached.url : null;
  const [signed, setSigned] = useState<string | null>(path ? fresh : (url ?? null));
  useEffect(() => {
    if (!url) { setSigned(null); return; }
    if (!mediaPath(url)) { setSigned(url); return; }
    let alive = true;
    void signMediaUrl(url).then((u) => { if (alive) setSigned(u); });
    return () => { alive = false; };
  }, [url]);
  return signed;
}

// Abrir arquivo em outra aba (link de Arquivos, documento): a aba abre na hora (não cai no bloqueio de pop-up)
// e recebe o link assinado assim que ele chega.
export function openMedia(url: string): void {
  if (!mediaPath(url)) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  void signMediaUrl(url).then((u) => { if (w) w.location.href = u; else window.open(u, '_blank', 'noopener,noreferrer'); });
}
