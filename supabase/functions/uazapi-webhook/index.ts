// ============================================================================
// uazapi-webhook — receptor dos eventos da instância UAZAPI (integração direta)
// ----------------------------------------------------------------------------
// Cadastrado pela api/uazapi-connect com URL
//   {SUPABASE_URL}/functions/v1/uazapi-webhook?secret=<uazapi_webhook_secret>
// (a UAZAPI não assina HMAC — o gate é o secret na URL, comparação
// constant-time). Config do webhook: events connection+messages, excluindo
// wasSentByApi (anti-loop) e isGroupYes (sem grupos) — os filtros também são
// re-checados aqui por defesa.
//
// Payload: { event, instance, data } com data.message =
//   { id, messageid, chatid, sender, senderName, isGroup, fromMe, messageType,
//     text, fileURL, wasSentByApi, ... }
//
// message → find/create contact (telefone do chatid) + conversation
// (channel 'whatsapp', provider 'uazapi', SEM janela de 24h no inbox) + insert
// em messages. O INSERT dispara a IA via trigger do banco (mesmo caminho do
// zernio-webhook). connection → log.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import {
  getChannelByWebhookSecret,
  getSoleUazapiChannel,
  type ChannelRow,
} from '../_shared/channels.ts';
import { uazapiContextFromChannel, uazapiGetChatDetails, uazapiDownloadMessageFile } from '../_shared/uazapi.ts';
import { maybeAddLeadToFunnel } from '../_shared/funnel.ts';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

// '5531999999999@s.whatsapp.net' | '5531...@c.us' → '+5531999999999'
function phoneFromJid(jid: string | null): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `+${digits}`;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// messageType da UAZAPI (estilo whatsmeow: Conversation, ImageMessage,
// AudioMessage, PTT, VideoMessage, DocumentMessage, StickerMessage...).
//
// O payload do webhook às vezes chega com messageType de mídia mas SEM
// fileURL (mídia ainda não processada no instante do evento) — `needsDownload`
// sinaliza esse caso pro handleMessage tentar o fallback via
// POST /message/download (uazapiDownloadMessageFile), documentado pela UAZAPI
// como a forma confiável de resolver o arquivo pelo id da mensagem.
function decodeContent(message: Record<string, unknown>): {
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document';
  content: string | null;
  mediaUrl: string | null;
  needsDownload: boolean;
} {
  const text = str(message, ['text', 'caption', 'body']);
  const mediaUrl = str(message, ['fileURL', 'fileUrl', 'file_url', 'mediaUrl']);
  const type = (str(message, ['messageType', 'type']) ?? '').toLowerCase();
  const isMediaType = /image|sticker|audio|ptt|video|document/.test(type);

  if (!mediaUrl) {
    if (isMediaType) {
      return { contentType: 'document', content: text, mediaUrl: null, needsDownload: true };
    }
    return { contentType: 'text', content: text ?? '', mediaUrl: null, needsDownload: false };
  }
  if (type.includes('image') || type.includes('sticker')) {
    return { contentType: 'image', content: text, mediaUrl, needsDownload: false };
  }
  if (type.includes('audio') || type.includes('ptt')) {
    return { contentType: 'audio', content: null, mediaUrl, needsDownload: false };
  }
  if (type.includes('video')) return { contentType: 'video', content: text, mediaUrl, needsDownload: false };
  return { contentType: 'document', content: text, mediaUrl, needsDownload: false };
}

interface ContactRow {
  id: string;
  profile_pic_updated_at: string | null;
}

async function findOrCreateContact(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  phone: string,
  name: string | null,
): Promise<ContactRow | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id, name, profile_pic_updated_at')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) {
    const row = existing as ContactRow & { name: string | null };
    // Contato já existe mas ainda sem nome (ex.: 1ª mensagem chegou sem
    // senderName/pushName no payload) — se uma mensagem posterior trouxer o
    // nome, backfill aqui. Nunca sobrescreve um nome já preenchido (pode ter
    // sido editado manualmente no CRM).
    if (name && !row.name?.trim()) {
      await admin.from('contacts').update({ name }).eq('id', row.id);
    }
    return row;
  }
  const { data: created, error } = await admin
    .from('contacts')
    .insert({ org_id: orgId, phone, name, source: 'whatsapp' })
    .select('id, profile_pic_updated_at')
    .single();
  if (error) return null;
  return created as ContactRow;
}

async function findOrCreateConversation(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  contactId: string,
  channel: ChannelRow,
  leadTitle: string | null,
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await admin
    .from('conversations')
    .select('id, provider, channel_id')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; provider: string | null; channel_id: string | null };
    // Último inbound decide o provedor da conversa (e o número de resposta).
    // Não sobrescreve a atribuição de operador de conversas já existentes.
    const patch: Record<string, unknown> = { last_message_at: nowIso };
    if (row.provider !== 'uazapi') patch.provider = 'uazapi';
    if (row.channel_id !== channel.id) patch.channel_id = channel.id;
    await admin.from('conversations').update(patch).eq('id', row.id);
    return row.id;
  }
  const insert: Record<string, unknown> = {
    org_id: orgId,
    contact_id: contactId,
    status: 'ai_active',
    channel: 'whatsapp',
    provider: 'uazapi',
    channel_id: channel.id,
    last_message_at: nowIso,
  };
  // Atribuição automática: conversa nova herda o operador do canal (se houver).
  if (channel.assigned_member) {
    insert.assigned_to = channel.assigned_member;
    insert.assigned_at = nowIso;
  }
  // Fila/setor herdada do canal (Configurações → Equipe → Filas).
  if (channel.queue_id) insert.queue_id = channel.queue_id;
  const { data: created, error } = await admin
    .from('conversations')
    .insert(insert)
    .select('id')
    .single();
  if (error) return null;
  const conversationId = (created as { id: string }).id;
  // Lead novo entrando em contato: adiciona ao funil configurado do canal.
  await maybeAddLeadToFunnel(admin, orgId, contactId, channel, leadTitle, 'whatsapp');
  // IA desligada neste número: a conversa nasce direto no humano. O UPDATE
  // (não o INSERT) faz o flip ai_paused false→true, que dispara os triggers
  // de handoff — notifica o operador vinculado ou cai no rodízio/fanout.
  if (channel.ai_enabled === false) {
    await admin
      .from('conversations')
      .update({ status: 'human_active', ai_paused: true })
      .eq('id', conversationId);
  }
  return conversationId;
}

// Foto de perfil do lead: só a UAZAPI expõe. Best-effort, fora do caminho
// crítico do webhook — refresh quando nunca buscamos ou faz mais de 7 dias.
const PROFILE_PIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function shouldRefreshProfilePic(updatedAt: string | null): boolean {
  if (!updatedAt) return true;
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > PROFILE_PIC_TTL_MS;
}

function refreshProfilePic(
  admin: ReturnType<typeof getAdminClient>,
  channel: ChannelRow,
  contactId: string,
  phone: string,
): void {
  const refresh = (async () => {
    const ctx = await uazapiContextFromChannel(channel);
    const details = await uazapiGetChatDetails(ctx, { phone, preview: true });
    if (details.imageUrl) {
      await admin.from('contacts').update({
        profile_pic_url: details.imageUrl,
        profile_pic_updated_at: new Date().toISOString(),
      }).eq('id', contactId);
    } else {
      // Sem foto (privacidade / sem imagem): carimba o timestamp para respeitar
      // o TTL e não re-tentar a cada mensagem.
      await admin.from('contacts').update({
        profile_pic_updated_at: new Date().toISOString(),
      }).eq('id', contactId);
    }
  })().catch((err) =>
    console.log(JSON.stringify({ event: 'uazapi_profile_pic_error', error: String(err) })));
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime?.waitUntil?.(refresh);
}

async function handleMessage(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
  channel: ChannelRow,
  data: Record<string, unknown>,
  errors: string[],
): Promise<void> {
  const message = asObject(data.message ?? data);

  const isGroup = message.isGroup === true;
  const sentByApi = message.wasSentByApi === true;
  const fromMe = message.fromMe === true;
  // Grupos: fora de escopo.
  //
  // `wasSentByApi` já foi motivo de descarte aqui, como anti-loop: o
  // send-operator-* grava a própria mensagem na inbox no envio, e o eco do
  // webhook duplicaria. Só que o descarte era cego — jogava fora TODA mensagem
  // enviada por API, inclusive a de outro sistema usando a mesma instância
  // uazapi. O Bella Center dispara confirmação, lembrete e link de contrato por
  // ela; nenhuma dessas o CRM grava, então o webhook era a única chance, e a
  // recepção via a resposta da paciente sem a pergunta que a provocou.
  //
  // O eco continua coberto por duas guardas abaixo: o dedup por
  // zernio_message_id e, para o caso em que o id ainda não foi carimbado, a
  // guarda de corrida por conteúdo recente.
  //
  // fromMe SEM wasSentByApi = o dono digitou direto no WhatsApp do celular →
  // registramos como mensagem OUTBOUND do próprio dono (sender_type 'owner').
  if (isGroup) return;

  // chatid é sempre o OUTRO lado do 1:1 (o lead), tanto no inbound quanto no
  // fromMe. No fromMe NÃO caímos em `sender` (que seria o próprio dono).
  // UAZAPI varia a chave do JID por versão: chatid, chatId, remoteJid,
  // remote_jid, chatID. Para fromMe também tentamos 'to'/'recipient'.
  const phone =
    phoneFromJid(str(message, ['chatid', 'chatId', 'chatID', 'remoteJid', 'remote_jid'])) ??
    (fromMe
      ? phoneFromJid(str(message, ['to', 'recipient']))
      : phoneFromJid(str(message, ['sender', 'from']))) ??
    phoneFromJid(str(asObject(data.chat), ['id', 'wa_chatid', 'remoteJid'])) ??
    phoneFromJid(str(asObject(asObject(message.key), ['remoteJid'])));
  if (!phone) {
    errors.push('mensagem uazapi sem telefone');
    return;
  }
  // No fromMe o senderName é o DONO — não usar como nome do lead.
  const name = fromMe
    ? null
    : (str(message, ['senderName', 'pushName']) ?? str(asObject(data.chat), ['name']));
  const uazapiMessageId = str(message, ['messageid', 'id']);

  const contact = await findOrCreateContact(admin, orgId, phone, name);
  if (!contact) {
    errors.push(`contato falhou: ${phone}`);
    return;
  }

  // Foto de perfil do lead (best-effort, não bloqueia a resposta do webhook).
  if (shouldRefreshProfilePic(contact.profile_pic_updated_at)) {
    refreshProfilePic(admin, channel, contact.id, phone);
  }

  const conversationId = await findOrCreateConversation(
    admin, orgId, contact.id, channel, name ?? phone,
  );
  if (!conversationId) {
    errors.push('conversa falhou');
    return;
  }

  // Dedup at-least-once pelo id da mensagem (compartilha a coluna
  // zernio_message_id — é o id externo genérico da mensagem), por org.
  if (uazapiMessageId) {
    const { data: dup } = await admin
      .from('messages')
      .select('id')
      .eq('org_id', orgId)
      .eq('zernio_message_id', uazapiMessageId)
      .maybeSingle();
    if (dup) return;
  }

  const decoded = decodeContent(message);
  const content = decoded.content;
  let contentType = decoded.contentType;
  let mediaUrl = decoded.mediaUrl;
  if (decoded.needsDownload && uazapiMessageId) {
    try {
      const ctx = await uazapiContextFromChannel(channel);
      const dl = await uazapiDownloadMessageFile(ctx, { messageId: uazapiMessageId });
      if (dl.fileUrl) {
        mediaUrl = dl.fileUrl;
        const mime = (dl.mimetype ?? '').toLowerCase();
        if (mime.startsWith('image/')) contentType = 'image';
        else if (mime.startsWith('audio/')) contentType = 'audio';
        else if (mime.startsWith('video/')) contentType = 'video';
        else contentType = 'document';
      } else {
        errors.push(`uazapi download sem fileURL (msg ${uazapiMessageId})`);
      }
    } catch (e) {
      errors.push(`uazapi download falhou (msg ${uazapiMessageId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Guarda contra corrida, para o envio que parte do PRÓPRIO CRM (operador, IA
  // ou automação de visita): a linha já foi gravada no envio, mas o
  // zernio_message_id só é carimbado num UPDATE logo depois. Quando o webhook
  // chega nessa fresta, o dedup por id acima não acha nada e a mensagem
  // apareceria duas vezes na thread. Se existe uma outbound de mesmo conteúdo
  // na mesma conversa nos últimos 2 minutos, é a mesma mensagem: carimbamos o
  // id nela em vez de inserir outra.
  //
  // Mesma guarda que o zernio-webhook já usa. O preço é o dono mandar o mesmo
  // texto duas vezes em menos de 2 minutos e a segunda não aparecer — mais
  // barato que mostrar mensagem duplicada para a recepção.
  if (fromMe) {
    const recente = new Date(Date.now() - 120_000).toISOString();
    const { data: dupe } = await admin
      .from('messages')
      .select('id, zernio_message_id')
      .eq('org_id', orgId)
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .eq('content', content)
      .gte('created_at', recente)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const existente = dupe as { id: string; zernio_message_id: string | null } | null;
    if (existente) {
      if (!existente.zernio_message_id) {
        await admin
          .from('messages')
          .update({ zernio_message_id: uazapiMessageId, meta_status: 'sent' })
          .eq('id', existente.id);
      }
      return;
    }
  }

  const { error: insErr } = await admin.from('messages').insert({
    org_id: orgId,
    conversation_id: conversationId,
    direction: fromMe ? 'outbound' : 'inbound',
    // Disparo de sistema (outro sistema pela mesma instância) não é o dono
    // falando: 'system', igual ao que a automação de visita já grava.
    sender_type: fromMe ? (sentByApi ? 'system' : 'owner') : 'contact',
    content_type: contentType,
    content,
    media_url: mediaUrl,
    zernio_message_id: uazapiMessageId,
    is_private_note: false,
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === '23505') return; // corrida de dedup
    errors.push(`message insert: ${insErr.message}`);
    return;
  }

  // Mensagem enviada pelo DONO direto do celular: ele assumiu a conversa, então
  // pausamos a IA (o flip ai_paused false→true dispara os triggers de handoff —
  // round-robin/notify já existentes). Não incrementa não-lidas (é outbound)
  // nem cancela follow-ups (não é resposta do lead).
  if (fromMe) {
    // Só o dono digitando no celular significa que ele assumiu a conversa.
    // Disparo automático que saiu por API não pode pausar a IA — senão cada
    // confirmação do Bella Center desligaria o agente naquela conversa, em
    // silêncio.
    if (!sentByApi) {
      await admin
        .from('conversations')
        .update({ status: 'human_active', ai_paused: true })
        .eq('id', conversationId);
    }
    return;
  }

  await admin.rpc('increment_unread_count', { p_conversation_id: conversationId });

  // Resposta do contato cancela follow-ups pendentes (mesma regra do Zernio).
  const { data: ccHit } = await admin
    .from('campaign_contacts')
    .select('id, campaign_id')
    .eq('org_id', orgId)
    .eq('contact_id', contact.id)
    .is('replied_at', null)
    .in('status', ['sent', 'delivered', 'read'])
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ccHit) {
    await admin
      .from('campaign_contacts')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', (ccHit as { id: string }).id);
    await admin.rpc('bump_campaign_counter', {
      p_campaign_id: (ccHit as { campaign_id: string }).campaign_id,
      p_column: 'replied',
      p_delta: 1,
    });
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, { status: 405 });
  }

  const admin = getAdminClient();
  const secret = new URL(req.url).searchParams.get('secret') ?? '';

  // Roteamento por canal: o secret na URL É a autenticação (a UAZAPI não assina
  // HMAC). Cada canal tem seu próprio webhook_secret → resolve org + canal.
  let channel: ChannelRow | null = secret
    ? await getChannelByWebhookSecret(admin, secret)
    : null;

  if (!channel) {
    // Fallback legado: instância única migrada de antes do multi-canal. Só
    // aceita se houver exatamente 1 org ativa com 1 canal uazapi, e o secret
    // da URL casar (timing-safe) com o webhook_secret desse canal.
    const { data: actives } = await admin
      .from('organizations')
      .select('id')
      .eq('status', 'active')
      .limit(2);
    const activeRows = (actives ?? []) as Array<{ id: string }>;
    if (activeRows.length === 1) {
      const sole = await getSoleUazapiChannel(admin, activeRows[0].id);
      if (sole && secret && timingSafeEqualStr(secret, sole.webhook_secret)) {
        channel = sole;
      }
    }
  }

  if (!channel) {
    console.log(JSON.stringify({ event: 'uazapi_webhook_no_channel' }));
    return jsonResponse({ ok: true, skipped: 'no_channel' });
  }
  const orgId = channel.org_id;

  // Org arquivada → aceitar (200) e descartar.
  const { data: org } = await admin
    .from('organizations')
    .select('status')
    .eq('id', orgId)
    .maybeSingle();
  if ((org as { status: string } | null)?.status === 'archived') {
    console.log(JSON.stringify({ event: 'uazapi_webhook_org_archived', org_id: orgId }));
    return jsonResponse({ ok: true, skipped: 'org_archived' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const root = asObject(payload);
  const eventType = (str(root, ['event', 'EventType', 'type']) ?? '').toLowerCase();
  const data = asObject(root.data ?? root);

  console.log(JSON.stringify({ event: 'uazapi_webhook_received', type: eventType, org_id: orgId }));

  const errors: string[] = [];
  try {
    // UAZAPI varia o nome do evento por versão:
    //   'messages.upsert', 'message.received', 'NewMessage', 'MESSAGE', 'new_message'...
    // Verificamos tanto prefixo 'message' quanto variantes comuns.
    const isMessageEvent =
      eventType.startsWith('message') ||
      eventType === 'newmessage' ||
      eventType === 'new_message' ||
      eventType.includes('message');
    const isConnectionEvent =
      eventType.startsWith('connection') || eventType.includes('connection');

    if (isMessageEvent) {
      await handleMessage(admin, orgId, channel, data, errors);
    } else if (isConnectionEvent) {
      console.log(JSON.stringify({ event: 'uazapi_connection', data: root.data ?? null }));
    }
    // Outros eventos: registrados no log acima, sem ação.
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({ event: 'uazapi_webhook_errors', errors }));
  }
  return jsonResponse({ ok: true, errors: errors.length > 0 ? errors : undefined });
});
