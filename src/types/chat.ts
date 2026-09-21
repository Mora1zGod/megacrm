// Chat Interno: conversa entre membros da org (DM 1:1 + grupos). Não tem
// relação com `src/types/inbox.ts` — aquilo é a conversa com o LEAD, isto é a
// comunicação da equipe.

export type ChatKind = 'dm' | 'group';

// 'system' = evento da sala (renomeou, entrou, saiu), escrito pelas RPCs do
// banco. O cliente nunca insere com esse tipo (bloqueado pela policy).
export type ChatContentType = 'text' | 'image' | 'file' | 'system';

// Linha crua de whatsapp_hub.chat_messages.
export interface ChatMessage {
  id: string;
  chat_id: string;
  sender_id: string;
  content_type: ChatContentType;
  content: string | null;
  // Path DENTRO do bucket privado whatsapp-hub-chat — não é URL. Precisa ser
  // assinado para exibir (ver lib/chatAttachments.ts).
  media_path: string | null;
  media_name: string | null;
  media_size: number | null;
  mentions: string[] | null;
  // Conversa do Inbox encaminhada para a equipe.
  ref_conversation_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

// Mensagem na thread, com o estado local do envio otimista por cima.
export type ThreadChatMessage = ChatMessage & {
  _tempId?: string;
  _state?: 'pending' | 'failed';
};

// Uma linha do retorno da RPC chat_list() — já traz tudo que a lista lateral
// precisa (título, prévia, não lidas) sem N+1.
export interface ChatListItem {
  chat_id: string;
  kind: ChatKind;
  // NULL em DM: o título é o nome do outro lado (peer_display_name).
  name: string | null;
  created_by: string | null;
  last_message_at: string | null;
  member_count: number;
  peer_user_id: string | null;
  peer_display_name: string | null;
  peer_email: string | null;
  peer_avatar_url: string | null;
  last_message_preview: string | null;
  last_message_sender_id: string | null;
  unread_count: number;
}

// Membro de uma sala (whatsapp_hub.chat_members) — usado no cabeçalho do grupo
// e no seletor de menções.
export interface ChatMemberRow {
  chat_id: string;
  user_id: string;
  last_read_at: string | null;
  created_at: string;
}

// Título exibível de uma conversa: grupos têm nome próprio, DM usa o nome do
// outro lado (com fallback para a parte local do e-mail, igual operatorLabel).
export function chatTitle(chat: ChatListItem): string {
  if (chat.kind === 'group') return chat.name?.trim() || 'Grupo sem nome';
  return chat.peer_display_name?.trim()
    || chat.peer_email?.split('@')[0]
    || 'Conversa';
}
