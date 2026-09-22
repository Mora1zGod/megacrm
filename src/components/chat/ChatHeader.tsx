import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Check, LogOut, Pencil, UserPlus, Users, X } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import { chatTitle, type ChatListItem, type ChatMemberRow } from '@/types/chat';

interface ChatHeaderProps {
  chat: ChatListItem;
  members: ChatMemberRow[];
  operatorsById: Map<string, Operator>;
  // Membros da org que ainda NÃO estão na sala.
  candidates: Operator[];
  userId: string | null;
  onRename: (chatId: string, name: string) => Promise<boolean>;
  onAddMembers: (chatId: string, members: string[]) => Promise<boolean>;
  onRemoveMember: (chatId: string, userId: string) => Promise<boolean>;
  // Saiu do grupo → a sala some da lista, o painel volta ao estado vazio.
  onLeft: () => void;
  onBack: () => void;
}

export function ChatHeader({
  chat, members, operatorsById, candidates, userId,
  onRename, onAddMembers, onRemoveMember, onLeft, onBack,
}: ChatHeaderProps) {
  const [showMembers, setShowMembers] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(chat.name ?? '');
  const [busy, setBusy] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);

  const isGroup = chat.kind === 'group';
  const title = chatTitle(chat);
  const isCreator = chat.created_by === userId;

  const commitRename = async () => {
    const next = draftName.trim();
    if (!next || next === chat.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    const ok = await onRename(chat.chat_id, next);
    setBusy(false);
    if (ok) setRenaming(false);
    else toast.error('Não foi possível renomear o grupo.');
  };

  const commitAdd = async () => {
    if (toAdd.length === 0) return;
    setBusy(true);
    const ok = await onAddMembers(chat.chat_id, toAdd);
    setBusy(false);
    if (!ok) {
      toast.error('Não foi possível adicionar os membros.');
      return;
    }
    toast.success(toAdd.length === 1 ? 'Membro adicionado.' : `${toAdd.length} membros adicionados.`);
    setToAdd([]);
  };

  const removeMember = async (targetId: string) => {
    setBusy(true);
    const ok = await onRemoveMember(chat.chat_id, targetId);
    setBusy(false);
    if (!ok) {
      toast.error('Não foi possível remover o membro.');
      return;
    }
    if (targetId === userId) {
      setShowMembers(false);
      onLeft();
    }
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b border-[rgba(14,154,160,0.08)] p-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Voltar para a lista"
          className="sm:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        {isGroup ? (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-fill-subtle)]">
            <Users className="h-4 w-4 text-[var(--accent-primary)]" />
          </span>
        ) : (
          <Avatar src={chat.peer_avatar_url} name={title} size="md" />
        )}

        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                  if (e.key === 'Escape') setRenaming(false);
                }}
                className="w-full max-w-xs rounded-lg border border-[rgba(14,154,160,0.25)] bg-[var(--color-fill-subtle)] px-2 py-1 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              />
              <Button type="button" size="icon" variant="ghost" onClick={() => void commitRename()} disabled={busy} aria-label="Salvar nome">
                <Check className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon" variant="ghost" onClick={() => setRenaming(false)} disabled={busy} aria-label="Cancelar">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</h1>
                {isGroup && (
                  <button
                    type="button"
                    onClick={() => { setDraftName(chat.name ?? ''); setRenaming(true); }}
                    className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    aria-label="Renomear grupo"
                    title="Renomear grupo"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
              <p className="truncate text-[11px] text-[var(--color-text-secondary)]">
                {isGroup
                  ? `${members.length || chat.member_count} participante${(members.length || chat.member_count) > 1 ? 's' : ''}`
                  : chat.peer_email}
              </p>
            </>
          )}
        </div>

        {isGroup && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowMembers(true)}>
            <Users className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Participantes</span>
          </Button>
        )}
      </header>

      <Dialog
        open={showMembers}
        onClose={() => setShowMembers(false)}
        title="Participantes"
        description={isCreator ? 'Você criou este grupo.' : undefined}
        widthClass="max-w-md"
      >
        <div className="space-y-4">
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {members.map((m) => {
              const op = operatorsById.get(m.user_id);
              const label = op ? operatorLabel(op) : 'Membro';
              const isSelf = m.user_id === userId;
              return (
                <li key={m.user_id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <Avatar src={op?.avatar_url} name={label} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--color-text-primary)]">
                      {label}{isSelf && ' (você)'}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--color-text-secondary)]">
                      {op?.email}
                    </span>
                  </span>
                  {/* Sair é sempre permitido; remover outro membro, só quem criou. */}
                  {(isSelf || isCreator) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeMember(m.user_id)}
                      className="shrink-0 rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-error)] disabled:opacity-60"
                      aria-label={isSelf ? 'Sair do grupo' : `Remover ${label}`}
                      title={isSelf ? 'Sair do grupo' : 'Remover do grupo'}
                    >
                      {isSelf ? <LogOut className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {candidates.length > 0 && (
            <div className="space-y-2 border-t border-[rgba(14,154,160,0.08)] pt-3">
              <div className="text-label">Adicionar ao grupo</div>
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {candidates.map((op) => {
                  const checked = toAdd.includes(op.user_id);
                  return (
                    <li key={op.user_id}>
                      <button
                        type="button"
                        onClick={() =>
                          setToAdd((prev) =>
                            prev.includes(op.user_id)
                              ? prev.filter((id) => id !== op.user_id)
                              : [...prev, op.user_id])}
                        className={
                          checked
                            ? 'flex w-full items-center gap-2.5 rounded-lg bg-[var(--color-accent-subtle)] px-2 py-1.5 text-left'
                            : 'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-surface-hover)]'
                        }
                      >
                        <Avatar src={op.avatar_url} name={operatorLabel(op)} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">
                          {operatorLabel(op)}
                        </span>
                        {checked && <Check className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Button
                type="button"
                size="sm"
                onClick={() => void commitAdd()}
                disabled={busy || toAdd.length === 0}
              >
                <UserPlus className="h-3.5 w-3.5" />
                Adicionar {toAdd.length > 0 ? `(${toAdd.length})` : ''}
              </Button>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
