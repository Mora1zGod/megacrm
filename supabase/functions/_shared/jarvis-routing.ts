// ============================================================================
// _shared/jarvis-routing.ts
// ----------------------------------------------------------------------------
// Desvio do Jarvis no zernio-webhook.
//
// Regra única: se o telefone que mandou a mensagem estiver em
// whatsapp_hub.jarvis_users (is_active), o evento NÃO segue para o fluxo de
// lead (handleMessageReceived → insert em messages → trigger on_inbound_message
// → process-ai-message/AMAIA). Ele é entregue à Edge Function jarvis-agent.
//
// Consequências assumidas (desejadas):
//   · a mensagem do Gabriel não vira contact/conversation/message no CRM —
//     ele não é lead e não deve poluir o inbox nem as métricas;
//   · o AMAIA nunca vê esse evento, então o comportamento dele com cliente
//     fica idêntico ao de hoje.
//
// Com jarvis_users vazia isto é um no-op: uma query indexada e segue o jogo.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';

type Admin = ReturnType<typeof getAdminClient>;

export interface JarvisUserRow {
  id: string;
  org_id: string;
  phone: string;
  display_name: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

// Mesma ordem de fallback do handleMessageReceived (WhatsApp):
// sender.phoneNumber (E.164) → sender.id → conversation.participantId.
export function extractSenderPhone(data: Record<string, unknown>): string | null {
  const message = asObject(data.message ?? data);
  const conversation = asObject(data.conversation);
  const sender = asObject(message.sender);
  return (
    str(sender, ['phoneNumber']) ??
    normalizePhone(str(sender, ['id'])) ??
    normalizePhone(str(conversation, ['participantId']))
  );
}

export async function findJarvisUserByPhone(
  admin: Admin,
  orgId: string,
  phone: string,
): Promise<JarvisUserRow | null> {
  const { data, error } = await admin
    .from('jarvis_users')
    .select('id, org_id, phone, display_name')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    // Tabela ausente (migration não aplicada) ou falha transitória: não pode
    // derrubar o webhook — cai no fluxo normal de cliente.
    console.error(JSON.stringify({ event: 'jarvis_lookup_failed', message: error.message }));
    return null;
  }
  return (data as JarvisUserRow | null) ?? null;
}

// Dispara jarvis-agent sem bloquear a resposta ao Zernio (o Zernio re-tenta se
// o webhook demorar/falhar; o agente leva segundos por causa do LLM).
function invokeJarvisAgent(payload: Record<string, unknown>): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.error(JSON.stringify({ event: 'jarvis_invoke_missing_env' }));
    return;
  }
  const run = fetch(`${url}/functions/v1/jarvis-agent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(() => undefined)
    .catch((err) =>
      console.error(JSON.stringify({ event: 'jarvis_invoke_error', error: String(err) })),
    );
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime?.waitUntil?.(run);
}

// InboxWebhookMessage: { text, attachments:[{type,url}] } — mesma leitura do
// decodeInbound do webhook, reduzida ao que o Jarvis precisa (texto ou áudio).
function decodeForJarvis(message: Record<string, unknown>): {
  text: string | null;
  mediaUrl: string | null;
  contentType: string;
} {
  const text = str(message, ['text', 'body', 'caption']);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const first = asObject(attachments[0]);
  const mediaUrl = str(first, ['url', 'link', 'href']);
  const attType = (str(first, ['type']) ?? '').toLowerCase();
  if (!mediaUrl) return { text: text ?? '', mediaUrl: null, contentType: 'text' };
  if (attType === 'audio' || attType === 'voice') {
    return { text, mediaUrl, contentType: 'audio' };
  }
  return { text, mediaUrl, contentType: attType || 'document' };
}

/**
 * Devolve `true` quando o evento foi capturado pelo Jarvis e NÃO deve seguir
 * para o fluxo de cliente. `false` = segue o jogo normalmente.
 *
 * Só intercepta WhatsApp: DM de Instagram continua indo para o AMAIA.
 */
export async function maybeRouteToJarvis(
  admin: Admin,
  orgId: string,
  data: Record<string, unknown>,
  platform: 'whatsapp' | 'instagram',
): Promise<boolean> {
  if (platform !== 'whatsapp') return false;

  const phone = extractSenderPhone(data);
  if (!phone) return false;

  const jarvisUser = await findJarvisUserByPhone(admin, orgId, phone);
  if (!jarvisUser) return false;

  const message = asObject(data.message ?? data);
  const conversation = asObject(data.conversation);
  const account = asObject(data.account);
  const { text, mediaUrl, contentType } = decodeForJarvis(message);

  invokeJarvisAgent({
    org_id: orgId,
    jarvis_user_id: jarvisUser.id,
    phone,
    text,
    media_url: mediaUrl,
    content_type: contentType,
    zernio_conversation_id: str(conversation, ['id']) ?? str(message, ['conversationId']),
    zernio_account_id:
      str(account, ['id', '_id', 'accountId']) ?? str(message, ['accountId', 'account_id']),
    zernio_message_id: str(message, ['id', '_id']),
  });

  console.log(JSON.stringify({
    event: 'jarvis_routed',
    org_id: orgId,
    jarvis_user_id: jarvisUser.id,
    content_type: contentType,
  }));
  return true;
}
