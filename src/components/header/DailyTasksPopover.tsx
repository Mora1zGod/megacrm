import { useCallback, useEffect, useState } from 'react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronRight, ClipboardList, Plus, Repeat, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { Avatar } from '@/components/ui/Avatar';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { formatNextDue, isRecurring, setTaskDone } from '@/lib/tasks';

interface DayTask {
  id: string;
  title: string;
  due_at: string | null;
  status: 'pending' | 'done';
  assigned_to: string | null;
  recurrence?: string | null;
}

function dayBounds() {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + 1);
  return { from: s.toISOString(), to: e.toISOString() };
}

// "Tarefas Diárias" no topo: tarefas com prazo hoje que são minhas (ou sem
// responsável), contador feitas/total, marcar como feita e criar rápido.
export function DailyTasksPopover() {
  const { userId } = useAppUser();
  const perms = usePermission();
  const { operators } = useOperators();
  const [tasks, setTasks] = useState<DayTask[]>([]);
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const { from, to } = dayBounds();
    const { data } = await getSupabase()
      .from('tasks')
      .select('*')
      .gte('due_at', from)
      .lt('due_at', to)
      .or(`assigned_to.eq.${userId},assigned_to.is.null`)
      .order('due_at', { ascending: true });
    setTasks((data ?? []) as DayTask[]);
  }, [userId]);

  useEffect(() => {
    void load();
    const supabase = getSupabase();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`daily-tasks-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'tasks' }, () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void load(), 1000); })
      .subscribe();
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(ch); };
  }, [load]);

  const done = tasks.filter((t) => t.status === 'done').length;
  const pending = tasks.length - done;

  const toggle = async (t: DayTask) => {
    const next = t.status === 'done' ? 'pending' : 'done';
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    try {
      const res = await setTaskDone(t.id, next === 'done');
      if (res.nextDue) toast.success('Tarefa concluída.', { description: `Próxima repetição: ${formatNextDue(res.nextDue)}` });
    } catch (e) {
      toast.error('Falha ao atualizar a tarefa', { description: e instanceof Error ? e.message : String(e) });
      void load();
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <ClipboardList className="h-4 w-4 text-[var(--accent-primary)]" />
        <span className="hidden min-[1800px]:inline">Tarefas Diárias</span>
        {pending > 0 && (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-error)] px-1 text-[10px] font-bold text-white">{pending}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Tarefas diárias" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-[320px] max-w-[calc(100vw-24px)] rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-lg)]">
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-text-primary)]">
                Tarefas Diárias
                <span className="rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-xs font-bold text-[var(--color-error)]">{done}/{tasks.length}</span>
              </div>
              <div className="flex items-center gap-1">
                {perms.can('tasks.create') && <button type="button" onClick={() => { setOpen(false); setFormOpen(true); }} aria-label="Nova tarefa para hoje" title="Nova tarefa para hoje" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)]"><Plus className="h-4 w-4" /></button>}
                <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {tasks.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-[var(--color-text-muted)]">Nenhuma tarefa para hoje. 🎉</div>
            ) : (
              <ul className="max-h-80 space-y-0.5 overflow-y-auto">
                {tasks.map((t) => {
                  const op = operators.find((o) => o.user_id === t.assigned_to);
                  const isDone = t.status === 'done';
                  return (
                    <li key={t.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-[var(--color-surface-hover)]">
                      <input type="checkbox" checked={isDone} disabled={!perms.can('tasks.complete')} onChange={() => void toggle(t)} aria-label={`Concluir: ${t.title}`} className="h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-sm ${isDone ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text-primary)]'}`}>{t.title}</div>
                        <div className={`flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] ${isDone ? 'line-through' : ''}`}>
                          {t.due_at && <span>{new Date(t.due_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
                          {isRecurring(t.recurrence) && <Repeat className="h-3 w-3" aria-label="Recorrente" />}
                        </div>
                      </div>
                      {op && <Avatar src={op.avatar_url} name={operatorLabel(op)} size="sm" className="!h-7 !w-7" />}
                    </li>
                  );
                })}
              </ul>
            )}

            <Link to="/tasks" onClick={() => setOpen(false)} className="mt-2 flex items-center justify-between rounded-lg bg-[var(--color-fill-subtle)] px-3 py-2 text-sm font-medium text-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)]">
              Ver todas as tarefas <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </>
      )}
      {formOpen && (
        <TaskFormDialog onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); void load(); }} />
      )}
    </div>
  );
}
