// ============================================================================
// archive-media
// ----------------------------------------------------------------------------
// Copia a mídia recebida para o nosso Storage e corrige o content_type.
//
// Por que existe:
//   · As URLs assinadas da Meta EXPIRAM — anexos somem da conversa e não há
//     como recuperar. Já observado: mídia do mesmo dia retornando 404.
//   · O tipo vem errado. Vídeo do Instagram chega como 'document' e vira link
//     de download em vez de player. O tipo real só se sabe baixando e lendo o
//     Content-Type da resposta — que é exatamente o que fazemos aqui.
//
// Idempotente: se media_url já aponta para o nosso storage, não faz nada.
// Falha em silêncio (registra e retorna ok) — perder o arquivamento não pode
// derrubar o recebimento da mensagem, que é o que importa.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';

const BUCKET = 'whatsapp-hub-media';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — igual ao limite do bucket

// Content-Type → content_type do domínio. O tipo declarado no webhook é a
// fonte MENOS confiável; o do arquivo é a verdade.
function tipoDominio(mime: string): 'image' | 'audio' | 'video' | 'document' {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

function extensao(mime: string): string {
  const mapa: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'application/pdf': 'pdf',
  };
  return mapa[mime.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body: { message_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
  }
  const messageId = body.message_id;
  if (!messageId) return jsonResponse({ ok: false, error: 'message_id ausente.' }, { status: 400 });

  const admin = getAdminClient();
  const { data: msgRow } = await admin
    .from('messages')
    .select('id, org_id, media_url, content_type')
    .eq('id', messageId)
    .maybeSingle();
  const msg = msgRow as
    | { id: string; org_id: string; media_url: string | null; content_type: string }
    | null;

  if (!msg?.media_url) return jsonResponse({ ok: true, skipped: 'sem media_url' });
  // Já arquivado.
  if (msg.media_url.includes(`/${BUCKET}/`)) {
    return jsonResponse({ ok: true, skipped: 'já arquivado' });
  }
  // Links de página (ex.: instagram.com/reel/...) não são arquivo; baixar
  // traria o HTML da página, não a mídia.
  if (/^https?:\/\/(www\.)?(instagram|facebook)\.com\//i.test(msg.media_url)) {
    return jsonResponse({ ok: true, skipped: 'link de página, não arquivo' });
  }

  // Mídia do Zernio exige o Bearer da conta (mesma regra do transcribe-audio):
  // só enviamos a chave para o domínio deles.
  const headers: Record<string, string> = {};
  try {
    if (new URL(msg.media_url).hostname.endsWith('zernio.com')) {
      const creds = await loadAppCredentials(msg.org_id);
      if (creds.zernio_api_key) headers.Authorization = `Bearer ${creds.zernio_api_key}`;
    }
  } catch { /* URL malformada: segue sem header */ }

  let res: Response;
  try {
    res = await fetch(msg.media_url, { headers });
  } catch (err) {
    return jsonResponse({ ok: true, skipped: `download falhou: ${String(err)}` });
  }
  if (!res.ok) {
    // 404 aqui costuma ser link já expirado — nada a fazer além de registrar.
    return jsonResponse({ ok: true, skipped: `origem respondeu ${res.status}` });
  }

  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) return jsonResponse({ ok: true, skipped: 'arquivo vazio' });
  if (buf.byteLength > MAX_BYTES) {
    return jsonResponse({ ok: true, skipped: 'arquivo maior que o limite' });
  }

  const caminho = `${msg.org_id}/${msg.id}.${extensao(mime)}`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(caminho, buf, { contentType: mime, upsert: true });
  if (upErr) {
    return jsonResponse({ ok: true, skipped: `upload falhou: ${upErr.message}` });
  }

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(caminho);
  const novoTipo = tipoDominio(mime);

  const patch: Record<string, unknown> = { media_url: pub.publicUrl };
  // Corrige o tipo só quando o arquivo contradiz o que o webhook disse.
  if (novoTipo !== msg.content_type) patch.content_type = novoTipo;

  await admin.from('messages').update(patch).eq('id', msg.id);

  return jsonResponse({
    ok: true,
    bytes: buf.byteLength,
    mime,
    content_type: novoTipo,
    corrigiu_tipo: novoTipo !== msg.content_type,
  });
});
