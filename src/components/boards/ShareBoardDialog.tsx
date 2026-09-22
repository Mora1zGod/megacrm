import { Users } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/dialog';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import { useBoardMembers } from '@/hooks/useBoards';

interface Props {
  boardId: string;
  boardName: string;
  operators: Operator[];
  onClose: () => void;
  onChanged: () => void;
}

export function ShareBoardDialog({ boardId, boardName, operators, onClose, onChanged }: Props) {
  const { memberIds, loading, toggleMember } = useBoardMembers(boardId);

  const handleToggle = async (userId: string) => {
    try {
      await toggleMember(userId);
      onChanged();
    } catch (err) {
      toast.error('Não consegui atualizar.', { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Compartilhar "${boardName}"`} widthClass="max-w-md">
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {memberIds.length === 0
            ? 'Sem ninguém marcado, esse quadro fica visível pra toda a equipe (padrão atual).'
            : 'Só quem estiver marcado abaixo (+ admins) vê e mexe nesse quadro.'}
        </p>
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {operators.map((o) => (
            <label
              key={o.user_id}
              className="flex items-center gap-2.5 rounded-lg border border-[rgba(14,154,160,0.15)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--color-surface-hover)]"
            >
              <input
                type="checkbox"
                checked={memberIds.includes(o.user_id)}
                disabled={loading}
                onChange={() => void handleToggle(o.user_id)}
              />
              <span className="flex-1">{operatorLabel(o)}</span>
              {o.role === 'admin' && (
                <span className="text-[10px] font-semibold text-[var(--color-text-secondary)]">admin · sempre vê</span>
              )}
            </label>
          ))}
          {operators.length === 0 && (
            <p className="text-xs text-[var(--color-text-secondary)] opacity-70 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" /> Nenhum operador cadastrado ainda.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
