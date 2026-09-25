// ============================================================================
// _shared/uazapi.ts — client da UAZAPI (Deno, Edge Functions)
// ----------------------------------------------------------------------------
// Integração DIRETA com a instância UAZAPI (segundo número de WhatsApp, sem
// janela de 24h): base URL = channels.uazapi_server_url, auth via header
// `token: <uazapi_token_encrypted decifrado>`. Multi-número: cada instância
// UAZAPI é um CANAL (whatsapp_hub.channels, provider='uazapi') da org.
// Spec: docs.uazapi.com (openapi-bundled.json) — POST /send/text {number,text},
// POST /send/media {number,type,file,text?}, POST /chat/details {number,preview}.
// ============================================================================

import { decryptValue } from './credentials.ts';

export class UazapiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface UazapiContext {
  serverUrl: string;
  token: string;
}

// Monta o contexto a partir de uma linha de whatsapp_hub.channels
// (provider='uazapi'). O token fica cifrado na linha (AES-GCM/CRYPTO_KEY).
export async function uazapiContextFromChannel(channel: {
  uazapi_server_url: string | null;
  uazapi_token_encrypted: string | null;
}): Promise<UazapiContext> {
  const serverUrl = channel.uazapi_server_url?.trim().replace(/\/+$/, '');
  const encrypted = channel.uazapi_token_encrypted?.trim();
  if (!serverUrl || !encrypted) {
    throw new UazapiError('Canal UAZAPI sem server URL / token configurados.', 500);
  }
  return { serverUrl, token: await decryptValue(encrypted) };
}

async function ufetch(
  ctx: UazapiContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${ctx.serverUrl}${path}`, {
    method: 'POST',
    headers: { token: ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* segue para o gate de status */
  }
  if (!res.ok) {
    const msg =
      (typeof json.error === 'string' && json.error) ||
      (typeof json.message === 'string' && json.message) ||
      `UAZAPI respondeu ${res.status}`;
    throw new UazapiError(msg, res.status);
  }
  return json;
}

function messageIdOf(root: Record<string, unknown>): string | null {
  const nested = (root.message && typeof root.message === 'object'
    ? (root.message as Record<string, unknown>)
    : root);
  for (const key of ['messageid', 'id', 'messageId']) {
    const v = nested[key] ?? root[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// Telefone E.164/dígitos — a UAZAPI aceita número internacional sem '+'.
// Grupo: o "telefone" do contato é o JID do grupo (…@g.us), que a UAZAPI
// aceita como destino em /send/* — não pode perder o sufixo.
function toNumber(phone: string): string {
  if (phone.includes('@')) return phone.trim();
  return phone.replace(/\D/g, '');
}

export async function uazapiSendText(
  ctx: UazapiContext,
  input: { phone: string; text: string },
): Promise<{ messageId: string | null }> {
  const root = await ufetch(ctx, '/send/text', {
    number: toNumber(input.phone),
    text: input.text,
  });
  return { messageId: messageIdOf(root) };
}

export async function uazapiSendMedia(
  ctx: UazapiContext,
  input: {
    phone: string;
    // Mapeado do attachmentType do inbox: image|video|audio(ptt)|file(document).
    type: 'image' | 'video' | 'document' | 'audio' | 'ptt';
    fileUrl: string;
    caption?: string;
  },
): Promise<{ messageId: string | null }> {
  const body: Record<string, unknown> = {
    number: toNumber(input.phone),
    type: input.type,
    file: input.fileUrl,
  };
  if (input.caption) body.text = input.caption;
  const root = await ufetch(ctx, '/send/media', body);
  return { messageId: messageIdOf(root) };
}

// POST /message/download {id} → resolve a fileURL pública (CDN, válida por
// 2 dias) de uma mensagem de mídia. O webhook de mensagens às vezes chega SEM
// fileURL populado no payload (mídia ainda não processada no momento do
// evento) — quando isso acontece, este endpoint é o fallback documentado
// pra buscar o arquivo pelo id da mensagem.
export async function uazapiDownloadMessageFile(
  ctx: UazapiContext,
  input: { messageId: string },
): Promise<{ fileUrl: string | null; mimetype: string | null }> {
  const root = await ufetch(ctx, '/message/download', { id: input.messageId });
  const fileUrl = typeof root.fileURL === 'string' && root.fileURL.trim() ? root.fileURL : null;
  const mimetype = typeof root.mimetype === 'string' ? root.mimetype : null;
  return { fileUrl, mimetype };
}

// POST /chat/details {number, preview} → detalhes completos do chat/contato,
// incluindo a URL da foto de perfil: `imagePreview` (menor, preview=true) ou
// `image` (resolução original, preview=false). Usada para exibir o avatar do
// lead no inbox (só disponível via UAZAPI — Zernio/Meta não expõem).
export async function uazapiGetChatDetails(
  ctx: UazapiContext,
  input: { phone: string; preview?: boolean },
): Promise<{ imageUrl: string | null; name: string | null }> {
  const root = await ufetch(ctx, '/chat/details', {
    number: toNumber(input.phone),
    preview: input.preview ?? true,
  });
  const pick = (keys: string[]): string | null => {
    for (const key of keys) {
      const v = root[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  };
  return {
    imageUrl: pick(['imagePreview', 'image']),
    name: pick(['wa_contactName', 'wa_name', 'name', 'lead_name']),
  };
}

// --- Histórico (importação das mensagens antigas do celular) ----------------
// A UAZAPI guarda as mensagens que o WhatsApp sincroniza no pareamento.
// POST /chat/find  → lista de chats (paginada; compact=true, máx 200/página).
// POST /message/find {chatid, limit, offset} → mensagens do chat, mais
//   recentes primeiro, com hasMore/nextOffset.
// GET  /instance/history-sync/status → andamento do sync inicial.

export interface UazapiChat {
  wa_chatid?: string;
  wa_isGroup_member?: boolean;
  phone?: string;
  wa_contactName?: string;
  wa_name?: string;
  name?: string;
  image?: string;
  imagePreview?: string;
  wa_isGroup?: boolean;
  wa_lastMsgTimestamp?: number;
}

export interface UazapiMessage {
  id?: string;
  messageid?: string;
  chatid?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  messageType?: string;
  messageTimestamp?: number;
  text?: string;
  fileURL?: string;
  senderName?: string;
  wasSentByApi?: boolean;
  sender?: string;
}

export async function uazapiFindChats(
  ctx: UazapiContext,
  input: { limit: number; offset: number; groups?: boolean },
): Promise<{ chats: UazapiChat[]; total: number | null }> {
  const root = await ufetch(ctx, '/chat/find', {
    compact: true,
    wa_isGroup: input.groups === true,
    sort: '-wa_lastMsgTimestamp',
    limit: input.limit,
    offset: input.offset,
  });
  const chats = Array.isArray(root.chats) ? (root.chats as UazapiChat[]) : [];
  const pag = root.pagination && typeof root.pagination === 'object'
    ? (root.pagination as Record<string, unknown>)
    : {};
  const total = typeof pag.totalRecords === 'number' ? pag.totalRecords : null;
  return { chats, total };
}

export async function uazapiFindMessages(
  ctx: UazapiContext,
  input: { chatid: string; limit: number; offset: number },
): Promise<{ messages: UazapiMessage[]; hasMore: boolean; nextOffset: number }> {
  const root = await ufetch(ctx, '/message/find', {
    chatid: input.chatid,
    limit: input.limit,
    offset: input.offset,
  });
  const messages = Array.isArray(root.messages) ? (root.messages as UazapiMessage[]) : [];
  const hasMore = root.hasMore === true;
  const nextOffset = typeof root.nextOffset === 'number'
    ? root.nextOffset
    : input.offset + messages.length;
  return { messages, hasMore, nextOffset };
}

export async function uazapiHistorySyncStatus(
  ctx: UazapiContext,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${ctx.serverUrl}/instance/history-sync/status`, {
    headers: { token: ctx.token },
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 300), status: res.status };
  }
}

// Webhook da instância: liga o recebimento de mensagens de GRUPO no webhook
// que já aponta para o nosso uazapi-webhook (antes cadastrado com o filtro
// isGroupYes, que descarta grupos). Mantém wasSentByApi (anti-loop).
export async function uazapiEnableGroupsOnWebhook(
  ctx: UazapiContext,
): Promise<{ updated: boolean; id: string | null }> {
  const res = await fetch(`${ctx.serverUrl}/webhook`, { headers: { token: ctx.token } });
  const list = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const ours = (Array.isArray(list) ? list : []).find(
    (w) => typeof w.url === 'string' && w.url.includes('/functions/v1/uazapi-webhook'),
  );
  if (!ours) return { updated: false, id: null };
  const exclude = Array.isArray(ours.excludeMessages)
    ? (ours.excludeMessages as string[]).filter((x) => x !== 'isGroupYes')
    : ['wasSentByApi'];
  if (!exclude.includes('wasSentByApi')) exclude.push('wasSentByApi');
  await ufetch(ctx, '/webhook', {
    action: 'update',
    id: ours.id,
    enabled: true,
    url: ours.url,
    events: Array.isArray(ours.events) ? ours.events : ['connection', 'messages'],
    excludeMessages: exclude,
    addUrlEvents: false,
    addUrlTypesMessages: false,
  });
  return { updated: true, id: typeof ours.id === 'string' ? ours.id : null };
}
