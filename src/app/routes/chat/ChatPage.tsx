import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessagesSquare } from 'lucide-react';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useInternalChat, useChatMembers } from '@/hooks/useInternalChat';
import { useChatMessages } from '@/hooks/useChatMessages';
import { useOperators, operatorLabel } from '@/hooks/useOperators';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatThread } from '@/components/chat/ChatThread';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { NewChatDialog } from '@/components/chat/NewChatDialog';

// Chat Interno: comunicação da EQUIPE (DM 1:1 + grupos), separada do Inbox,
// que fala com o lead. Layout de 2 painéis; no mobile só um aparece por vez.
export default function ChatPage() {
  const { userId } = useAppUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const { operators } = useOperators();
  const {
    chats, loading, openDm, createGroup, markRead,
    addMembers, removeMember, rename,
  } = useInternalChat();

  // Deep link: /chat?chat=<id> — usado pela notificação de menção.
  const activeChatId = searchParams.get('chat');
  const [showNew, setShowNew] = useState(false);
  // Bump após entrar/sair/adicionar: força o refetch da lista de participantes.
  const [membersVersion, setMembersVersion] = useState(0);

  const members = useChatMembers(activeChatId, membersVersion);
  const {
    messages, loading: loadingMessages, loadingOlder, hasOlder, loadOlder,
    sendText, sendFile, editMessage, deleteMessage,
  } = useChatMessages(activeChatId);

  const operatorsById = useMemo(
    () => new Map(operators.map((op) => [op.user_id, op])),
    [operators],
  );

  const activeChat = chats.find((c) => c.chat_id === activeChatId) ?? null;

  const selectChat = useCallback((chatId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('chat', chatId);
      return next;
    });
  }, [setSearchParams]);

  const clearChat = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('chat');
      return next;
    });
  }, [setSearchParams]);

  // Sala aberta = lida. Reaplica quando chega mensagem nova com a sala em foco.
  useEffect(() => {
    if (!activeChatId) return;
    void markRead(activeChatId);
  }, [activeChatId, messages.length, markRead]);

  // Participantes da sala ativa, como Operator (nome/avatar para menções).
  const chatOperators = useMemo(() => {
    if (!activeChat) return [];
    if (activeChat.kind === 'dm') {
      return operators.filter(
        (op) => op.user_id === activeChat.peer_user_id || op.user_id === userId,
      );
    }
    const ids = new Set(members.map((m) => m.user_id));
    return operators.filter((op) => ids.has(op.user_id));
  }, [activeChat, members, operators, userId]);

  const memberLabels = useMemo(
    () => chatOperators.map(operatorLabel),
    [chatOperators],
  );

  // Quem ainda não está no grupo (para o botão "Adicionar ao grupo").
  const addCandidates = useMemo(() => {
    const ids = new Set(members.map((m) => m.user_id));
    return operators.filter((op) => !ids.has(op.user_id));
  }, [members, operators]);

  const dmCandidates = useMemo(
    () => operators.filter((op) => op.user_id !== userId),
    [operators, userId],
  );

  return (
    <div className="flex h-[calc(100vh-var(--header-h,4rem))] flex-col">
      <div className="flex items-center gap-4 px-4 pb-3 pt-1">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl glass-card">
          <MessagesSquare className="h-4.5 w-4.5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Operação</div>
          <h1 className="text-xl font-bold text-display">Chat Interno</h1>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[rgba(14,154,160,0.12)]">
        <div className={activeChatId ? 'hidden sm:flex' : 'flex w-full'}>
          <ChatSidebar
            chats={chats}
            loading={loading}
            activeChatId={activeChatId}
            onSelect={selectChat}
            onNew={() => setShowNew(true)}
          />
        </div>

        <section className={`min-w-0 flex-1 flex-col ${activeChatId ? 'flex' : 'hidden sm:flex'}`}>
          {activeChat ? (
            <>
              <ChatHeader
                chat={activeChat}
                members={members}
                operatorsById={operatorsById}
                candidates={addCandidates}
                userId={userId}
                onRename={rename}
                onAddMembers={async (chatId, ids) => {
                  const ok = await addMembers(chatId, ids);
                  if (ok) setMembersVersion((v) => v + 1);
                  return ok;
                }}
                onRemoveMember={async (chatId, targetId) => {
                  const ok = await removeMember(chatId, targetId);
                  if (ok) setMembersVersion((v) => v + 1);
                  return ok;
                }}
                onLeft={clearChat}
                onBack={clearChat}
              />
              <ChatThread
                messages={messages}
                userId={userId}
                operatorsById={operatorsById}
                memberLabels={memberLabels}
                loading={loadingMessages}
                hasOlder={hasOlder}
                loadingOlder={loadingOlder}
                loadOlder={loadOlder}
                onEdit={editMessage}
                onDelete={deleteMessage}
              />
              <ChatComposer
                members={chatOperators}
                onSendText={(text, mentions) => sendText(text, { mentions })}
                onSendFile={sendFile}
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="text-center text-sm text-[var(--color-text-secondary)]">
                <MessagesSquare className="mx-auto mb-2 h-7 w-7 opacity-50" />
                Escolha uma conversa à esquerda ou comece uma nova.
              </div>
            </div>
          )}
        </section>
      </div>

      <NewChatDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        candidates={dmCandidates}
        onOpenDm={openDm}
        onCreateGroup={createGroup}
        onOpened={selectChat}
      />
    </div>
  );
}
