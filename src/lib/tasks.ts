import { getSupabase } from '@/lib/supabase';

// Recorrência de tarefas. Ao concluir uma tarefa recorrente, a próxima
// ocorrência é criada automaticamente (mesmo horário, próximo dia válido).
export type TaskRecurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export const RECURRENCE_LABELS: Record<TaskRecurrence, string> = {
  none: 'Não repete',
  daily: 'Diária',
  weekdays: 'Dias úteis',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

export function isRecurring(r: string | null | undefined): r is Exclude<TaskRecurrence, 'none'> {
  return r === 'daily' || r === 'weekdays' || r === 'weekly' || r === 'monthly';
}

// Próxima data a partir de `from` (mantém hora/minuto). Mensal no dia 31 cai
// no último dia do mês seguinte.
export function nextOccurrence(from: Date, rec: Exclude<TaskRecurrence, 'none'>): Date {
  const d = new Date(from);
  if (rec === 'daily') d.setDate(d.getDate() + 1);
  else if (rec === 'weekly') d.setDate(d.getDate() + 7);
  else if (rec === 'weekdays') {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  } else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return d;
}

// Próxima ocorrência que caia depois de agora (pula as que ficaram para trás
// quando a tarefa foi concluída com atraso). Limite de segurança de 400 passos.
export function nextFutureOccurrence(dueISO: string, rec: Exclude<TaskRecurrence, 'none'>, now = new Date()): Date {
  let d = nextOccurrence(new Date(dueISO), rec);
  for (let i = 0; i < 400 && d.getTime() <= now.getTime(); i++) d = nextOccurrence(d, rec);
  return d;
}

// Marca/desmarca uma tarefa. Se concluída e recorrente, cria a próxima
// ocorrência (sem duplicar caso já exista uma pendente igual).
// Ponto único usado por Tarefas, Agenda, topo e painel do contato.
export async function setTaskDone(taskId: string, done: boolean): Promise<{ nextDue: string | null }> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('tasks')
    .update({ status: done ? 'done' : 'pending', completed_at: done ? new Date().toISOString() : null })
    .eq('id', taskId);
  if (error) throw new Error(error.message);
  if (!done) return { nextDue: null };

  // select('*') para não quebrar caso a coluna recurrence ainda não exista.
  const { data: t } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
  const row = t as Record<string, unknown> | null;
  if (!row || !isRecurring(row.recurrence as string) || !row.due_at) return { nextDue: null };

  const rec = row.recurrence as Exclude<TaskRecurrence, 'none'>;
  const next = nextFutureOccurrence(row.due_at as string, rec).toISOString();

  let dup = supabase
    .from('tasks')
    .select('id')
    .eq('status', 'pending')
    .eq('title', row.title as string)
    .eq('due_at', next)
    .limit(1);
  dup = row.assigned_to ? dup.eq('assigned_to', row.assigned_to as string) : dup.is('assigned_to', null);
  const { data: existing } = await dup;
  if (existing && existing.length > 0) return { nextDue: next };

  const { error: insErr } = await supabase.from('tasks').insert({
    title: row.title,
    description: row.description ?? null,
    due_at: next,
    assigned_to: row.assigned_to ?? null,
    contact_id: row.contact_id ?? null,
    deal_id: row.deal_id ?? null,
    conversation_id: row.conversation_id ?? null,
    created_by: row.created_by ?? null,
    recurrence: rec,
  });
  if (insErr) throw new Error(`Tarefa concluída, mas a próxima repetição falhou: ${insErr.message}`);
  return { nextDue: next };
}

export function formatNextDue(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
