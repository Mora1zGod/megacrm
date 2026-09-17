import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckSquare, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTasks, type Task } from '@/hooks/useTasks';

type Filter = 'pending' | 'done' | 'all';

export default function TasksPage() {
  const { tasks, loading, error, createTask, toggleTask, deleteTask } = useTasks();
  const [filter, setFilter] = useState<Filter>('pending');
  const [novaOpen, setNovaOpen] = useState(false);

  const visiveis = useMemo(() => {
    if (filter === 'all') return tasks;
    return tasks.filter((t) => t.status === filter);
  }, [tasks, filter]);

  const pendingCount = tasks.filter((t) => t.status === 'pending').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Tarefas</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Pendências e follow-ups da equipe.</p>
        </div>
        <Button onClick={() => setNovaOpen(true)}>
          <Plus className="h-4 w-4" /> Nova tarefa
        </Button>
      </div>

      <div className="flex gap-1.5 mb-3 shrink-0">
        {([
          ['pending', `Pendentes ${pendingCount}`],
          ['done', `Concluídas ${doneCount}`],
          ['all', `Todas ${tasks.length}`],
        ] as [Filter, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors duration-150',
              filter === key
                ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-[var(--color-error)] mb-3">{error}</p>}

      <div className="flex-1 overflow-y-auto space-y-1.5">
        {loading ? (
          <p className="text-sm text-[var(--color-text-secondary)]">Carregando...</p>
        ) : visiveis.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
            {filter === 'pending' ? 'Nenhuma tarefa pendente.' : 'Nada aqui ainda.'}
          </div>
        ) : (
          visiveis.map((task) => <TaskRow key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} />)
        )}
      </div>

      {novaOpen && (
        <NovaTarefaDialog onClose={() => setNovaOpen(false)} onCreate={createTask} />
      )}
    </div>
  );
}

function TaskRow({
  task, onToggle, onDelete,
}: { task: Task; onToggle: (t: Task) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const atrasada = task.status === 'pending' && task.due_at && new Date(task.due_at) < new Date();
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2.5 group">
      <button
        onClick={() => void onToggle(task).catch((e) => toast.error('Falha', { description: e.message }))}
        aria-label={task.status === 'done' ? 'Reabrir' : 'Concluir'}
        className={cn(
          'h-5 w-5 shrink-0 rounded-[6px] border flex items-center justify-center transition-colors',
          task.status === 'done'
            ? 'bg-[var(--color-success)] border-[var(--color-success)] text-white'
            : 'border-[var(--color-border-card)] hover:border-[var(--accent-primary)]',
        )}
      >
        {task.status === 'done' && <CheckSquare className="h-3.5 w-3.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm text-[var(--color-text-primary)]', task.status === 'done' && 'line-through opacity-60')}>
          {task.title}
        </div>
        {task.description && (
          <div className="text-xs text-[var(--color-text-secondary)] truncate">{task.description}</div>
        )}
      </div>
      {task.due_at && (
        <span className={cn('shrink-0 text-xs', atrasada ? 'text-[var(--color-error)] font-medium' : 'text-[var(--color-text-secondary)]')}>
          {new Date(task.due_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <button
        onClick={() => void onDelete(task.id).catch((e) => toast.error('Falha', { description: e.message }))}
        aria-label="Apagar"
        className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-[var(--color-error)] transition-opacity"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function NovaTarefaDialog({
  onClose, onCreate,
}: { onClose: () => void; onCreate: (i: { title: string; due_at?: string | null }) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [saving, setSaving] = useState(false);

  const salvar = async () => {
    if (!title.trim()) { toast.error('Dê um título à tarefa.'); return; }
    setSaving(true);
    try {
      await onCreate({ title: title.trim(), due_at: dueAt ? new Date(dueAt).toISOString() : null });
      onClose();
    } catch (err) {
      toast.error('Falha ao criar', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Nova tarefa">
      <div className="space-y-3">
        <div>
          <Label htmlFor="task-title">Título</Label>
          <input
            id="task-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void salvar(); }}
            placeholder="Ex.: Ligar para confirmar visita"
            className="w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
        <div>
          <Label htmlFor="task-due">Prazo (opcional)</Label>
          <input
            id="task-due"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void salvar()} disabled={saving}>{saving ? 'Criando...' : 'Criar'}</Button>
      </div>
    </Dialog>
  );
}
