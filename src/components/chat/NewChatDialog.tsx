import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { operatorLabel, type Operator } from '@/hooks/useOperators';

interface NewChatDialogProps {
  open: boolean;
  onClose: () => void;
  // Membros da org, já sem o próprio usuário.
  candidates: Operator[];
  onOpenDm: (userId: string) => Promise<string | null>;
  onCreateGroup: (name: string, members: string[]) => Promise<string | null>;
  onOpened: (chatId: string) => void;
}

type Mode = 'dm' | 'group';

export function NewChatDialog({
  open, onClose, candidates, onOpenDm, onCreateGroup, onOpened,
}: NewChatDialogProps) {
  const [mode, setMode] = useState<Mode>('dm');
  const [search, setSearch] = useState('');
  const [groupName, setGroupName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (op) => operatorLabel(op).toLowerCase().includes(q) || op.email.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const reset = () => {
    setMode('dm');
    setSearch('');
    setGroupName('');
    setSelected([]);
  };

  const close = () => {
    reset();
    onClose();
  };

  const startDm = async (userId: string) => {
    setSaving(true);
    const chatId = await onOpenDm(userId);
    setSaving(false);
    if (!chatId) {
      toast.error('Não foi possível abrir a conversa.');
      return;
    }
    onOpened(chatId);
    close();
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name) {
      toast.error('Dê um nome ao grupo.');
      return;
    }
    setSaving(true);
    const chatId = await onCreateGroup(name, selected);
    setSaving(false);
    if (!chatId) {
      toast.error('Não foi possível criar o grupo.');
      return;
    }
    toast.success(`Grupo "${name}" criado.`);
    onOpened(chatId);
    close();
  };

  return (
    <Dialog open={open} onClose={close} title="Nova conversa" widthClass="max-w-md">
      <div className="space-y-4">
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] p-1">
          {([['dm', 'Conversa direta'], ['group', 'Grupo']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={
                mode === id
                  ? 'flex-1 rounded-md bg-[var(--color-accent-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary)]'
                  : 'flex-1 rounded-md px-3 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-white/5'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'group' && (
          <div>
            <Label htmlFor="chat-group-name">Nome do grupo</Label>
            <input
              id="chat-group-name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Ex.: Vendas — plantão"
              className="mt-1 w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-secondary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar membro..."
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] pl-9 pr-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
              Nenhum membro encontrado.
            </div>
          ) : (
            filtered.map((op) => {
              const isSelected = selected.includes(op.user_id);
              return (
                <button
                  key={op.user_id}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    if (mode === 'dm') {
                      void startDm(op.user_id);
                      return;
                    }
                    setSelected((prev) =>
                      prev.includes(op.user_id)
                        ? prev.filter((id) => id !== op.user_id)
                        : [...prev, op.user_id]);
                  }}
                  className={
                    isSelected && mode === 'group'
                      ? 'flex w-full items-center gap-2.5 rounded-lg bg-[var(--color-accent-subtle)] px-2.5 py-2 text-left'
                      : 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/5 disabled:opacity-60'
                  }
                >
                  <Avatar src={op.avatar_url} name={operatorLabel(op)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--color-text-primary)]">
                      {operatorLabel(op)}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--color-text-secondary)]">
                      {op.email}
                    </span>
                  </span>
                  {mode === 'group' && isSelected && (
                    <Check className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  )}
                </button>
              );
            })
          )}
        </div>

        {mode === 'group' && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--color-text-secondary)]">
              {selected.length === 0
                ? 'Você pode adicionar membros depois.'
                : `${selected.length} selecionado${selected.length > 1 ? 's' : ''}`}
            </span>
            <Button type="button" onClick={() => void createGroup()} disabled={saving || !groupName.trim()}>
              Criar grupo
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
