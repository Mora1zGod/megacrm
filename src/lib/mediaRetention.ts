import { zip } from 'fflate';
import { getSupabase } from '@/lib/supabase';

// Retenção de mídia (20261017120000_media_retention.sql): contato com esta tag nunca perde a mídia.
export const KEEP_MEDIA_TAG = 'guardar-midia';

const db = () => getSupabase().schema('whatsapp_hub');

// Tag da org (a migração já cria em toda org; se faltar, tenta criar).
export async function getKeepTagId(create = false): Promise<string | null> {
  const { data } = await db().from('tags').select('id, name').ilike('name', KEEP_MEDIA_TAG).limit(1);
  const id = (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
  if (id || !create) return id;
  const { data: created, error } = await db().from('tags').insert({ name: KEEP_MEDIA_TAG, color: '#16A34A' }).select('id').single();
  if (error) throw new Error(error.message);
  return (created as { id: string }).id;
}

export async function contactKeepsMedia(contactId: string): Promise<boolean> {
  const tagId = await getKeepTagId(false);
  if (!tagId) return false;
  const { data } = await db().from('contact_tags').select('tag_id').eq('contact_id', contactId).eq('tag_id', tagId).limit(1);
  return (data ?? []).length > 0;
}

export async function setContactKeepsMedia(contactId: string, keep: boolean): Promise<void> {
  const tagId = await getKeepTagId(keep);
  if (!tagId) return;
  if (keep) {
    const { error } = await db().from('contact_tags').insert({ contact_id: contactId, tag_id: tagId });
    if (error && !/duplicate key/i.test(error.message)) throw new Error(error.message);
  } else {
    const { error } = await db().from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId);
    if (error) throw new Error(error.message);
  }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'application/pdf': 'pdf',
};

function fileName(url: string, createdAt: string, i: number, mime: string): string {
  const last = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '').replace(/[^\w.\-]+/g, '_');
  const stamp = createdAt.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(last);
  const ext = hasExt ? '' : `.${EXT[mime.split(';')[0]] ?? 'bin'}`;
  return `${String(i + 1).padStart(3, '0')}_${stamp}_${last || 'arquivo'}${ext}`;
}

export interface ZipResult { files: number; failed: number; bytes: number }

// "Baixar mídias da conversa (.zip)": baixa no navegador cada arquivo que ainda existe e monta o .zip.
export async function downloadConversationMedia(conversationId: string, label: string, onProgress?: (done: number, total: number) => void): Promise<ZipResult> {
  let q = await db().from('messages').select('id, media_url, created_at, media_purged_at')
    .eq('conversation_id', conversationId).not('media_url', 'is', null).order('created_at');
  if (q.error && /media_purged_at/.test(q.error.message)) {
    q = await db().from('messages').select('id, media_url, created_at').eq('conversation_id', conversationId).not('media_url', 'is', null).order('created_at') as typeof q;
  }
  if (q.error) throw new Error(q.error.message);
  const rows = ((q.data ?? []) as Array<{ id: string; media_url: string; created_at: string; media_purged_at?: string | null }>)
    .filter((r) => /^https?:\/\//i.test(r.media_url) && !r.media_purged_at);
  const entries: Record<string, Uint8Array> = {};
  let failed = 0, bytes = 0, done = 0;
  for (const [i, r] of rows.entries()) {
    try {
      const res = await fetch(r.media_url);
      if (!res.ok) throw new Error(String(res.status));
      const buf = new Uint8Array(await res.arrayBuffer());
      entries[fileName(r.media_url, r.created_at, i, res.headers.get('content-type') ?? '')] = buf;
      bytes += buf.byteLength;
    } catch {
      failed++;
    }
    onProgress?.(++done, rows.length);
  }
  const files = Object.keys(entries).length;
  if (!files) return { files: 0, failed, bytes: 0 };
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    // Mídia já é comprimida: nível 0 (só empacota) deixa rápido e não trava o navegador.
    zip(entries, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `midias-${label.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'conversa'}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return { files, failed, bytes };
}
