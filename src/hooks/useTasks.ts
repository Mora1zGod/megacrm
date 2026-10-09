import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { setTaskDone } from '@/lib/tasks';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  assigned_to: string | null;
  status: 'pending' | 'done';
  contact_id: string | null;
  deal_id: string | null;
  conversation_id: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  recurrence?: string | null;
}

export interface NewTaskInput {
  title: string;
  description?: string | null;
  due_at?: string | null;
  assigned_to?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  conversation_id?: string | null;
}

export function useTasks() {
  const { userId } = useAppUser();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase()
      .from('tasks')
      .select('*')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    else { setTasks((data ?? []) as Task[]); setError(null); }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const supabase = getSupabase();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`tasks-page-${Math.random().toString(36).slice(2, 8)}`)
      // Várias mudanças seguidas (ex.: rotina que cria tarefas em lote) = 1 recarga.
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'tasks' }, () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void load(), 800); })
      .subscribe();
    return () => { if (timer) clearTimeout(timer); void supabase.removeChannel(ch); };
  }, [load]);

  const createTask = useCallback(async (input: NewTaskInput) => {
    const { error: err } = await getSupabase().from('tasks').insert({
      title: input.title,
      description: input.description ?? null,
      due_at: input.due_at ?? null,
      assigned_to: input.assigned_to ?? null,
      contact_id: input.contact_id ?? null,
      deal_id: input.deal_id ?? null,
      conversation_id: input.conversation_id ?? null,
      created_by: userId,
    });
    if (err) throw new Error(err.message);
    await load();
  }, [userId, load]);

  const toggleTask = useCallback(async (task: Task) => {
    const done = task.status !== 'done';
    try {
      return await setTaskDone(task.id, done);
    } finally {
      await load();
    }
  }, [load]);

  const deleteTask = useCallback(async (id: string) => {
    const { error: err } = await getSupabase().from('tasks').delete().eq('id', id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const pendingCount = tasks.filter((t) => t.status === 'pending').length;

  return { tasks, loading, error, reload: load, createTask, toggleTask, deleteTask, pendingCount };
}

// Só o número de tarefas pendentes (para o selo do menu). Antes o menu baixava TODAS as tarefas e
// rebaixava a cada mudança de qualquer pessoa — em toda tela do sistema.
export function usePendingTasksCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const supabase = getSupabase();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const load = async () => {
      const { count: c } = await supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'pending');
      if (alive) setCount(c ?? 0);
    };
    void load();
    const ch = supabase
      .channel(`tasks-badge-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'tasks' }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(), 1500); // várias mudanças seguidas = 1 consulta
      })
      .subscribe();
    return () => { alive = false; if (timer) clearTimeout(timer); void supabase.removeChannel(ch); };
  }, []);
  return count;
}
