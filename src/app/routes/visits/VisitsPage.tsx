import { useEffect, useMemo, useState } from 'react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Bell, Briefcase, CalendarDays, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, List, MessageSquare, Pencil, Plus, Trash2, User, Users, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { formatNextDue, isRecurring, RECURRENCE_LABELS, setTaskDone } from '@/lib/tasks';
import { REMINDER_COLORS, toLocalInput, useReminders, type Reminder, type ReminderColor } from '@/hooks/useReminders';

interface AgendaTask {
  id: string;
  title: string;
  due_at: string;
  status: 'pending' | 'done';
  assigned_to: string | null;
  contact_id: string | null;
  description?: string | null;
  recurrence?: string | null;
}

type Layer = 'visitas' | 'tarefas' | 'lembretes';

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };
const minutesOfIso = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

type VisitsView = 'agenda' | 'lista';

interface ContactLite {
  id: string;
  name: string | null;
  phone: string | null;
}

interface Visit {
  id: string;
  contact_id: string;
  visit_date: string;
  visit_time: string;
  party_size: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  notes: string | null;
  contact?: ContactLite;
}

const STATUS_STYLE: Record<Visit['status'], { label: string; className: string }> = {
  pending: { label: 'Aguardando', className: 'bg-[rgba(148,163,184,0.18)] text-[var(--color-text-secondary)]' },
  confirmed: { label: 'Confirmada', className: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' },
  completed: { label: 'Concluída', className: 'bg-[rgba(16,185,129,0.18)] text-[#10B981]' },
  cancelled: { label: 'Cancelada', className: 'bg-[rgba(239,68,68,0.18)] text-[#EF4444]' },
  no_show: { label: 'Não compareceu', className: 'bg-[rgba(242,185,55,0.18)] text-[#F2B937]' },
};

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Data LOCAL (YYYY-MM-DD). toISOString() usava UTC: depois das 19h no Acre
// (UTC-5) o "hoje" virava amanhã.
function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export default function VisitsPage() {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(() => new Date());
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailVisit, setDetailVisit] = useState<Visit | null>(null);
  const [reagendarVisit, setReagendarVisit] = useState<Visit | null>(null);
  const [view, setView] = useState<VisitsView>('agenda');
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const { userId } = useAppUser();
  const perms = usePermission();
  const { operators } = useOperators();
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ visitas: true, tarefas: true, lembretes: true });
  const [tasks, setTasks] = useState<AgendaTask[]>([]);
  const [detailTask, setDetailTask] = useState<AgendaTask | null>(null);
  const [editTask, setEditTask] = useState<AgendaTask | null>(null);
  const [detailReminder, setDetailReminder] = useState<Reminder | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [createReminderOpen, setCreateReminderOpen] = useState(false);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    }),
    [weekStart],
  );

  const weekRange = useMemo(() => {
    const end = new Date(weekStart); end.setDate(end.getDate() + 7);
    return { fromISO: weekStart.toISOString(), toISO: end.toISOString() };
  }, [weekStart]);
  const { reminders, create: createReminder, update: updateReminder, setDone: setReminderDone, remove: removeReminder } = useReminders(weekRange);
  const [editReminder, setEditReminder] = useState<Reminder | null>(null);

  const loadTasks = async () => {
    const { data } = await getSupabase()
      .from('tasks')
      .select('*')
      .gte('due_at', weekRange.fromISO)
      .lt('due_at', weekRange.toISO)
      .order('due_at', { ascending: true });
    setTasks((data ?? []) as AgendaTask[]);
  };

  const load = async () => {
    void loadTasks();
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const from = toISODate(weekDays[0]);
    const to = toISODate(weekDays[6]);
    const { data, error: err } = await supabase
      .from('park_visits')
      .select('id, contact_id, visit_date, visit_time, party_size, status, notes, contacts(id, name, phone)')
      .gte('visit_date', from)
      .lte('visit_date', to)
      .order('visit_time', { ascending: true });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      contact_id: r.contact_id as string,
      visit_date: r.visit_date as string,
      visit_time: r.visit_time as string,
      party_size: r.party_size as number,
      status: r.status as Visit['status'],
      notes: r.notes as string | null,
      contact: r.contacts as ContactLite | undefined,
    }));
    setVisits(rows);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime()]);

  // Visitas hoje — independente da semana em navegação (KPI sempre real).
  useEffect(() => {
    const today = toISODate(new Date());
    void getSupabase()
      .from('park_visits')
      .select('id', { count: 'exact', head: true })
      .eq('visit_date', today)
      .then(({ count }) => setTodayCount(count ?? 0));
  }, []);

  // KPIs da semana em navegação — só dado real, sem tendência % inventada.
  const kpis = useMemo(() => {
    const pessoas = visits.reduce((s, v) => s + (v.party_size || 0), 0);
    const passadas = visits.filter((v) => v.status === 'completed' || v.status === 'no_show');
    const compareceu = visits.filter((v) => v.status === 'completed').length;
    const taxaComparecimento = passadas.length > 0 ? (compareceu / passadas.length) * 100 : null;
    return { totalSemana: visits.length, pessoas, taxaComparecimento };
  }, [visits]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, AgendaTask[]>();
    for (const t of tasks) {
      const key = toISODate(new Date(t.due_at));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return map;
  }, [tasks]);
  const remindersByDay = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const r of reminders) {
      if (!r.due_at) continue;
      const key = toISODate(new Date(r.due_at));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [reminders]);
  const pendingTasksWeek = tasks.filter((t) => t.status === 'pending').length;

  const toggleTask = async (t: AgendaTask) => {
    const next = t.status === 'done' ? 'pending' : 'done';
    try {
      const res = await setTaskDone(t.id, next === 'done');
      toast.success(next === 'done' ? 'Tarefa concluída.' : 'Tarefa reaberta.', res.nextDue ? { description: `Próxima repetição: ${formatNextDue(res.nextDue)}` } : undefined);
    } catch (e) {
      toast.error('Falha ao atualizar a tarefa', { description: e instanceof Error ? e.message : String(e) });
      return;
    }
    setDetailTask(null);
    void loadTasks();
  };

  const visitsByDay = useMemo(() => {
    const map = new Map<string, Visit[]>();
    for (const v of visits) {
      const key = v.visit_date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(v);
    }
    return map;
  }, [visits]);

  const updateStatus = async (visit: Visit, status: Visit['status']) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.from('park_visits').update({ status }).eq('id', visit.id);
    if (err) {
      toast.error('Não foi possível atualizar a visita.', { description: err.message });
      return;
    }
    toast.success(status === 'cancelled' ? 'Visita cancelada.' : 'Visita atualizada.');
    setDetailVisit(null);
    void load();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <CalendarDays className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">Agenda</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Visitas, tarefas e lembretes num só calendário</p>
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setNewMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: 'var(--cta)' }}
          >
            <Plus className="h-4 w-4" />
            Novo
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {newMenuOpen && (
            <>
              <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setNewMenuOpen(false)} />
              <div role="menu" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-48 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
                {([
                  ['Visita', CalendarDays, () => setCreateOpen(true), 'visits.create'],
                  ['Tarefa', CheckSquare, () => setCreateTaskOpen(true), 'tasks.create'],
                  ['Lembrete', Bell, () => setCreateReminderOpen(true), 'reminders.create'],
                ] as const).filter(([, , , perm]) => perms.can(perm)).map(([label, Icon, fn]) => (
                  <button key={label} type="button" role="menuitem" onClick={() => { setNewMenuOpen(false); fn(); }} className="flex w-full min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
                    <Icon className="h-4 w-4 text-[var(--color-text-secondary)]" /> {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void load()} />}

      {/* KPIs — só dado real, sem tendência % inventada */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{todayCount === null ? '…' : todayCount}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Visitas hoje</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{kpis.totalSemana}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Visitas esta semana</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{kpis.taxaComparecimento === null ? '—' : `${kpis.taxaComparecimento.toFixed(0)}%`}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Taxa de comparecimento</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{pendingTasksWeek}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Tarefas pendentes na semana</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{reminders.filter((r) => !r.done).length}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Lembretes na semana</div>
        </div>
      </div>

      {/* Abas de visualização + camadas do calendário */}
      <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border-card)] p-1 bg-[var(--color-fill-subtle)] w-fit">
        {([
          ['agenda', 'Calendário', CalendarDays],
          ['lista', 'Lista de visitas', List],
        ] as [VisitsView, string, typeof CalendarDays][]).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              view === id ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      {view === 'agenda' && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Mostrar no calendário">
          {([
            ['visitas', 'Visitas', 'var(--accent-primary)'],
            ['tarefas', 'Tarefas', '#7C3AED'],
            ['lembretes', 'Lembretes', '#EA580C'],
          ] as [Layer, string, string][]).map(([id, label, color]) => (
            <button
              key={id}
              type="button"
              aria-pressed={layers[id]}
              onClick={() => setLayers((l) => ({ ...l, [id]: !l[id] }))}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition',
                layers[id] ? 'border-[var(--color-border-card)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] line-through opacity-60',
              )}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /> {label}
            </button>
          ))}
        </div>
      )}
      </div>

      {view === 'lista' ? (
        <VisitsListView visits={visits} onOpen={setDetailVisit} />
      ) : (
      <div className="glass-card rounded-2xl p-4">
        <div className="flex items-center justify-between mb-4">
          <button
            type="button"
            onClick={() => setAnchor((d) => { const n = new Date(d); n.setDate(n.getDate() - 7); return n; })}
            className="rounded-lg p-2 hover:bg-[var(--color-accent-subtle)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="text-sm font-semibold text-display">
            {weekDays[0].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} –{' '}
            {weekDays[6].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
          <button
            type="button"
            onClick={() => setAnchor((d) => { const n = new Date(d); n.setDate(n.getDate() + 7); return n; })}
            className="rounded-lg p-2 hover:bg-[var(--color-accent-subtle)]"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-2">
          {weekDays.map((day, i) => {
            const key = toISODate(day);
            const dayVisits = layers.visitas ? (visitsByDay.get(key) ?? []) : [];
            const dayTasks = layers.tarefas ? (tasksByDay.get(key) ?? []) : [];
            const dayReminders = layers.lembretes ? (remindersByDay.get(key) ?? []) : [];
            const isToday = key === toISODate(new Date());
            return (
              <div key={key} className="min-h-[220px] rounded-xl border border-[var(--color-border-soft)] p-2">
                <div className={cn('text-center text-xs font-semibold mb-2', isToday && 'text-[var(--accent-primary)]')}>
                  {WEEKDAYS[i]} {day.getDate()}
                </div>
                {/* Visitas, tarefas e lembretes em ordem de horário (CSS order = minutos do dia). */}
                <div className="flex flex-col gap-1.5">
                  {loading && dayVisits.length === 0 ? (
                    <>
                      <Skeleton className="h-8" />
                      <Skeleton className="h-8" />
                    </>
                  ) : dayVisits.map((v) => {
                    // Muito contato do WhatsApp vem com nome vazio ou só emoji
                    // (o próprio perfil do cliente). Nesses casos o telefone é
                    // o único identificador útil pro operador.
                    const nome = (v.contact?.name ?? '').trim();
                    const temLetra = /\p{L}/u.test(nome);
                    const rotulo = temLetra ? nome : (v.contact?.phone ?? 'Sem nome');
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setDetailVisit(v)}
                        style={{ order: minutesOf(v.visit_time) }}
                        className={cn(
                          'w-full text-left rounded-lg px-2 py-1.5 text-xs',
                          STATUS_STYLE[v.status].className,
                        )}
                      >
                        <div className="font-semibold truncate">{v.visit_time.slice(0, 5)} · {rotulo}</div>
                        {v.party_size > 1 && <div className="opacity-80">{v.party_size} pessoas</div>}
                      </button>
                    );
                  })}
                  {dayTasks.map((t) => {
                    const op = operators.find((o) => o.user_id === t.assigned_to);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setDetailTask(t)}
                        style={{ order: minutesOfIso(t.due_at) }}
                        className={cn(
                          'w-full text-left rounded-lg border-l-[3px] border-[#7C3AED] bg-[rgba(124,58,237,0.1)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]',
                          t.status === 'done' && 'opacity-50 line-through',
                        )}
                      >
                        <div className="flex items-start gap-1 font-semibold"><CheckSquare className="mt-0.5 h-3 w-3 shrink-0 text-[#7C3AED]" /> <span className="line-clamp-2">{hm(t.due_at)} · {t.title}</span></div>
                        {op && <div className="truncate opacity-75">{operatorLabel(op)}</div>}
                      </button>
                    );
                  })}
                  {dayReminders.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setDetailReminder(r)}
                      className={cn('w-full text-left rounded-lg px-2 py-1.5 text-xs text-[var(--color-text-primary)]', r.done && 'opacity-50 line-through')}
                      style={{ order: r.due_at ? minutesOfIso(r.due_at) : 0, background: `${REMINDER_COLORS[r.color]}1f`, borderLeft: `3px solid ${REMINDER_COLORS[r.color]}` }}
                    >
                      <div className="flex items-start gap-1 font-semibold"><Bell className="mt-0.5 h-3 w-3 shrink-0" style={{ color: REMINDER_COLORS[r.color] }} /> <span className="line-clamp-2">{r.due_at ? hm(r.due_at) : ''} · {r.title}</span></div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && visits.length === 0 && tasks.length === 0 && reminders.length === 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-[var(--color-border-soft)] p-6 text-center">
            <p className="text-sm text-[var(--color-text-secondary)] mb-2">Nada na agenda nesta semana.</p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Nova visita
            </Button>
          </div>
        )}
      </div>
      )}

      {createOpen && (
        <CreateVisitDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load(); }}
        />
      )}

      {detailVisit && (
        <Dialog
          open
          onClose={() => setDetailVisit(null)}
          title={
            /\p{L}/u.test((detailVisit.contact?.name ?? '').trim())
              ? (detailVisit.contact?.name as string)
              : (detailVisit.contact?.phone ?? 'Visita')
          }
        >
          <div className="space-y-3 text-sm">
            <div><span className="text-label">Data</span> {new Date(`${detailVisit.visit_date}T00:00:00`).toLocaleDateString('pt-BR')}</div>
            <div><span className="text-label">Horário</span> {detailVisit.visit_time.slice(0, 5)}</div>
            <div><span className="text-label">Pessoas</span> {detailVisit.party_size}</div>
            <div><span className="text-label">Telefone</span> {detailVisit.contact?.phone ?? '—'}</div>
            {detailVisit.notes && <div><span className="text-label">Observações</span> {detailVisit.notes}</div>}
            <div>
              <span className="text-label">Status</span>{' '}
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[detailVisit.status].className)}>
                {STATUS_STYLE[detailVisit.status].label}
              </span>
            </div>
            <VisitDealLink contactId={detailVisit.contact_id} />
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t border-[var(--color-border-card)] mt-3">
            <Button size="sm" variant="outline" onClick={() => navigate(`/contacts/${detailVisit.contact_id}`)}>
              <User className="h-3.5 w-3.5" /> Abrir contato
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/inbox?contact=${detailVisit.contact_id}`)}>
              <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 pt-3">
            {(detailVisit.status === 'pending' || detailVisit.status === 'confirmed') && (
              <>
                {detailVisit.status === 'pending' && (
                  <button type="button" onClick={() => void updateStatus(detailVisit, 'confirmed')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]">Confirmar presença</button>
                )}
                {detailVisit.status === 'confirmed' && (
                  <button type="button" onClick={() => void updateStatus(detailVisit, 'completed')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(16,185,129,0.18)] text-[#10B981]">Marcar compareceu</button>
                )}
                <button type="button" onClick={() => void updateStatus(detailVisit, 'no_show')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(242,185,55,0.18)] text-[#F2B937]">Não compareceu</button>
                <button type="button" onClick={() => { setReagendarVisit(detailVisit); setDetailVisit(null); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--color-fill-subtle)] text-[var(--color-text-primary)]">Reagendar</button>
                <button type="button" onClick={() => void updateStatus(detailVisit, 'cancelled')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(239,68,68,0.18)] text-[#EF4444]">Cancelar</button>
              </>
            )}
          </div>
        </Dialog>
      )}

      {detailTask && (
        <Dialog open onClose={() => setDetailTask(null)} title={detailTask.title}>
          <div className="space-y-2 text-sm">
            <div><span className="text-label">Prazo</span> {new Date(detailTask.due_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
            <div><span className="text-label">Responsável</span> {operatorLabel(operators.find((o) => o.user_id === detailTask.assigned_to)) || 'Ninguém'}</div>
            <div><span className="text-label">Status</span> {detailTask.status === 'done' ? 'Concluída' : 'Pendente'}</div>
            {isRecurring(detailTask.recurrence) && <div><span className="text-label">Repete</span> {RECURRENCE_LABELS[detailTask.recurrence]}</div>}
            {detailTask.description && <div className="whitespace-pre-wrap text-[var(--color-text-secondary)]">{detailTask.description}</div>}
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border-card)] pt-3">
            <Button size="sm" onClick={() => void toggleTask(detailTask)}>
              <CheckSquare className="h-3.5 w-3.5" /> {detailTask.status === 'done' ? 'Reabrir' : 'Concluir'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setEditTask(detailTask); setDetailTask(null); }}>
              <Pencil className="h-3.5 w-3.5" /> Editar
            </Button>
            {detailTask.contact_id && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/inbox?contact=${detailTask.contact_id}`)}>
                <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => navigate('/tasks')}>Ver todas as tarefas</Button>
          </div>
        </Dialog>
      )}

      {detailReminder && (
        <Dialog open onClose={() => setDetailReminder(null)} title={detailReminder.title}>
          <div className="space-y-2 text-sm">
            {detailReminder.due_at && <div><span className="text-label">Quando</span> {new Date(detailReminder.due_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>}
            {detailReminder.notes && <div className="whitespace-pre-wrap text-[var(--color-text-secondary)]">{detailReminder.notes}</div>}
            {detailReminder.shared && <div className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]"><Users className="h-3.5 w-3.5" /> Compartilhado com a equipe</div>}
          </div>
          {detailReminder.created_by === userId && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border-card)] pt-3">
              <Button size="sm" onClick={async () => { await setReminderDone(detailReminder.id, !detailReminder.done); setDetailReminder(null); }}>
                {detailReminder.done ? 'Reabrir' : 'Concluir'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setEditReminder(detailReminder); setDetailReminder(null); }}>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => { await removeReminder(detailReminder.id); setDetailReminder(null); toast.success('Lembrete apagado.'); }}>
                <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" /> Apagar
              </Button>
            </div>
          )}
        </Dialog>
      )}

      {createTaskOpen && (
        <TaskFormDialog
          defaultDate={toISODate(new Date())}
          onClose={() => setCreateTaskOpen(false)}
          onSaved={() => { setCreateTaskOpen(false); void loadTasks(); }}
        />
      )}

      {editTask && (
        <TaskFormDialog
          initial={editTask}
          onClose={() => setEditTask(null)}
          onSaved={() => { setEditTask(null); void loadTasks(); }}
        />
      )}

      {editReminder && (
        <CreateReminderDialog
          initial={editReminder}
          onClose={() => setEditReminder(null)}
          onSave={async (input) => { await updateReminder(editReminder.id, input); setEditReminder(null); toast.success('Lembrete atualizado.'); }}
        />
      )}

      {createReminderOpen && (
        <CreateReminderDialog
          onClose={() => setCreateReminderOpen(false)}
          onSave={async (input) => { await createReminder(input); setCreateReminderOpen(false); toast.success('Lembrete adicionado.'); }}
        />
      )}

      {reagendarVisit && (
        <ReagendarDialog
          visit={reagendarVisit}
          onClose={() => setReagendarVisit(null)}
          onSaved={() => { setReagendarVisit(null); void load(); }}
        />
      )}
    </div>
  );
}

function CreateVisitDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactLite[]>([]);
  const [selected, setSelected] = useState<ContactLite | null>(null);
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [time, setTime] = useState('09:00');
  const [partySize, setPartySize] = useState(1);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
        .limit(8);
      setResults((data ?? []) as ContactLite[]);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const submit = async () => {
    if (!selected) {
      toast.error('Escolhe um contato primeiro.');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error: err } = await supabase.from('park_visits').insert({
      contact_id: selected.id,
      visit_date: date,
      visit_time: time,
      party_size: partySize,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (err) {
      toast.error('Não foi possível agendar.', { description: err.message });
      return;
    }
    toast.success('Visita agendada!');
    onCreated();
  };

  return (
    <Dialog open onClose={onClose} title="Nova visita">
      <div className="space-y-3">
          <div>
            <Label>Contato</Label>
            {selected ? (
              <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm">
                <span>{selected.name ?? selected.phone}</span>
                <button type="button" onClick={() => setSelected(null)}><X className="h-4 w-4" /></button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Nome ou telefone..."
                  className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm"
                />
                {results.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-primary)] shadow-lg max-h-48 overflow-auto">
                    {results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setSelected(c); setResults([]); setQuery(''); }}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-accent-subtle)]"
                      >
                        {c.name ?? 'Sem nome'} — {c.phone}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="visit-date">Data</Label>
              <input id="visit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
            </div>
            <div>
              <Label htmlFor="visit-time">Horário</Label>
              <input id="visit-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <Label htmlFor="party-size">Nº de pessoas</Label>
            <input id="party-size" type="number" min={1} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <Label htmlFor="visit-notes">Observações (opcional)</Label>
            <input id="visit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--color-text-secondary)]">Cancelar</button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--cta)' }}
          >
            {saving ? 'Salvando...' : 'Agendar'}
          </button>
        </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Negócio vinculado — busca o negócio aberto mais recente do contato. Sem
// coluna própria de "negócio da visita" no banco; usa o mesmo critério já
// usado no Inbox (ConversationDealBar) e no Contato 360.
// ---------------------------------------------------------------------------
function VisitDealLink({ contactId }: { contactId: string }) {
  const [deal, setDeal] = useState<{ id: string; title: string; stage_id: string | null } | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void getSupabase()
      .from('deals')
      .select('id, title, stage_id')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => { if (alive) setDeal((data?.[0] as { id: string; title: string; stage_id: string | null } | undefined) ?? null); });
    return () => { alive = false; };
  }, [contactId]);

  if (deal === undefined) return null;
  if (deal === null) return <div className="text-xs text-[var(--color-text-secondary)] opacity-70">Sem negócio aberto vinculado.</div>;

  return (
    <Link to={`/funil?deal=${deal.id}`} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]">
      <Briefcase className="h-3.5 w-3.5" /> {deal.title} — abrir no funil
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Reagendar — atualiza data/horário no MESMO registro (histórico da data
// anterior fica só nas observações; o banco não tem uma tabela de histórico
// de reagendamento própria, então não inventei uma).
// ---------------------------------------------------------------------------
function ReagendarDialog({ visit, onClose, onSaved }: { visit: Visit; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(visit.visit_date);
  const [time, setTime] = useState(visit.visit_time.slice(0, 5));
  const [saving, setSaving] = useState(false);

  const salvar = async () => {
    setSaving(true);
    const notaAnterior = `[Reagendada de ${new Date(`${visit.visit_date}T00:00:00`).toLocaleDateString('pt-BR')} ${visit.visit_time.slice(0, 5)}]`;
    const { error } = await getSupabase()
      .from('park_visits')
      .update({
        visit_date: date,
        visit_time: time,
        status: 'pending',
        notes: [notaAnterior, visit.notes].filter(Boolean).join(' '),
      })
      .eq('id', visit.id);
    setSaving(false);
    if (error) { toast.error('Não consegui reagendar.', { description: error.message }); return; }
    toast.success('Visita reagendada.');
    onSaved();
  };

  return (
    <Dialog open onClose={onClose} title="Reagendar visita">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="reagendar-date">Nova data</Label>
            <input id="reagendar-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <Label htmlFor="reagendar-time">Novo horário</Label>
            <input id="reagendar-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
          A visita volta pro status "Aguardando" — confirme de novo com o cliente.
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void salvar()} loading={saving}>Reagendar</Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Visão Lista — todas as visitas já carregadas (semana atual), em tabela.
// ---------------------------------------------------------------------------
function VisitsListView({ visits, onOpen }: { visits: Visit[]; onOpen: (v: Visit) => void }) {
  const sorted = [...visits].sort((a, b) => (a.visit_date + a.visit_time).localeCompare(b.visit_date + b.visit_time));
  if (sorted.length === 0) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-sm text-[var(--color-text-secondary)]">Nenhuma visita nesta semana.</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">Troque a semana no calendário acima ou agende uma nova visita.</p>
      </div>
    );
  }
  return (
    <div className="glass-card overflow-hidden p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border-card)] text-left text-xs text-[var(--color-text-secondary)]">
            <th className="px-4 py-2 font-medium">Data</th>
            <th className="px-4 py-2 font-medium">Horário</th>
            <th className="px-4 py-2 font-medium">Contato</th>
            <th className="px-4 py-2 font-medium">Telefone</th>
            <th className="px-4 py-2 font-medium">Pessoas</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => {
            const nome = (v.contact?.name ?? '').trim();
            const rotulo = /\p{L}/u.test(nome) ? nome : (v.contact?.phone ?? 'Sem nome');
            return (
              <tr key={v.id} onClick={() => onOpen(v)} className="cursor-pointer border-b border-[var(--color-border-card)] last:border-0 hover:bg-[var(--color-fill-subtle)]">
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{new Date(`${v.visit_date}T00:00:00`).toLocaleDateString('pt-BR')}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{v.visit_time.slice(0, 5)}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-primary)]">{rotulo}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)] font-mono text-xs">{v.contact?.phone ?? '—'}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{v.party_size}</td>
                <td className="px-4 py-2.5">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[v.status].className)}>
                    {STATUS_STYLE[v.status].label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const dlgInput = 'h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

function CreateReminderDialog({ initial, onClose, onSave }: {
  initial?: Reminder;
  onClose: () => void;
  onSave: (input: { title: string; notes: string; color: ReminderColor; due_at: string | null; shared: boolean }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [color, setColor] = useState<ReminderColor>(initial?.color ?? 'green');
  const [due, setDue] = useState(toLocalInput(initial?.due_at));
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!title.trim()) { toast.error('Dê um título ao lembrete.'); return; }
    setSaving(true);
    try { await onSave({ title, notes, color, due_at: due ? new Date(due).toISOString() : null, shared }); }
    catch (e) { toast.error('Não foi possível salvar', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onClose={onClose} title={initial ? 'Editar lembrete' : 'Novo lembrete'}>
      <div className="space-y-3">
        <div><Label htmlFor="nr-title">Título</Label><input id="nr-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={dlgInput} placeholder="Ex.: Reunião com cliente" /></div>
        <div><Label htmlFor="nr-notes">Notas (opcional)</Label><textarea id="nr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${dlgInput} h-auto py-2`} /></div>
        <div>
          <Label>Cor</Label>
          <div className="mt-1 flex gap-2">
            {(Object.keys(REMINDER_COLORS) as ReminderColor[]).map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Cor ${c}`} aria-pressed={color === c}
                className={`h-7 w-7 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-[var(--color-text-primary)] ring-offset-[var(--color-surface)]' : ''}`}
                style={{ background: REMINDER_COLORS[c] }} />
            ))}
          </div>
        </div>
        <div><Label htmlFor="nr-due">Data e hora</Label><input id="nr-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={dlgInput} /></div>
        <label className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 py-2 text-sm">
          <span>Compartilhar com a equipe</span>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 accent-[var(--accent-fill)]" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void save()} disabled={saving || !title.trim()}>{saving ? 'Salvando…' : initial ? 'Salvar alterações' : 'Adicionar lembrete'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
