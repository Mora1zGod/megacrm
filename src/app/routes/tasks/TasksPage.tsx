import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Check, CheckCircle2, ListTodo, MessageSquare, Pencil, Plus, Repeat, Search, Trash2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { useTasks, type Task } from '@/hooks/useTasks';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { operatorLabel, useOperators, type Operator } from '@/hooks/useOperators';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { formatNextDue, isRecurring, RECURRENCE_LABELS, type TaskRecurrence } from '@/lib/tasks';

type Tab = 'pending' | 'today' | 'late' | 'done' | 'all';

const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function bucketOf(t: Task, now: Date): 'late' | 'today' | 'tomorrow' | 'next' | 'nodate' {
  if (!t.due_at) return 'nodate';
  const due = new Date(t.due_at);
  const today = startOfDay(now);
  if (due < now) return 'late';
  if (due < addDays(today, 1)) return 'today';
  if (due < addDays(today, 2)) return 'tomorrow';
  return 'next';
}

const BUCKET_LABEL = { late: 'Atrasadas', today: 'Hoje', tomorrow: 'Amanhã', next: 'Próximos dias', nodate: 'Sem prazo' } as const;

function dueText(iso: string, now: Date) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const showTime = hm !== '23:59';
  if (d.toDateString() === now.toDateString()) return showTime ? `Hoje, ${hm}` : 'Hoje';
  if (d.toDateString() === addDays(now, 1).toDateString()) return showTime ? `Amanhã, ${hm}` : 'Amanhã';
  if (d.toDateString() === addDays(now, -1).toDateString()) return showTime ? `Ontem, ${hm}` : 'Ontem';
  const dm = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return showTime ? `${dm}, ${hm}` : dm;
}

export default function TasksPage() {
  const { userId } = useAppUser();
  const { operators } = useOperators();
  const { tasks, loading, error, reload, toggleTask, deleteTask } = useTasks();
  const [tab, setTab] = useState<Tab>('pending');
  const [who, setWho] = useState<string>('all'); // all | me | none | <user_id>
  const [q, setQ] = useState('');
  const [form, setForm] = useState<{ task?: Task } | null>(null);
  const now = new Date();

  const scoped = useMemo(() => {
    const term = q.trim().toLowerCase();
    return tasks.filter((t) => {
      if (who === 'me' && t.assigned_to !== userId) return false;
      if (who === 'none' && t.assigned_to) return false;
      if (who !== 'all' && who !== 'me' && who !== 'none' && t.assigned_to !== who) return false;
      if (term && !`${t.title} ${t.description ?? ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [tasks, who, q, userId]);

  const pending = scoped.filter((t) => t.status === 'pending');
  const counts = {
    pending: pending.length,
    today: pending.filter((t) => bucketOf(t, now) === 'today').length,
    late: pending.filter((t) => bucketOf(t, now) === 'late').length,
    done: scoped.filter((t) => t.status === 'done').length,
    doneToday: scoped.filter((t) => t.status === 'done' && t.completed_at && new Date(t.completed_at).toDateString() === now.toDateString()).length,
    all: scoped.length,
  };

  const visible = useMemo(() => {
    const n = new Date();
    if (tab === 'done') return scoped.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
    if (tab === 'all') return scoped;
    const p = scoped.filter((t) => t.status === 'pending');
    if (tab === 'today') return p.filter((t) => bucketOf(t, n) === 'today');
    if (tab === 'late') return p.filter((t) => bucketOf(t, n) === 'late');
    return p;
  }, [scoped, tab]);

  // Em "Pendentes", agrupa por prazo.
  const groups = useMemo(() => {
    if (tab !== 'pending') return null;
    const n = new Date();
    const order = ['late', 'today', 'tomorrow', 'next', 'nodate'] as const;
    return order
      .map((k) => ({ key: k, items: visible.filter((t) => bucketOf(t, n) === k) }))
      .filter((g) => g.items.length > 0);
  }, [visible, tab]);

  const onToggle = async (t: Task) => {
    try {
      const res = await toggleTask(t);
      if (t.status === 'pending') {
        toast.success('Tarefa concluída.', res?.nextDue ? { description: `Próxima repetição: ${formatNextDue(res.nextDue)}` } : undefined);
      }
    } catch (e) {
      toast.error('Falha ao atualizar a tarefa', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const onDelete = async (t: Task) => {
    try { await deleteTask(t.id); toast.success('Tarefa apagada.'); }
    catch (e) { toast.error('Falha ao apagar', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const tabs: [Tab, string, number][] = [
    ['pending', 'Pendentes', counts.pending],
    ['today', 'Hoje', counts.today],
    ['late', 'Atrasadas', counts.late],
    ['done', 'Concluídas', counts.done],
    ['all', 'Todas', counts.all],
  ];

  const renderRow = (t: Task) => (
    <TaskRow key={t.id} task={t} now={now} operator={operators.find((o) => o.user_id === t.assigned_to)}
      onToggle={() => void onToggle(t)} onEdit={() => setForm({ task: t })} onDelete={() => void onDelete(t)} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Tarefas</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Pendências, rotinas e follow-ups da equipe.</p>
        </div>
        <Button onClick={() => setForm({})}><Plus className="h-4 w-4" /> Nova tarefa</Button>
      </div>

      <div className="mb-4 grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={CalendarClock} label="Para hoje" value={counts.today} onClick={() => setTab('today')} />
        <Kpi icon={AlertTriangle} label="Atrasadas" value={counts.late} tone={counts.late > 0 ? 'error' : undefined} onClick={() => setTab('late')} />
        <Kpi icon={ListTodo} label="Pendentes" value={counts.pending} onClick={() => setTab('pending')} />
        <Kpi icon={CheckCircle2} label="Concluídas hoje" value={counts.doneToday} tone="success" onClick={() => setTab('done')} />
      </div>

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1">
          {tabs.map(([key, label, n]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-sm font-medium transition-colors',
                tab === key ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
              )}>
              {label}
              <span className={cn('rounded-full px-1.5 text-[11px] font-semibold',
                key === 'late' && n > 0 ? 'bg-[var(--color-error)] text-white' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]')}>{n}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar tarefa" aria-label="Buscar tarefa"
              className="h-9 w-52 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] pl-8 pr-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
          </label>
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Responsável"
            className="h-9 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text-primary)]">
            <option value="all">Toda a equipe</option>
            <option value="me">Minhas tarefas</option>
            <option value="none">Sem responsável</option>
            {operators.filter((o) => o.user_id !== userId).map((o) => <option key={o.user_id} value={o.user_id}>{operatorLabel(o)}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-[var(--color-error)]">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        ) : visible.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-8 text-center text-sm text-[var(--color-text-secondary)]">
            {tab === 'late' ? 'Nenhuma tarefa atrasada. 👏' : tab === 'today' ? 'Nada para hoje.' : tab === 'pending' ? 'Nenhuma tarefa pendente.' : 'Nada aqui ainda.'}
          </div>
        ) : groups ? (
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.key}>
                <h2 className={cn('mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide',
                  g.key === 'late' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]')}>
                  {BUCKET_LABEL[g.key]} <span className="font-normal">({g.items.length})</span>
                </h2>
                <div className="space-y-1.5">{g.items.map(renderRow)}</div>
              </section>
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">{visible.map(renderRow)}</div>
        )}
      </div>

      {form && (
        <TaskFormDialog
          initial={form.task}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); void reload(); }}
        />
      )}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, tone, onClick }: {
  icon: typeof ListTodo; label: string; value: number; tone?: 'error' | 'success'; onClick: () => void;
}) {
  const color = tone === 'error' ? 'var(--color-error)' : tone === 'success' ? 'var(--color-success)' : 'var(--accent-primary)';
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-fill-subtle)]" style={{ color }}><Icon className="h-4.5 w-4.5" /></span>
      <span>
        <span className="block text-lg font-bold leading-tight" style={tone === 'error' && value > 0 ? { color } : undefined}>{value}</span>
        <span className="block text-xs text-[var(--color-text-secondary)]">{label}</span>
      </span>
    </button>
  );
}

function TaskRow({ task, now, operator, onToggle, onEdit, onDelete }: {
  task: Task; now: Date; operator?: Operator; onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const navigate = useNavigate();
  const done = task.status === 'done';
  const late = !done && task.due_at && new Date(task.due_at) < now;
  const rec = isRecurring(task.recurrence) ? (task.recurrence as TaskRecurrence) : null;
  return (
    <div className="group flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2.5 transition-colors hover:border-[var(--accent-primary)]/40">
      <button type="button" onClick={onToggle} aria-label={done ? 'Reabrir tarefa' : 'Concluir tarefa'}
        className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
          done ? 'border-[var(--color-success)] bg-[var(--color-success)] text-white' : 'border-[var(--color-border-card)] hover:border-[var(--color-success)]')}>
        {done && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left" title="Clique para editar">
        <div className={cn('truncate text-sm font-medium text-[var(--color-text-primary)]', done && 'text-[var(--color-text-muted)] line-through')}>{task.title}</div>
        {task.description && <div className="truncate text-xs text-[var(--color-text-secondary)]">{task.description}</div>}
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {rec && (
          <span className="hidden items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent-primary)] sm:inline-flex">
            <Repeat className="h-3 w-3" /> {RECURRENCE_LABELS[rec]}
          </span>
        )}
        {task.contact_id && (
          <button type="button" onClick={() => navigate(`/inbox?contact=${task.contact_id}`)} title="Abrir conversa do contato"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--accent-primary)]">
            <MessageSquare className="h-4 w-4" />
          </button>
        )}
        {task.due_at && (
          <span className={cn('text-xs', late ? 'font-semibold text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]')}>
            {dueText(task.due_at, now)}
          </span>
        )}
        {operator
          ? <span title={operatorLabel(operator)}><Avatar src={operator.avatar_url} name={operatorLabel(operator)} size="sm" className="!h-7 !w-7" /></span>
          : <span className="h-7 w-7" aria-hidden />}
        <button type="button" onClick={onEdit} aria-label="Editar tarefa"
          className="rounded p-1 text-[var(--color-text-muted)] opacity-0 transition hover:text-[var(--accent-primary)] focus:opacity-100 group-hover:opacity-100">
          <Pencil className="h-4 w-4" />
        </button>
        <button type="button" onClick={onDelete} aria-label="Apagar tarefa"
          className="rounded p-1 text-[var(--color-text-muted)] opacity-0 transition hover:text-[var(--color-error)] focus:opacity-100 group-hover:opacity-100">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
