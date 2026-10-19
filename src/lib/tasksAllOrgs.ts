import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { loadMyOrgs, type MyOrg } from '@/lib/orgMembers';
import { isRecurring, nextFutureOccurrence } from '@/lib/tasks';
import type { Task } from '@/hooks/useTasks';

// Tarefas de TODAS as empresas numa tela só (20261019120000_tasks_all_orgs.sql).
// Cada tarefa continua na empresa dela (org_id); as funções do banco conferem as permissões de CADA empresa.
// Sem o SQL no banco, fetchAllOrgTasks devolve null e a tela segue só com a empresa em uso.

export interface XTask extends Task {
  org_id: string;
  org_name: string;
  assigned_name: string | null;
  can_edit: boolean;
  can_complete: boolean;
  can_delete: boolean;
}

export type CompanyScope = 'current' | 'all';
const SCOPE_KEY = 'megacrm_tasks_company_scope';

export function readCompanyScope(): CompanyScope {
  try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'current'; } catch { return 'current'; }
}
export function saveCompanyScope(v: CompanyScope) {
  try { localStorage.setItem(SCOPE_KEY, v); } catch { /* sem storage */ }
}

const db = () => getSupabase().schema('whatsapp_hub');
const missingFn = (msg: string) => /tasks_all_orgs|task_xorg|schema cache|could not find the function/i.test(msg);

let orgsCache: Promise<MyOrg[]> | null = null;

// Empresas que o usuário pode juntar (as dele + a que está em uso). Só faz sentido mostrar a opção com 2+.
export function useTaskCompanies(): { companies: { id: string; name: string }[]; multi: boolean } {
  const { orgId, orgName } = useAppUser();
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  useEffect(() => {
    let alive = true;
    if (!orgsCache) orgsCache = loadMyOrgs();
    void orgsCache.then((o) => { if (alive) setOrgs(o); });
    return () => { alive = false; };
  }, []);
  const map = new Map<string, string>(orgs.map((o) => [o.id, o.name]));
  if (orgId && !map.has(orgId)) map.set(orgId, orgName ?? 'Empresa atual');
  const companies = [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { companies, multi: companies.length > 1 };
}

export async function fetchAllOrgTasks(from?: string, to?: string): Promise<XTask[] | null> {
  const { data, error } = await db().rpc('tasks_all_orgs', { p_from: from ?? null, p_to: to ?? null });
  if (error) {
    if (missingFn(error.message)) return null;
    throw new Error(error.message);
  }
  return (data ?? []) as XTask[];
}

// Concluir/reabrir tarefa de qualquer empresa. A próxima repetição é calculada aqui (mesma regra do resto do
// sistema) e criada pelo banco na MESMA empresa da tarefa.
export async function setTaskDoneAnyOrg(t: Pick<Task, 'id' | 'due_at' | 'recurrence'>, done: boolean): Promise<{ nextDue: string | null }> {
  const next = done && isRecurring(t.recurrence) && t.due_at ? nextFutureOccurrence(t.due_at, t.recurrence).toISOString() : null;
  const { error } = await db().rpc('task_xorg_set_done', { p_task: t.id, p_done: done, p_next_due: next });
  if (error) throw new Error(error.message);
  return { nextDue: next };
}

export interface XTaskInput {
  title: string;
  description: string | null;
  due_at: string | null;
  assigned_to: string | null;
  recurrence: string;
}

export async function saveTaskAnyOrg(id: string | null, orgId: string, input: XTaskInput): Promise<string> {
  const { data, error } = await db().rpc('task_xorg_save', { p_id: id, p_org: orgId, p: input });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function loadOrgMembers(orgId: string): Promise<{ user_id: string; name: string }[]> {
  const { data, error } = await db().rpc('task_xorg_members', { p_org: orgId });
  if (error) return [];
  return (data ?? []) as { user_id: string; name: string }[];
}
