export type ConversationStatus = 'ai_active' | 'human_active' | 'closed';
export type ConversationChannel = 'whatsapp' | 'instagram';
export type MessageDirection = 'inbound' | 'outbound';
// 'owner' = mensagem que o dono do número enviou direto pelo WhatsApp do
// celular (fora do CRM), capturada pelo webhook UAZAPI. Renderiza como "WhatsApp".
export type SenderType = 'contact' | 'ai' | 'operator' | 'system' | 'owner';
export type ContentType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'template' | 'note';
export type MetaMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface Conversation {
  id: string;
  contact_id: string;
  status: ConversationStatus;
  assigned_to: string | null;
  assigned_at: string | null;
  // Fila para a qual a conversa foi roteada (herdada do canal na criação, ou
  // trocada manualmente). null = "sem fila" — visível a todo mundo (ver
  // TeamSettings → Filas). Controle de acesso real é via RLS, isto é só exibição.
  queue_id: string | null;
  ai_paused: boolean;
  channel: ConversationChannel;
  // Negócio (deal) em foco nesta conversa. Independente de assigned_to/owner_id.
  active_deal_id: string | null;
  last_message_at: string | null;
  unread_count: number;
  pinned_note: string | null;
  // Favoritar conversa (estrela no cabeçalho, filtro "Favoritas" na lista).
  is_favorite: boolean;
  archived: boolean;
  // Conta Zernio que recebeu a conversa (multi-conta no Zernio).
  zernio_account_id: string | null;
  // Provedor: 'zernio' (WhatsApp Meta oficial / Instagram) × 'uazapi'
  // (integração direta, sem janela de 24h). Último inbound decide.
  provider: 'zernio' | 'uazapi';
  // Canal (número) que recebeu a conversa (whatsapp_hub.channels). Usado pra
  // exibir qual número/instância é, quando há mais de um canal conectado.
  channel_id: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  sender_type: SenderType;
  sender_id: string | null;
  content_type: ContentType;
  content: string | null;
  media_url: string | null;
  zernio_message_id: string | null;
  // Status de entrega relayado pelo Zernio (coluna meta_status mantida).
  meta_status: MetaMessageStatus | null;
  // Motivo da falha de entrega (webhook 1:1 ou sync de broadcast).
  error_reason: string | null;
  is_private_note: boolean;
  created_at: string;
  // Autor da mensagem em GRUPO do WhatsApp (UAZAPI). null fora de grupo.
  sender_name?: string | null;
}

export interface ConversationWithContact extends Conversation {
  contact: {
    id: string;
    // Nullable: contatos Instagram não têm telefone.
    phone: string | null;
    name: string | null;
    email: string | null;
    // Foto do lead (via UAZAPI). Null para leads Zernio → fallback iniciais.
    profile_pic_url: string | null;
    custom_fields: Record<string, unknown>;
    // 'whatsapp' | 'instagram' — de onde o contato entrou em contato a 1ª vez.
    source: string | null;
  } | null;
  lastMessagePreview: string | null;
  // Direção da última mensagem não-privada. 'inbound' ⇒ quem falou por último
  // foi o contato, ou seja, a conversa está aguardando resposta.
  // Não dá para derivar de last_message_at vs lastInboundAt: last_message_at é
  // gravado no momento do PROCESSAMENTO (~250ms depois do created_at da
  // mensagem), então o inbound fica sempre "mais antigo" que ele.
  lastMessageDirection: 'inbound' | 'outbound' | null;
  // IDs das tags do contato — usados pelo filtro de Tags do inbox (Módulo 7).
  tagIds: string[];
  // Timestamp da última mensagem do CONTATO (inbound) — deriva a janela de 24h
  // da Meta sem coluna dedicada.
  lastInboundAt: string | null;
  // Contato tem algum deal como Cliente (filtro Lead/Cliente do inbox).
  isCliente: boolean;
  // Número/label do canal que recebeu a conversa (null = sem canal
  // registrado, ex. conversas antigas pré-multi-canal). Usado na etiqueta da
  // lista pra diferenciar entre múltiplos números UAZAPI/WhatsApp conectados.
  channelPhone: string | null;
  channelLabel: string | null;
}
