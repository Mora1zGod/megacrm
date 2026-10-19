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
import { fetchAllOrgTasks, readCompanyScope, saveCompanyScope, setTaskDoneAnyOrg, useTaskCompanies, type CompanyScope } from '@/lib/tasksAllOrgs';

interface DayTask {
  id: string;
  title: string;
  due_at: string | null;
  status: 'pending' | 'done';
  assigned_to: string | null;
  recurrence?: string | null;
  org_id?: string;
  org_name?: string;
  assigned_name?: string | null;
  can_complete?: boolean;
}

const AHEAD_DAYS = 30;  // "Próximas": até 30 dias à frente
const BEHIND_DAYS = 90; // "Atrasadas": pendentes de até 90 dias atrás

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

type View = 'hoje' | 'proximas' | 'atrasadas';
const SCOPE_KEY = 'megacrm_daily_tasks_scope';

// Título do grupo nas próximas: "Amanhã", "sex., 24/10", ...
function dayLabel(iso: string): string {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - startOfToday().getTime()) / 86_400_000);
  if (diff === 1) return 'Amanhã';
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

// "Tarefas Diárias" no topo: minhas tarefas (ou sem responsável) em três abas — Hoje (contador feitas/total),
// Próximas (pendentes dos próximos 30 dias, por dia) e Atrasadas (pendentes vencidas). Marcar como feita adianta
// a tarefa (recorrente: a próxima continua contando da data marcada). Bolinha = pendentes de hoje + atrasadas.
export function DailyTasksPopover() {
  const { userId, orgId } = useAppUser();
  // Todas as empresas (mesma escolha da tela de Tarefas).
  const { companies, multi } = useTaskCompanies();
  const [companyScope, setCompanyScopeState] = useState<CompanyScope>(readCompanyScope);
  const allMode = multi && companyScope === 'all';
  const setCompanyScope = (v: CompanyScope) => { setCompanyScopeState(v); saveCompanyScope(v); };
  const [xUsed, setXUsed] = useState(false);
  const perms = usePermission();
  const { allOperators: operators } = useOperators(); // nomes: inclui desativados (histórico)
  const [tasks, setTasks] = useState<DayTask[]>([]);
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [view, setView] = useState<View>('hoje');
  // Minhas (eu + sem responsável) ou da equipe toda (o que o RLS deixa ver). Guardado no navegador.
  const [scope, setScopeState] = useState<'mine' | 'all'>(() => { try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'mine'; } catch { return 'mine'; } });
  const setScope = (v: 'mine' | 'all') => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v); } catch { /* sem storage */ } };

  const load = useCallback(async () => {
    if (!userId) return;
    const today = startOfToday();
    if (allMode) {
      try {
        const rows = await fetchAllOrgTasks(addDays(today, -BEHIND_DAYS).toISOString(), addDays(today, AHEAD_DAYS + 1).toISOString());
        if (rows) { setTasks(rows as unknown as DayTask[]); setXUsed(true); return; }
      } catch { /* cai na empresa em uso */ }
    }
    setXUsed(false);
    const { data } = await getSupabase()
      .from('tasks')
      .select('*')
      .gte('due_at', addDays(today, -BEHIND_DAYS).toISOString())
      .lt('due_at', addDays(today, AHEAD_DAYS + 1).toISOString())
      .order('due_at', { ascending: true });
    setTasks((data ?? []) as DayTask[]);
  }, [userId, allMode]);

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

  const t0 = startOfToday().getTime();
  const t1 = addDays(startOfToday(), 1).getTime();
  const at = (t: DayTask) => (t.due_at ? new Date(t.due_at).getTime() : 0);
  const mine = (t: DayTask) => !t.assigned_to || t.assigned_to === userId;
  const scoped = scope === 'all' ? tasks : tasks.filter(mine);
  // Bolinha do botão: sempre só as MINHAS (hoje pendentes + atrasadas).
  const myLate = tasks.filter((t) => mine(t) && t.status === 'pending' && at(t) < t0).length;
  const myTodayOpen = tasks.filter((t) => mine(t) && t.status === 'pending' && at(t) >= t0 && at(t) < t1).length;
  const todayTasks = scoped.filter((t) => at(t) >= t0 && at(t) < t1);
  const lateTasks = scoped.filter((t) => t.status === 'pending' && at(t) < t0);
  const nextTasks = scoped.filter((t) => t.status === 'pending' && at(t) >= t1);
  const done = todayTasks.filter((t) => t.status === 'done').length;
  const pending = myTodayOpen + myLate;
  const inView = (t: DayTask) => view === 'hoje' ? at(t) >= t0 && at(t) < t1 : t.status === 'pending' && (view === 'proximas' ? at(t) >= t1 : at(t) < t0);
  const othersInView = tasks.filter((t) => !mine(t) && inView(t)).length;
  const shown = (view === 'hoje' ? todayTasks : view === 'proximas' ? nextTasks : lateTasks).slice().sort((a, b) => at(a) - at(b));

  const toggle = async (t: DayTask) => {
    const next = t.status === 'done' ? 'pending' : 'done';
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    try {
      const res = xUsed ? await setTaskDoneAnyOrg(t, next === 'done') : await setTaskDone(t.id, next === 'done');
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
          <div role="dialog" aria-label="Tarefas diárias" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-[380px] max-w-[calc(100vw-24px)] rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-lg)]">
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-text-primary)]">
                Tarefas Diárias
                <span className="rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-xs font-bold text-[var(--color-error)]">{done}/{todayTasks.length}</span>
              </div>
              <div className="flex items-center gap-1">
                {perms.can('tasks.create') && <button type="button" onClick={() => { setOpen(false); setFormOpen(true); }} aria-label="Nova tarefa" title="Nova tarefa" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)]"><Plus className="h-4 w-4" /></button>}
                <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><X className="h-4 w-4" /></button>
              </div>
            </div>

            <div className="mb-2 flex items-center gap-1 px-1 text-xs">
              <span className="text-[var(--color-text-muted)]">Mostrar:</span>
              {([['mine', 'Minhas'], ['all', 'Equipe']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}
                  className={`rounded-full border px-2.5 py-0.5 font-medium ${scope === k ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-soft)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
                  {label}
                </button>
              ))}
              {multi && (
                <button type="button" aria-pressed={allMode} onClick={() => setCompanyScope(allMode ? 'current' : 'all')}
                  title={allMode ? 'Mostrando tarefas de todas as suas empresas' : 'Juntar as tarefas de todas as suas empresas'}
                  className={`ml-auto rounded-full border px-2.5 py-0.5 font-medium ${allMode ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-soft)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
                  {allMode ? `Todas as empresas (${companies.length})` : 'Todas as empresas'}
                </button>
              )}
            </div>

            <div role="tablist" aria-label="Período" className="mb-2 flex gap-1 rounded-lg bg-[var(--color-fill-subtle)] p-1">
              {([['hoje', 'Hoje', todayTasks.length - done], ['proximas', 'Próximas', nextTasks.length], ['atrasadas', 'Atrasadas', lateTasks.length]] as const).map(([k, label, n]) => (
                <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${view === k ? 'bg-[var(--color-surface)] text-[var(--accent-primary)] shadow-sm' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                  {label}
                  {n > 0 && <span className={`rounded-full px-1.5 text-[10px] ${k === 'atrasadas' ? 'bg-[var(--color-error)] text-white' : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'}`}>{n}</span>}
                </button>
              ))}
            </div>

            {shown.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-[var(--color-text-muted)]">
                {view === 'hoje' ? 'Nenhuma tarefa para hoje. 🎉' : view === 'proximas' ? `Nada nos próximos ${AHEAD_DAYS} dias.` : 'Nenhuma tarefa atrasada. 👏'}
                {scope === 'mine' && othersInView > 0 && (
                  <button type="button" onClick={() => setScope('all')} className="mt-2 block w-full text-xs font-medium text-[var(--accent-primary)] hover:underline">
                    {othersInView} de outras pessoas da equipe — ver
                  </button>
                )}
              </div>
            ) : (
              <ul className="max-h-96 space-y-0.5 overflow-y-auto">
                {shown.map((t, i) => {
                  const op = operators.find((o) => o.user_id === t.assigned_to);
                  const isDone = t.status === 'done';
                  // Próximas/Atrasadas: separador por dia.
                  const group = view !== 'hoje' && t.due_at ? (view === 'proximas' ? dayLabel(t.due_at) : new Date(t.due_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })) : null;
                  const prev = i > 0 ? shown[i - 1] : null;
                  const prevGroup = prev && view !== 'hoje' && prev.due_at ? (view === 'proximas' ? dayLabel(prev.due_at) : new Date(prev.due_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })) : null;
                  return (
                    <li key={t.id}>
                      {group && group !== prevGroup && (
                        <div className={`px-2 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide ${view === 'atrasadas' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}>{group}</div>
                      )}
                      <div className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-[var(--color-surface-hover)]">
                        <input type="checkbox" checked={isDone} disabled={xUsed ? t.can_complete === false : !perms.can('tasks.complete')} onChange={() => void toggle(t)} aria-label={`Concluir: ${t.title}`} title={view === 'proximas' ? 'Concluir agora (adiantar)' : 'Concluir'} className="h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                        <div className="min-w-0 flex-1">
                          <div className={`truncate text-sm ${isDone ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text-primary)]'}`}>{t.title}</div>
                          <div className={`flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] ${isDone ? 'line-through' : ''}`}>
                            {t.due_at && <span>{new Date(t.due_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
                            {isRecurring(t.recurrence) && <Repeat className="h-3 w-3" aria-label="Recorrente" />}
                            {xUsed && t.org_name && <span className="truncate rounded border border-[var(--color-border-soft)] px-1 text-[10px] font-semibold uppercase">{t.org_name}</span>}
                          </div>
                        </div>
                        {op && (!xUsed || t.org_id === orgId)
                          ? <Avatar src={op.avatar_url} name={operatorLabel(op)} size="sm" className="!h-7 !w-7" />
                          : xUsed && t.assigned_to && t.assigned_name ? <span title={t.assigned_name}><Avatar name={t.assigned_name} size="sm" className="!h-7 !w-7" /></span> : null}
                      </div>
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
        <TaskFormDialog companies={multi ? companies : undefined} onClose={() => setFormOpen(false)} onSaved={() => { setFormOpen(false); void load(); }} />
      )}
    </div>
  );
}
