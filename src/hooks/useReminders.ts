import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export type ReminderColor = 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'gray';

export const REMINDER_COLORS: Record<ReminderColor, string> = {
  green: '#16A34A',
  blue: '#2563EB',
  purple: '#7C3AED',
  orange: '#EA580C',
  red: '#DC2626',
  gray: '#94A3B8',
};

export interface Reminder {
  id: string;
  created_by: string;
  title: string;
  notes: string | null;
  color: ReminderColor;
  due_at: string | null;
  shared: boolean;
  done: boolean;
  created_at: string;
}

// Lembretes visíveis para o usuário: os próprios + os compartilhados (RLS).
// range = só os com data no intervalo (Agenda); sem range = os em aberto (topo).
export function useReminders(range?: { fromISO: string; toISO: string }) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fromISO = range?.fromISO;
  const toISO = range?.toISO;

  const load = useCallback(async () => {
    let q = getSupabase()
      .from('reminders')
      .select('id, created_by, title, notes, color, due_at, shared, done, created_at');
    if (fromISO && toISO) q = q.gte('due_at', fromISO).lt('due_at', toISO);
    else q = q.eq('done', false);
    const { data, error: err } = await q.order('due_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(200);
    if (err) setError(err.message);
    else { setReminders((data ?? []) as Reminder[]); setError(null); }
    setLoading(false);
  }, [fromISO, toISO]);

  useEffect(() => {
    void load();
    const supabase = getSupabase();
    const ch = supabase
      .channel(`reminders-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'reminders' }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [load]);

  const create = useCallback(async (input: { title: string; notes?: string | null; color: ReminderColor; due_at?: string | null; shared: boolean }) => {
    const { error: err } = await getSupabase().from('reminders').insert({
      title: input.title.trim(),
      notes: input.notes?.trim() || null,
      color: input.color,
      due_at: input.due_at || null,
      shared: input.shared,
    });
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  const setDone = useCallback(async (id: string, done: boolean) => {
    setReminders((cur) => (fromISO ? cur.map((r) => (r.id === id ? { ...r, done } : r)) : cur.filter((r) => r.id !== id || !done)));
    const { error: err } = await getSupabase().from('reminders').update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', id);
    if (err) { await load(); throw new Error(err.message); }
  }, [fromISO, load]);

  const remove = useCallback(async (id: string) => {
    setReminders((cur) => cur.filter((r) => r.id !== id));
    const { error: err } = await getSupabase().from('reminders').delete().eq('id', id);
    if (err) { await load(); throw new Error(err.message); }
  }, [load]);

  return { reminders, loading, error, reload: load, create, setDone, remove };
}
