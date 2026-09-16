// ============================================================================
// jarvis-agent/reply.ts — resposta de volta pelo WhatsApp
// ----------------------------------------------------------------------------
// O Jarvis responde pelo MESMO número do Amai Park por onde a pergunta chegou,
// reusando os helpers já existentes do CRM (_shared/channels.ts, zernio.ts,
// uazapi.ts). Nenhuma credencial nova.
//
// Diferença para o AMAIA: o AMAIA responde dentro de uma conversa do CRM
// (sendInboxWithResolve, que precisa de whatsapp_hub.conversations). O Jarvis
// não cria conversa — o roteamento desvia antes disso — então a conversa do
// Zernio é resolvida direto pelo telefone, do mesmo jeito que o resolveFresh()
// do _shared/inbox-delivery.ts faz para WhatsApp.
// ============================================================================

import { getSendContextForConversation } from '../_shared/channels.ts';
import { createInboxConversation, sendInboxMessage } from '../_shared/zernio.ts';
import { uazapiSendText } from '../_shared/uazapi.ts';
import type { Admin } from './types.ts';

// A Meta corta texto acima de ~4096 caracteres; quebramos com folga, em quebra
// de linha quando dá, para não picotar frase no meio.
const LIMITE = 3500;

export function fatiarTexto(texto: string, limite = LIMITE): string[] {
  const limpo = texto.trim();
  if (limpo.length <= limite) return [limpo];
  const partes: string[] = [];
  let resto = limpo;
  while (resto.length > limite) {
    const janela = resto.slice(0, limite);
    const corte = Math.max(janela.lastIndexOf('\n'), janela.lastIndexOf('. '));
    const ponto = corte > limite * 0.5 ? corte + 1 : limite;
    partes.push(resto.slice(0, ponto).trim());
    resto = resto.slice(ponto).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

export async function responderWhatsApp(
  admin: Admin,
  input: {
    orgId: string;
    phone: string;
    zernioAccountId: string | null;
    /** Provedor do webhook que trouxe a mensagem: 'zernio' (default) ou 'uazapi'. */
    provider?: string | null;
    /** Canal (whatsapp_hub.channels) que recebeu — obrigatório no uazapi. */
    channelId?: string | null;
    texto: string;
  },
): Promise<void> {
  const partes = fatiarTexto(input.texto);

  // A resposta volta pelo MESMO canal que recebeu a pergunta: o roteamento
  // informa provider/channel_id, então uma pergunta que chegou por UAZAPI é
  // respondida pela instância UAZAPI, não pelo número oficial.
  const sendCtx = await getSendContextForConversation(admin, {
    org_id: input.orgId,
    channel_id: input.channelId ?? null,
    provider: input.provider ?? null, // null: cai no default 'zernio'
    zernio_account_id: input.zernioAccountId,
  });

  if (sendCtx.provider === 'uazapi') {
    for (const parte of partes) {
      await uazapiSendText(sendCtx.uazapi, { phone: input.phone, text: parte });
    }
    return;
  }

  const { apiKey, accountId } = sendCtx.zernio;
  // POST /inbox/conversations com o telefone devolve o id de conversa VÁLIDO
  // para envio (o id que vem no webhook inbound não é aceito pelo endpoint de
  // mensagens — ver comentário em _shared/inbox-delivery.ts).
  const criada = await createInboxConversation({ apiKey, accountId, participantId: input.phone });
  if (!criada.conversationId) {
    throw new Error('Não foi possível resolver a conversa do Jarvis no Zernio.');
  }
  for (const parte of partes) {
    await sendInboxMessage({
      apiKey,
      accountId,
      conversationId: criada.conversationId,
      text: parte,
    });
  }
}
