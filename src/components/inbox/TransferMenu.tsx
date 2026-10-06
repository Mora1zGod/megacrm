import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/Avatar';
import { operatorLabel, type Operator } from '@/hooks/useOperators';

// Botão "Transferir" com o menu de membros da equipe. Usado no cabeçalho da
// conversa (telas menores) e no topo do painel direito (≥1440px).
export function TransferMenu({
  operators,
  assignedTo,
  userId,
  onAssign,
  children,
  className,
  align = 'right',
}: {
  operators: Operator[];
  assignedTo: string | null;
  userId: string | null;
  onAssign: (uid: string | null) => Promise<void>;
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const others = operators.filter((o) => o.user_id !== assignedTo);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="Transferir conversa" className={className}>
        {children}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setOpen(false)} />
          <div role="menu" className={`fade-scale-in absolute ${align === 'right' ? 'right-0' : 'left-0'} top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-64 max-h-80 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]`}>
            <div className="px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-muted)]">Transferir para</div>
            {others.map((o) => (
              <button
                key={o.user_id}
                type="button"
                role="menuitem"
                onClick={async () => {
                  setOpen(false);
                  try {
                    await onAssign(o.user_id);
                    toast.success(`Conversa transferida para ${operatorLabel(o)}.`);
                  } catch (err) {
                    toast.error('Falha ao transferir', { description: err instanceof Error ? err.message : String(err) });
                  }
                }}
                className="flex w-full min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
              >
                <Avatar src={o.avatar_url} name={operatorLabel(o)} size="sm" />
                <span className="truncate">{operatorLabel(o)}{o.user_id === userId ? ' (você)' : ''}</span>
              </button>
            ))}
            {others.length === 0 && (
              <div className="px-2.5 py-2 text-sm text-[var(--color-text-muted)]">Nenhum outro membro na equipe.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
