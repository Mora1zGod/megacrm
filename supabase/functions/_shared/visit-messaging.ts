// ============================================================================
// _shared/visit-messaging.ts — envio 1:1 das automações de visita
// ----------------------------------------------------------------------------
// visit-reminders e visit-thankyou mandam a mesma coisa (um texto livre 1:1
// pro contato da visita) e só mudam o corpo da mensagem — essa lógica vive
// aqui pra não duplicar.
//
// O ponto delicado é resolver o conversationId do Zernio. O id salvo em
// conversations.zernio_conversation_id envelhece: o Zernio devolve
// "Conversation not found" quando ele não vale mais. Nesse caso re-resolvemos
// pela lista (resolveInboxConversation), regravamos o id no banco e tentamos
// de novo — mesmo tratamento que o resto do projeto já dá via
// isConversationNotFoundError.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';
import { loadOrgZernioContext } from './channels.ts';
import {
  createInboxConversation,
  isConversationNotFoundError,
  resolveInboxConversation,
  sendInboxMessage,
} from './zernio.ts';

type Admin = ReturnType<typeof getAdminClient>;

export interface VisitContext {
  orgId: string;
  contactId: string;
  phone: string;
}

// Envia `text` pro contato e persiste na inbox como mensagem do sistema.
// Lança em caso de falha — o chamador loga por visita e segue as demais.
export async function sendVisitMessage(
  admin: Admin,
  ctx: VisitContext,
  text: string,
): Promise<void> {
  const { data: conv } = await admin
    .from('conversations')
    .select('id, zernio_conversation_id, provider, zernio_account_id')
    .eq('org_id', ctx.orgId)
    .eq('contact_id', ctx.contactId)
    .maybeSingle();
  const conversation = conv as
    | {
        id: string;
        zernio_conversation_id: string | null;
        provider: string | null;
        zernio_account_id: string | null;
      }
    | null;

  // O accountId TEM que ser o da conta dona da conversa. A org tem mais de uma
  // conta Zernio conectada (WhatsApp e Instagram são contas distintas), e o
  // default de loadOrgZernioContext é só "o canal ativo mais antigo" — mandar
  // numa conversa de WhatsApp usando o accountId do Instagram faz o Zernio
  // aceitar a request mas ignorar o corpo ("Message, attachment, or template
  // is required"). Por isso preferimos sempre o carimbado na conversa.
  const zctx = await loadOrgZernioContext(admin, ctx.orgId, conversation?.zernio_account_id ?? null);

  // Conversa marcada como UAZAPI não tem id válido no Zernio — força resolução.
  let zConvId =
    conversation?.provider === 'uazapi' ? null : conversation?.zernio_conversation_id ?? null;

  const persistZConvId = async (id: string) => {
    if (conversation?.id) {
      await admin.from('conversations').update({ zernio_conversation_id: id }).eq('id', conversation.id);
    }
  };

  // Resolve pela lista → cria como último recurso.
  const resolveFresh = async (): Promise<string> => {
    const found = await resolveInboxConversation({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      participantId: ctx.phone,
    });
    if (found?.id) {
      await persistZConvId(found.id);
      return found.id;
    }
    const created = await createInboxConversation({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      participantId: ctx.phone,
    });
    if (!created.conversationId) throw new Error('não resolveu a conversa no Zernio');
    await persistZConvId(created.conversationId);
    return created.conversationId;
  };

  if (!zConvId) zConvId = await resolveFresh();

  let sent: { messageId: string | null };
  try {
    sent = await sendInboxMessage({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      conversationId: zConvId,
      text,
    });
  } catch (err) {
    // Id obsoleto: re-resolve uma vez e repete. Outras falhas sobem.
    if (!isConversationNotFoundError(err)) throw err;
    zConvId = await resolveFresh();
    sent = await sendInboxMessage({
      apiKey: zctx.apiKey,
      accountId: zctx.accountId,
      conversationId: zConvId,
      text,
    });
  }

  let conversationId = conversation?.id ?? null;
  if (!conversationId) {
    const { data: newConv } = await admin
      .from('conversations')
      .insert({
        org_id: ctx.orgId,
        contact_id: ctx.contactId,
        status: 'ai_active',
        channel: 'whatsapp',
        provider: 'zernio',
        zernio_conversation_id: zConvId,
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    conversationId = (newConv as { id: string } | null)?.id ?? null;
  }

  if (conversationId) {
    await admin.from('messages').insert({
      org_id: ctx.orgId,
      conversation_id: conversationId,
      direction: 'outbound',
      sender_type: 'system',
      content_type: 'text',
      content: text,
      zernio_message_id: sent.messageId,
      meta_status: 'sent',
    });
    await admin
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
  }
}
