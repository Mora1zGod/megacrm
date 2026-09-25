// ============================================================================
// uazapi-import-history — traz as conversas antigas do celular para o CRM
// ----------------------------------------------------------------------------
// O webhook da UAZAPI só entrega mensagens NOVAS. As antigas (que o WhatsApp
// sincroniza quando o número é pareado) ficam guardadas na própria UAZAPI e
// são lidas aqui por POST /chat/find + POST /message/find.
//
// Chamado pelo botão "Importar conversas antigas" em Configurações → Canais
// (admin da org). Roda em LOTES por tempo: cada chamada processa chats até
// ~TIME_BUDGET_MS e devolve next_offset; o front chama de novo até done=true.
//
// Segurança do histórico:
//   · Gravação via RPC whatsapp_hub.import_history_messages, que liga a flag
//     whatsapp_hub.importing: a IA NÃO responde, não gera notificação, não
//     transcreve áudio e não reabre conversa (migration 20260924170000).
//   · Idempotente: dedup pelo id da mensagem (mesma coluna do webhook), dá
//     para rodar de novo sem duplicar.
//   · Conversa que ainda não existia nasce CONCLUÍDA e com IA pausada — se o
//     cliente escrever de novo, o fluxo normal reabre.
//   · Conversa existente: só recebe as mensagens; status, responsável,
//     provedor e canal não mudam.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { AuthError, requireAdmin } from '../_shared/auth.ts';
import { getChannelById, type ChannelRow } from '../_shared/channels.ts';
import {
  type UazapiChat,
  type UazapiMessage,
  uazapiContextFromChannel,
  uazapiEnableGroupsOnWebhook,
  uazapiFindChats,
  uazapiFindMessages,
  uazapiHistorySyncStatus,
} from '../_shared/uazapi.ts';

type Admin = ReturnType<typeof getAdminClient>;

const TIME_BUDGET_MS = 90_000;
const CHAT_PAGE = 50;
const MSG_PAGE = 100;
const MAX_MSGS_PER_CHAT = 2000;
const INSERT_CHUNK = 200;

// Tipos que não são conteúdo de conversa.
const SKIP_TYPES = /reaction|protocol|call|revoke|poll ?update|pollupdate|keepinmemory|senderkeydistribution|pininchat/i;

function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function chatPhone(chat: UazapiChat): string | null {
  const jid = chat.wa_chatid ?? '';
  // @lid é um identificador interno do WhatsApp, não o telefone.
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return phoneFromJid(jid);
  return phoneFromJid(chat.phone ?? null);
}

function isPrivateChat(chat: UazapiChat): boolean {
  const jid = chat.wa_chatid ?? '';
  if (!jid || chat.wa_isGroup) return false;
  return !/@g\.us$|@broadcast$|@newsletter$/.test(jid);
}

function chatName(chat: UazapiChat): string | null {
  for (const v of [chat.wa_contactName, chat.wa_name, chat.name]) {
    if (typeof v === 'string' && v.trim() && !/^\+?\d[\d\s-]+$/.test(v.trim())) return v.trim();
  }
  return null;
}

function tsMs(v: number | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v; // aceita segundos ou milissegundos
}

interface Row {
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: 'contact' | 'owner';
  content_type: 'text' | 'image' | 'audio' | 'video' | 'document';
  content: string | null;
  media_url: string | null;
  external_id: string;
  created_at: string;
  sender_name: string | null;
}

function toRow(m: UazapiMessage, conversationId: string, isGroup = false): Row | null {
  const externalId = (m.messageid ?? m.id ?? '').trim();
  const ms = tsMs(m.messageTimestamp);
  if (!externalId || !ms || (m.isGroup && !isGroup)) return null;
  const type = (m.messageType ?? '').toLowerCase();
  if (SKIP_TYPES.test(type)) return null;

  const text = typeof m.text === 'string' && m.text.trim() ? m.text : null;
  const url = typeof m.fileURL === 'string' && /^https?:\/\//.test(m.fileURL) ? m.fileURL : null;
  let contentType: Row['content_type'] = 'text';
  if (/image|sticker/.test(type)) contentType = 'image';
  else if (/audio|ptt/.test(type)) contentType = 'audio';
  else if (/video/.test(type)) contentType = 'video';
  else if (/document/.test(type)) contentType = 'document';

  if (contentType === 'text' && !text) return null; // tipo desconhecido e vazio
  return {
    conversation_id: conversationId,
    direction: m.fromMe ? 'outbound' : 'inbound',
    sender_type: m.fromMe ? 'owner' : 'contact',
    content_type: contentType,
    content: contentType === 'audio' ? null : text,
    media_url: url,
    external_id: externalId,
    created_at: new Date(ms).toISOString(),
    sender_name: isGroup && !m.fromMe
      ? (m.senderName?.trim() || phoneFromJid(m.sender ?? null))
      : null,
  };
}

async function findOrCreateContact(
  admin: Admin,
  orgId: string,
  phone: string,
  name: string | null,
  picture: string | null,
): Promise<string | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id, name, profile_pic_url')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) {
    const e = existing as { id: string; name: string | null; profile_pic_url: string | null };
    const patch: Record<string, unknown> = {};
    if (!e.name?.trim() && name) patch.name = name;
    if (!e.profile_pic_url && picture) {
      patch.profile_pic_url = picture;
      patch.profile_pic_updated_at = new Date().toISOString();
    }
    if (Object.keys(patch).length) await admin.from('contacts').update(patch).eq('id', e.id);
    return e.id;
  }
  const { data: created, error } = await admin
    .from('contacts')
    .insert({
      org_id: orgId,
      phone,
      name,
      source: 'whatsapp',
      profile_pic_url: picture,
      profile_pic_updated_at: picture ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) return null;
  return (created as { id: string }).id;
}

async function findOrCreateConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  channel: ChannelRow,
  lastAt: string,
): Promise<{ id: string; created: boolean } | null> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id, last_message_at')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) {
    const e = existing as { id: string; last_message_at: string | null };
    if (!e.last_message_at || Date.parse(e.last_message_at) < Date.parse(lastAt)) {
      await admin.from('conversations').update({ last_message_at: lastAt }).eq('id', e.id);
    }
    return { id: e.id, created: false };
  }
  const nowIso = new Date().toISOString();
  const insert: Record<string, unknown> = {
    org_id: orgId,
    contact_id: contactId,
    status: 'closed',
    closed_at: nowIso,
    ai_paused: true,
    channel: 'whatsapp',
    provider: 'uazapi',
    channel_id: channel.id,
    last_message_at: lastAt,
  };
  if (channel.queue_id) insert.queue_id = channel.queue_id;
  const { data: created, error } = await admin
    .from('conversations')
    .insert(insert)
    .select('id')
    .single();
  if (error) return null;
  return { id: (created as { id: string }).id, created: true };
}

// Grupo: contato com phone = JID do grupo; conversa sempre com IA pausada e
// em atendimento humano (aparece na aba Grupos do Inbox).
async function findOrCreateGroup(
  admin: Admin,
  orgId: string,
  channel: ChannelRow,
  jid: string,
  name: string | null,
  lastAt: string,
): Promise<{ id: string; created: boolean } | null> {
  const { data: existing } = await admin
    .from('contacts')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('phone', jid)
    .maybeSingle();
  let contactId: string;
  if (existing) {
    const e = existing as { id: string; name: string | null };
    contactId = e.id;
    if (name && name !== e.name) await admin.from('contacts').update({ name }).eq('id', e.id);
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({ org_id: orgId, phone: jid, name: name ?? 'Grupo', source: 'whatsapp_group' })
      .select('id')
      .single();
    if (error) return null;
    contactId = (created as { id: string }).id;
  }
  const { data: conv } = await admin
    .from('conversations')
    .select('id, last_message_at')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (conv) {
    const c = conv as { id: string; last_message_at: string | null };
    if (!c.last_message_at || Date.parse(c.last_message_at) < Date.parse(lastAt)) {
      await admin.from('conversations').update({ last_message_at: lastAt }).eq('id', c.id);
    }
    return { id: c.id, created: false };
  }
  const { data: created, error } = await admin
    .from('conversations')
    .insert({
      org_id: orgId,
      contact_id: contactId,
      status: 'human_active',
      ai_paused: true,
      channel: 'whatsapp',
      provider: 'uazapi',
      channel_id: channel.id,
      last_message_at: lastAt,
    })
    .select('id')
    .single();
  if (error) return null;
  return { id: (created as { id: string }).id, created: true };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, { status: 405 });

  let caller;
  try {
    caller = await requireAdmin(req);
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 401;
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Não autorizado' }, { status });
  }

  let body: { channel_id?: string; action?: string; days?: number; chat_offset?: number; groups?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
  }

  const admin = getAdminClient();
  const channel = body.channel_id ? await getChannelById(admin, body.channel_id) : null;
  if (!channel || channel.org_id !== caller.orgId || channel.provider !== 'uazapi') {
    return jsonResponse({ ok: false, error: 'Canal UAZAPI não encontrado nesta organização.' }, { status: 404 });
  }
  const orgId = caller.orgId;

  let ctx;
  try {
    ctx = await uazapiContextFromChannel(channel);
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Canal sem credenciais.' }, { status: 400 });
  }

  if (body.action === 'enable_groups') {
    try {
      const r = await uazapiEnableGroupsOnWebhook(ctx);
      if (!r.updated) {
        return jsonResponse({ ok: false, error: 'Webhook do CRM não encontrado nesta instância. Reconecte o número em Configurações › Canais.' }, { status: 404 });
      }
      return jsonResponse({ ok: true, webhook_id: r.id });
    } catch (err) {
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  }

  const groups = body.groups === true;

  if (body.action === 'status') {
    try {
      const [sync, first] = await Promise.all([
        uazapiHistorySyncStatus(ctx),
        uazapiFindChats(ctx, { limit: 1, offset: 0, groups }),
      ]);
      return jsonResponse({ ok: true, sync, total_chats: first.total });
    } catch (err) {
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  }

  const days = Math.min(Math.max(Number(body.days) || 90, 1), 3650);
  const cutoff = Date.now() - days * 86_400_000;
  const started = Date.now();
  let offset = Math.max(0, Number(body.chat_offset) || 0);
  let done = false;
  let total: number | null = null;
  let chatsProcessed = 0;
  let chatsWithMessages = 0;
  let conversationsCreated = 0;
  let imported = 0;
  const errors: string[] = [];

  try {
    outer: while (Date.now() - started < TIME_BUDGET_MS) {
      const page = await uazapiFindChats(ctx, { limit: CHAT_PAGE, offset, groups });
      if (total === null) total = page.total;
      if (page.chats.length === 0) { done = true; break; }

      for (const chat of page.chats) {
        if (Date.now() - started >= TIME_BUDGET_MS) break outer;
        offset += 1;
        chatsProcessed += 1;

        const last = tsMs(chat.wa_lastMsgTimestamp);
        // Chats vêm do mais recente para o mais antigo: passou do corte, acabou.
        if (last && last < cutoff) { done = true; break outer; }
        const jid = chat.wa_chatid ?? '';
        const isGroupChat = groups && jid.endsWith('@g.us');
        if (!isGroupChat && !isPrivateChat(chat)) continue;
        const phone = isGroupChat ? jid : chatPhone(chat);
        if (!phone) continue;

        // Mensagens do chat, da mais recente para trás, até o corte.
        const msgs: UazapiMessage[] = [];
        let mOffset = 0;
        while (msgs.length < MAX_MSGS_PER_CHAT) {
          const res = await uazapiFindMessages(ctx, { chatid: chat.wa_chatid!, limit: MSG_PAGE, offset: mOffset });
          let reachedCutoff = false;
          for (const m of res.messages) {
            const ms = tsMs(m.messageTimestamp);
            if (ms && ms < cutoff) { reachedCutoff = true; continue; }
            msgs.push(m);
          }
          if (reachedCutoff || !res.hasMore || res.messages.length === 0) break;
          mOffset = res.nextOffset > mOffset ? res.nextOffset : mOffset + res.messages.length;
        }
        if (msgs.length === 0) continue;

        const newest = msgs.reduce((a, m) => Math.max(a, tsMs(m.messageTimestamp) ?? 0), 0);
        const newestIso = new Date(newest).toISOString();
        let conv: { id: string; created: boolean } | null;
        if (isGroupChat) {
          const groupName = [chat.name, chat.wa_name, chat.wa_contactName]
            .find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
          conv = await findOrCreateGroup(admin, orgId, channel, phone, groupName, newestIso);
        } else {
          const contactId = await findOrCreateContact(
            admin, orgId, phone, chatName(chat), chat.imagePreview || chat.image || null,
          );
          if (!contactId) { errors.push(`contato ${phone}`); continue; }
          conv = await findOrCreateConversation(admin, orgId, contactId, channel, newestIso);
        }
        if (!conv) { errors.push(`conversa ${phone}`); continue; }
        if (conv.created) conversationsCreated += 1;
        const convId = conv.id;

        const rows = msgs.map((m) => toRow(m, convId, isGroupChat)).filter((r): r is Row => r !== null);
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const { data, error } = await admin.rpc('import_history_messages', {
            p_org_id: orgId,
            p_rows: rows.slice(i, i + INSERT_CHUNK),
          });
          if (error) { errors.push(`gravar ${phone}: ${error.message}`); break; }
          imported += Number(data) || 0;
        }
        chatsWithMessages += 1;
      }
      if (page.chats.length < CHAT_PAGE) { done = true; break; }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  console.log(JSON.stringify({
    event: 'uazapi_import_history', org_id: orgId, channel_id: channel.id, days,
    chats_processed: chatsProcessed, imported, conversations_created: conversationsCreated,
    next_offset: offset, done, errors: errors.slice(0, 5),
  }));

  return jsonResponse({
    ok: errors.length === 0 || imported > 0 || chatsProcessed > 0,
    done,
    next_offset: offset,
    total_chats: total,
    chats_processed: chatsProcessed,
    chats_with_messages: chatsWithMessages,
    conversations_created: conversationsCreated,
    imported,
    errors: errors.slice(0, 10),
  });
});
