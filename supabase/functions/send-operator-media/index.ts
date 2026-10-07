// ============================================================================
// send-operator-media
// ----------------------------------------------------------------------------
// Operador anexa uma mídia (imagem/áudio/vídeo/documento) numa conversa. O
// arquivo chega como multipart/form-data; subimos ao Zernio via
// /media/upload-direct (máx 25MB), enviamos a mensagem com attachmentUrl pela
// inbox 1:1 e persistimos a linha (content_type + media_url = url do Zernio)
// para o thread renderizar. A ZERNIO_API_KEY nunca toca o browser.
//
// Notas privadas NÃO passam por aqui — são texto e nunca vão ao Zernio.
// ============================================================================

import { requirePermission, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { ZernioError, uploadMediaDirect } from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';
import { friendlySendError, sendInboxWithResolve } from '../_shared/inbox-delivery.ts';

const MAX_BYTES = 25 * 1024 * 1024;

function classify(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

// Encaminhar: o servidor de origem muitas vezes devolve "application/octet-stream"
// (ou nem manda o tipo), e o Zernio recusa tipo genérico ("Invalid multipart
// form data"). Descobre o tipo real pelos primeiros bytes do arquivo e, se não
// der, pela extensão da URL.
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};
const MIME_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MIME).reverse().map(([ext, mime]) => [mime, ext]),
);

function sniffMime(b: Uint8Array): string | null {
  const at = (o: number, s: string) => s.split('').every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if (at(0, '%PDF')) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (at(0, '#!AMR')) return 'audio/amr';
  if (at(4, 'ftyp')) {
    if (at(8, 'M4A')) return 'audio/mp4';
    if (at(8, 'qt')) return 'video/quicktime';
    if (at(8, '3gp')) return 'video/3gpp';
    return 'video/mp4';
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/msword';
  if (at(0, 'PK')) {
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 64 * 1024)));
    if (head.includes('word/')) return EXT_MIME.docx;
    if (head.includes('xl/')) return EXT_MIME.xlsx;
    if (head.includes('ppt/')) return EXT_MIME.pptx;
    return 'application/zip';
  }
  return null;
}

function urlFileName(url: string): string | null {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last.slice(-120) : null;
  } catch {
    return null;
  }
}

function resolveForwardMime(bytes: Uint8Array, headerMime: string, url: string): string {
  const generic = !headerMime || /octet-stream|multipart|^binary\//i.test(headerMime);
  if (!generic) return headerMime;
  const sniffed = sniffMime(bytes);
  if (sniffed) return sniffed;
  const ext = urlFileName(url)?.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/pdf';
}

type QuotedMsg ={ id: string; zernio_message_id: string | null; platform_message_id: string | null };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    // Permissão real (perfil + exceções), validada no servidor: "Responder conversa".
    const caller = await requirePermission(req, 'inbox.reply');

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonResponse({ ok: false, error: 'Esperado multipart/form-data.' }, { status: 400 });
    }

    const conversationId = String(form.get('conversation_id') ?? '').trim();
    const caption = String(form.get('content') ?? '').trim();
    const voiceNote = String(form.get('voice_note') ?? '') === 'true';
    const file = form.get('file');
    // Encaminhar: em vez de arquivo, o id de uma mensagem de mídia (de qualquer
    // conversa da org). O servidor baixa a mídia e reenvia.
    const forwardId = String(form.get('forward_message_id') ?? '').trim() || null;
    const replyToId = String(form.get('reply_to_message_id') ?? '').trim() || null;

    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'conversation_id ausente.' }, { status: 400 });
    }
    if (!(file instanceof File) && !forwardId) {
      return jsonResponse({ ok: false, error: 'Arquivo ausente.' }, { status: 400 });
    }
    if (file instanceof File && file.size > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'Arquivo excede 25MB.' }, { status: 400 });
    }

    const admin = getAdminClient();

    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, org_id, contact_id, channel, channel_id, zernio_conversation_id, zernio_account_id, provider')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) return jsonResponse({ ok: false, error: convErr.message }, { status: 500 });
    if (!conv) return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    const convRow = conv as {
      id: string;
      org_id: string;
      contact_id: string;
      channel: 'whatsapp' | 'instagram' | null;
      channel_id?: string | null;
      zernio_conversation_id: string | null;
      zernio_account_id?: string | null;
      provider?: string | null;
    };
    // Cross-check de org: a conversa deve pertencer à org do caller.
    if (convRow.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
    }
    const channel = convRow.channel === 'instagram' ? 'instagram' : 'whatsapp';

    // Mesma regra de send-operator-message: no Instagram, 24h-7dias exige a
    // tag HUMAN_AGENT (só vale porque este endpoint só atende operador/admin
    // autenticado — nunca a IA). Acima de 7 dias, bloqueia antes de gastar
    // upload de mídia.
    let humanAgentTag = false;
    if (channel === 'instagram') {
      const { data: lastInbound } = await admin
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastInboundAt = (lastInbound as { created_at?: string } | null)?.created_at;
      const hoursSince = lastInboundAt
        ? (Date.now() - new Date(lastInboundAt).getTime()) / (60 * 60 * 1000)
        : Infinity;
      if (hoursSince > 24) {
        if (hoursSince > 24 * 7) {
          return jsonResponse(
            {
              ok: false,
              error: 'Mais de 7 dias desde a última mensagem do contato no Instagram — a Meta não permite mais nenhuma resposta nesta conversa.',
            },
            { status: 400 },
          );
        }
        humanAgentTag = true;
      }
    }

    const zernio = await loadOrgZernioContext(admin, caller.orgId, convRow.zernio_account_id ?? null);

    // Mensagem citada (mesma conversa).
    let quoted: QuotedMsg | null = null;
    if (replyToId) {
      const { data: q } = await admin
        .from('messages').select('*')
        .eq('id', replyToId).eq('conversation_id', conversationId).eq('org_id', caller.orgId)
        .maybeSingle();
      if (!q) return jsonResponse({ ok: false, error: 'Mensagem citada não encontrada nesta conversa.' }, { status: 400 });
      quoted = q as QuotedMsg;
    }

    let contentType: 'image' | 'audio' | 'video' | 'document';
    let mime: string;
    let filename: string;
    let bytes: Uint8Array;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      mime = resolveForwardMime(bytes, (file.type || '').toLowerCase(), `https://x/${encodeURIComponent(file.name || '')}`);
      contentType = classify(mime);
      filename = voiceNote ? 'voice-note.ogg' : (file.name || `arquivo-${contentType}.${MIME_EXT[mime] ?? 'bin'}`);
    } else {
      const { data: src } = await admin
        .from('messages')
        .select('id, org_id, content_type, media_url, is_private_note')
        .eq('id', forwardId!)
        .eq('org_id', caller.orgId)
        .maybeSingle();
      const srcRow = src as { content_type: string; media_url: string | null; is_private_note: boolean } | null;
      if (!srcRow || srcRow.is_private_note || !srcRow.media_url || !/^https?:\/\//i.test(srcRow.media_url)) {
        return jsonResponse({ ok: false, error: 'Mídia original não encontrada para encaminhar.' }, { status: 404 });
      }
      // Mídia recebida pelo Zernio exige a API key; as demais são públicas.
      const needsKey = /^https:\/\/zernio\.com\/api\/v1\//i.test(srcRow.media_url);
      const upstream = await fetch(srcRow.media_url, needsKey ? { headers: { Authorization: `Bearer ${zernio.apiKey}` } } : undefined);
      if (!upstream.ok) {
        return jsonResponse({ ok: false, error: `Não consegui baixar a mídia original (${upstream.status}). Ela pode ter expirado.` }, { status: 502 });
      }
      bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) {
        return jsonResponse({ ok: false, error: 'Arquivo excede 25MB.' }, { status: 400 });
      }
      const headerMime = (upstream.headers.get('content-type')?.split(';')[0] ?? '').trim().toLowerCase();
      mime = resolveForwardMime(bytes, headerMime, srcRow.media_url);
      contentType = (['image', 'audio', 'video', 'document'] as const).includes(srcRow.content_type as never)
        ? (srcRow.content_type as 'image' | 'audio' | 'video' | 'document')
        : classify(mime);
      const ext = MIME_EXT[mime] ?? (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('quicktime', 'mov');
      // Documento: mantém o nome original quando a URL traz um.
      const original = contentType === 'document' ? urlFileName(srcRow.media_url) : null;
      filename = original && !/^[0-9a-f-]{20,}\./i.test(original) ? original : `encaminhado-${contentType}.${ext}`;
    }

    // 1. Sobe a mídia ao Zernio (host da URL usada no attachmentUrl, inclusive
    //    para conversas UAZAPI que enviam a URL direto pela instância).
    const mediaUrl = await uploadMediaDirect({ apiKey: zernio.apiKey, bytes, filename, contentType: mime });

    // 2. Resolve a conversa 1:1 no Zernio (por canal) e envia a mídia, curando
    //    o id salvo se o Zernio o rejeitar.
    const { data: contactRow } = await admin
      .from('contacts')
      .select('phone, instagram_id')
      .eq('id', convRow.contact_id)
      .maybeSingle();
    const contact = (contactRow as { phone?: string; instagram_id?: string } | null) ?? {};

    const zernioMessageId = await sendInboxWithResolve(
      admin,
      {
        conversationRowId: conversationId,
        orgId: caller.orgId,
        channel,
        phone: contact.phone ?? null,
        instagramId: contact.instagram_id ?? null,
        storedZernioConversationId: convRow.zernio_conversation_id,
        channelId: convRow.channel_id ?? null,
        zernioAccountId: convRow.zernio_account_id ?? null,
        provider: convRow.provider ?? null,
      },
      {
        attachmentUrl: mediaUrl,
        voiceNote,
        text: caption || undefined,
        humanAgentTag,
        ...(quoted?.platform_message_id ? { replyTo: quoted.platform_message_id } : {}),
        ...(quoted?.zernio_message_id ? { replyIdUazapi: quoted.zernio_message_id } : {}),
      },
    );

    // 4. Persiste a linha (media_url = url do Zernio, baixável pelo thread).
    const { data: inserted, error: insErr } = await admin
      .from('messages')
      .insert({
        org_id: caller.orgId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'operator',
        sender_id: caller.userId,
        content_type: contentType,
        content: caption || null,
        media_url: mediaUrl,
        zernio_message_id: zernioMessageId,
        meta_status: 'sent',
        is_private_note: false,
        ...(quoted ? { reply_to_id: quoted.id } : {}),
        ...(forwardId ? { forwarded: true } : {}),
      })
      .select('id')
      .single();
    if (insErr) return jsonResponse({ ok: false, error: insErr.message }, { status: 500 });

    await admin
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        status: 'human_active',
        ai_paused: true,
        assigned_to: caller.userId,
      })
      .eq('id', conversationId);

    return jsonResponse({
      ok: true,
      message_id: (inserted as { id: string }).id,
      media_url: mediaUrl,
      sent_to_zernio: true,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    if (err instanceof ZernioError) {
      return jsonResponse({ ok: false, error: friendlySendError(err) }, { status: err.status === 401 ? 401 : 502 });
    }
    console.error('send-operator-media error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
