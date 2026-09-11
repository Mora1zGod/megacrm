import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

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
    setLoading(true);
    setError(null);
    const { data, error: err } = await getSupabase()
      .from('tasks')
      .select('*')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (err) setError(err.message);
    else setTasks((data ?? []) as Task[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

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
    const { error: err } = await getSupabase()
      .from('tasks')
      .update({ status: done ? 'done' : 'pending', completed_at: done ? new Date().toISOString() : null })
      .eq('id', task.id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const deleteTask = useCallback(async (id: string) => {
    const { error: err } = await getSupabase().from('tasks').delete().eq('id', id);
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const pendingCount = tasks.filter((t) => t.status === 'pending').length;

  return { tasks, loading, error, reload: load, createTask, toggleTask, deleteTask, pendingCount };
}
