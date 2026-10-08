// ============================================================================
// send-wa-notification
// ----------------------------------------------------------------------------
// Avisos internos por WhatsApp: sai pelo número UAZAPI escolhido em
// Configurações → Notificações WhatsApp (wa_notify_settings.channel_id) para os
// destinatários cadastrados (wa_notify_recipients: pessoa ou grupo @g.us).
// UAZAPI não tem janela de 24 h — por isso não usa a API oficial.
//
// Body: { recipient_ids: string[], text?: string, images_base64?: string[] (PNG, até 5) }
// Imagens vão para o Storage público whatsapp-hub-media/<org>/notificacoes/…
// e são enviadas com /send/media, na ordem (legenda = texto na 1ª, se couber).
// Não grava conversa/mensagem no Atendimento (é aviso interno).
// ============================================================================

import { AuthError, callerCan, requireOrgCaller } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getChannelById } from '../_shared/channels.ts';
import { uazapiContextFromChannel, uazapiSendMedia, uazapiSendText } from '../_shared/uazapi.ts';

const MAX_RECIPIENTS = 20;
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_CAPTION = 900;

interface Payload { recipient_ids?: string[]; text?: string; images_base64?: string[] }

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const caller = await requireOrgCaller(req);
    // Quem vê o financeiro ou cuida dos números pode mandar aviso.
    if (!(await callerCan(caller, 'financial.ledger_view')) && !(await callerCan(caller, 'settings.channels'))) {
      throw new AuthError('Seu perfil não tem permissão para enviar avisos.', 403);
    }

    let body: Payload;
    try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 }); }
    const ids = [...new Set((body.recipient_ids ?? []).filter((x) => typeof x === 'string' && x))];
    const text = (body.text ?? '').trim();
    if (!ids.length) return jsonResponse({ ok: false, error: 'Escolha pelo menos um destinatário.' }, { status: 400 });
    if (ids.length > MAX_RECIPIENTS) return jsonResponse({ ok: false, error: `Até ${MAX_RECIPIENTS} destinatários por envio.` }, { status: 400 });
    const images = Array.isArray(body.images_base64) ? body.images_base64.filter((x) => typeof x === 'string' && x) : [];
    if (images.length > MAX_IMAGES) return jsonResponse({ ok: false, error: `Até ${MAX_IMAGES} imagens por envio.` }, { status: 400 });
    if (!text && !images.length) return jsonResponse({ ok: false, error: 'Nada para enviar.' }, { status: 400 });
    if (text.length > MAX_TEXT) return jsonResponse({ ok: false, error: `Texto acima de ${MAX_TEXT} caracteres.` }, { status: 400 });

    const admin = getAdminClient();
    const { data: cfg } = await admin.from('wa_notify_settings').select('channel_id').eq('org_id', caller.orgId).maybeSingle();
    const channelId = (cfg as { channel_id: string | null } | null)?.channel_id;
    if (!channelId) return jsonResponse({ ok: false, error: 'Escolha o número que envia os avisos em Configurações → Notificações WhatsApp.' }, { status: 400 });
    const channel = await getChannelById(admin, channelId);
    if (!channel || channel.org_id !== caller.orgId || channel.provider !== 'uazapi') {
      return jsonResponse({ ok: false, error: 'O número de avisos precisa ser um número UAZAPI desta organização.' }, { status: 400 });
    }
    if (!channel.is_active) return jsonResponse({ ok: false, error: `O número "${channel.label}" está desativado.` }, { status: 400 });

    const { data: recs, error: recErr } = await admin.from('wa_notify_recipients').select('id, name, phone')
      .eq('org_id', caller.orgId).eq('is_active', true).in('id', ids);
    if (recErr) throw recErr;
    const recipients = (recs ?? []) as Array<{ id: string; name: string; phone: string }>;
    if (!recipients.length) return jsonResponse({ ok: false, error: 'Destinatários não encontrados (ou inativos).' }, { status: 400 });

    const imageUrls: string[] = [];
    for (const b64 of images) {
      const bytes = decodeBase64(b64);
      if (bytes.length > MAX_IMAGE_BYTES) return jsonResponse({ ok: false, error: 'Imagem acima de 5 MB.' }, { status: 400 });
      if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
        return jsonResponse({ ok: false, error: 'A imagem precisa ser PNG.' }, { status: 400 });
      }
      const path = `${caller.orgId}/notificacoes/${crypto.randomUUID()}.png`;
      const { error: upErr } = await admin.storage.from('whatsapp-hub-media').upload(path, bytes, { contentType: 'image/png', upsert: false });
      if (upErr) throw new Error(`Não consegui guardar a imagem: ${upErr.message}`);
      imageUrls.push(admin.storage.from('whatsapp-hub-media').getPublicUrl(path).data.publicUrl);
    }

    const uctx = await uazapiContextFromChannel(channel);
    const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
    for (const r of recipients) {
      try {
        if (imageUrls.length) {
          const fits = text.length <= MAX_CAPTION;
          for (let i = 0; i < imageUrls.length; i++) {
            await uazapiSendMedia(uctx, { phone: r.phone, type: 'image', fileUrl: imageUrls[i], caption: i === 0 && fits ? text || undefined : undefined });
          }
          if (text && !fits) await uazapiSendText(uctx, { phone: r.phone, text });
        } else {
          await uazapiSendText(uctx, { phone: r.phone, text });
        }
        results.push({ id: r.id, name: r.name, ok: true });
      } catch (e) {
        results.push({ id: r.id, name: r.name, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const sent = results.filter((x) => x.ok).length;
    console.log(JSON.stringify({ event: 'wa_notification_sent', org_id: caller.orgId, user_id: caller.userId, channel_id: channel.id, sent, failed: results.length - sent, images: imageUrls.length }));
    return jsonResponse({ ok: sent > 0, sent, results, channel: channel.label, error: sent ? undefined : results[0]?.error });
  } catch (e) {
    if (e instanceof AuthError) return jsonResponse({ ok: false, error: e.message }, { status: e.status });
    console.log(JSON.stringify({ event: 'wa_notification_error', error: e instanceof Error ? e.message : String(e) }));
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
