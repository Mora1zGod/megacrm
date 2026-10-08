// ============================================================================
// edit-operator-message
// ----------------------------------------------------------------------------
// Corrige uma mensagem de TEXTO enviada pela equipe — também no WhatsApp do
// cliente (aparece "Editada" para ele).
//
//   { message_id, content }
//
// Regras:
//   * só mensagem de saída de operador (texto ou nota interna);
//   * só quem enviou (ou administrador);
//   * nota interna: edita só no CRM, sem prazo;
//   * WhatsApp pelo número UAZAPI: POST /message/edit, até 15 min após o envio
//     (janela do WhatsApp);
//   * número oficial (Zernio/Meta) e Instagram: a API não permite editar.
// ============================================================================

import { requirePermission, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getSendContextForConversation } from '../_shared/channels.ts';
import { uazapiEditText, UazapiError } from '../_shared/uazapi.ts';

const EDIT_WINDOW_MS = 15 * 60 * 1000;

type MsgRow = {
  id: string;
  org_id: string;
  conversation_id: string;
  direction: string;
  sender_type: string;
  sender_id: string | null;
  content_type: string;
  content: string | null;
  is_private_note: boolean;
  zernio_message_id: string | null;
  created_at: string;
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requirePermission(req, 'inbox.reply');
    let body: { message_id?: string; content?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }
    const messageId = (body.message_id ?? '').trim();
    const content = (body.content ?? '').trim();
    if (!messageId) return jsonResponse({ ok: false, error: 'message_id ausente.' }, { status: 400 });
    if (!content) return jsonResponse({ ok: false, error: 'A mensagem não pode ficar vazia.' }, { status: 400 });
    if (content.length > 4096) return jsonResponse({ ok: false, error: 'Mensagem longa demais.' }, { status: 400 });

    const admin = getAdminClient();
    const { data: row } = await admin
      .from('messages')
      .select('id, org_id, conversation_id, direction, sender_type, sender_id, content_type, content, is_private_note, zernio_message_id, created_at')
      .eq('id', messageId)
      .maybeSingle();
    const msg = row as MsgRow | null;
    if (!msg || msg.org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Mensagem não encontrada.' }, { status: 404 });
    }
    if (msg.direction !== 'outbound' || msg.sender_type !== 'operator' || !['text', 'note'].includes(msg.content_type)) {
      return jsonResponse({ ok: false, error: 'Só dá para editar mensagens de texto enviadas pela equipe.' }, { status: 400 });
    }
    const isAdmin = caller.isSuperAdmin || caller.role === 'admin';
    if (msg.sender_id !== caller.userId && !isAdmin) {
      return jsonResponse({ ok: false, error: 'Só quem enviou pode editar esta mensagem.' }, { status: 403 });
    }
    if (content === (msg.content ?? '').trim()) return jsonResponse({ ok: true, unchanged: true });

    if (!msg.is_private_note) {
      if (Date.now() - new Date(msg.created_at).getTime() > EDIT_WINDOW_MS) {
        return jsonResponse({ ok: false, error: 'O WhatsApp só permite editar até 15 minutos depois do envio.' }, { status: 400 });
      }
      const { data: convData } = await admin
        .from('conversations')
        .select('id, org_id, channel, channel_id, provider, zernio_account_id')
        .eq('id', msg.conversation_id)
        .maybeSingle();
      const conv = convData as { org_id: string; channel: string | null; channel_id: string | null; provider: string | null; zernio_account_id: string | null } | null;
      if (!conv || conv.org_id !== caller.orgId) return jsonResponse({ ok: false, error: 'Conversa não encontrada.' }, { status: 404 });
      if (conv.channel === 'instagram') {
        return jsonResponse({ ok: false, error: 'O Instagram não permite editar mensagens enviadas.' }, { status: 400 });
      }
      const ctx = await getSendContextForConversation(admin, {
        org_id: conv.org_id,
        channel_id: conv.channel_id,
        provider: conv.provider,
        zernio_account_id: conv.zernio_account_id,
      });
      if (ctx.provider !== 'uazapi') {
        return jsonResponse({
          ok: false,
          error: 'Neste número (WhatsApp oficial) a API não permite editar mensagens. Envie uma nova mensagem corrigindo.',
        }, { status: 400 });
      }
      if (!msg.zernio_message_id) {
        return jsonResponse({ ok: false, error: 'Esta mensagem não tem o ID do WhatsApp — não dá para editar.' }, { status: 400 });
      }
      await uazapiEditText(ctx.uazapi, { id: msg.zernio_message_id, text: content });
    }

    const { error: upErr } = await admin
      .from('messages')
      .update({ content, edited_at: new Date().toISOString() })
      .eq('id', msg.id);
    if (upErr) {
      // Sem a coluna edited_at (SQL ainda não aplicado): grava só o texto.
      const { error: up2 } = await admin.from('messages').update({ content }).eq('id', msg.id);
      if (up2) return jsonResponse({ ok: false, error: up2.message }, { status: 500 });
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    if (err instanceof UazapiError) {
      const m = /not found/i.test(err.message)
        ? 'O WhatsApp não encontrou essa mensagem (pode ter passado do prazo de edição).'
        : `O WhatsApp recusou a edição: ${err.message}`;
      return jsonResponse({ ok: false, error: m }, { status: 502 });
    }
    console.error('edit-operator-message error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
