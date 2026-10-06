import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  job_title: string | null;
  team_id: string | null;
  team_name: string | null;
  access_role_id: string | null;
  role_name: string | null;
  role_is_admin: boolean;
  status: 'active' | 'inactive' | 'blocked';
  is_super_admin: boolean;
  must_change_password: boolean;
  invite_pending: boolean;
  last_sign_in_at: string | null;
  created_at: string | null;
}

export interface AccessRole {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  is_admin: boolean;
  scopes: Record<string, 'own' | 'team' | 'all'>;
}

export interface Permission {
  key: string;
  module: string;
  action: string;
  label: string;
  sort: number;
}

export interface Team {
  id: string;
  name: string;
  manager_user_id: string | null;
}

export interface Override {
  user_id: string;
  permission_key: string;
  effect: 'allow' | 'deny';
}

// Nomes dos módulos na matriz (ordem = ordem do catálogo).
export const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Visão geral',
  inbox: 'Atendimento',
  contacts: 'Contatos',
  deals: 'Leads / Funil',
  visits: 'Agenda / Agendamentos',
  tasks: 'Tarefas',
  reminders: 'Lembretes',
  campaigns: 'Campanhas',
  automations: 'Automações',
  files: 'Arquivos',
  chat: 'Chat da equipe',
  boards: 'Quadros',
  financial: 'Financeiro',
  reports: 'Relatórios',
  users: 'Equipe e usuários',
  settings: 'Configurações',
};

export const SCOPE_MODULES: { key: 'inbox' | 'deals' | 'tasks' | 'visits'; label: string }[] = [
  { key: 'inbox', label: 'Conversas' },
  { key: 'deals', label: 'Leads' },
  { key: 'tasks', label: 'Tarefas' },
  { key: 'visits', label: 'Agendamentos' },
];

export const SCOPE_LABELS: Record<'own' | 'team' | 'all', string> = {
  own: 'Somente próprios',
  team: 'Próprios + equipe',
  all: 'Todos',
};

export function memberLabel(m: Pick<Member, 'display_name' | 'email'> | undefined | null): string {
  if (!m) return '—';
  return m.display_name?.trim() || m.email.split('@')[0];
}

// Dados da tela "Usuários e acessos" (todos via RLS / RPCs do banco).
export function useAccessData() {
  const { orgId } = useAppUser();
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rolePerms, setRolePerms] = useState<Map<string, Set<string>>>(new Map());
  const [teams, setTeams] = useState<Team[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    const sb = getSupabase();
    const [mQ, rQ, pQ, rpQ, tQ, oQ] = await Promise.all([
      sb.rpc('list_members'),
      sb.from('access_roles').select('id, name, description, is_system, is_admin, scopes').order('is_system', { ascending: false }).order('name'),
      sb.from('permissions').select('key, module, action, label, sort').order('sort'),
      sb.from('role_permissions').select('role_id, permission_key'),
      sb.from('teams').select('id, name, manager_user_id').order('name'),
      sb.from('user_permission_overrides').select('user_id, permission_key, effect'),
    ]);
    const firstErr = mQ.error ?? rQ.error ?? pQ.error;
    if (firstErr) {
      setError(/list_members|access_roles|permissions/.test(firstErr.message)
        ? 'O banco ainda não tem a gestão de acessos. Rode o SQL da etapa 3 no Supabase.'
        : firstErr.message);
      setLoading(false);
      return;
    }
    setError(null);
    setMembers((mQ.data ?? []) as Member[]);
    setRoles((rQ.data ?? []) as AccessRole[]);
    setPermissions((pQ.data ?? []) as Permission[]);
    const map = new Map<string, Set<string>>();
    for (const r of (rpQ.data ?? []) as { role_id: string; permission_key: string }[]) {
      if (!map.has(r.role_id)) map.set(r.role_id, new Set());
      map.get(r.role_id)!.add(r.permission_key);
    }
    setRolePerms(map);
    setTeams((tQ.data ?? []) as Team[]);
    setOverrides((oQ.data ?? []) as Override[]);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!orgId) return;
    const sb = getSupabase();
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 250); };
    const ch = sb
      .channel(`access-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'access_roles' }, bump)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'role_permissions' }, bump)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'user_permission_overrides' }, bump)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'app_users' }, bump)
      .subscribe();
    return () => { if (t) clearTimeout(t); void sb.removeChannel(ch); };
  }, [orgId, load]);

  const modules = useMemo(() => {
    const out: { module: string; label: string; perms: Permission[] }[] = [];
    for (const p of permissions) {
      let g = out.find((x) => x.module === p.module);
      if (!g) { g = { module: p.module, label: MODULE_LABELS[p.module] ?? p.module, perms: [] }; out.push(g); }
      g.perms.push(p);
    }
    return out;
  }, [permissions]);

  const usersByRole = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of members) if (u.access_role_id) m.set(u.access_role_id, (m.get(u.access_role_id) ?? 0) + 1);
    return m;
  }, [members]);

  return { members, roles, permissions, modules, rolePerms, teams, overrides, usersByRole, loading, error, reload: load };
}

// Erro de RPC/Edge Function → texto para o toast.
export async function invokeManage(body: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await getSupabase().functions.invoke('manage-team-member', {
    body: { ...body, app_url: window.location.origin },
  });
  if (data && data.ok === false) return String(data.error ?? 'Falha.');
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.json();
        if (j?.error) return String(j.error);
      } catch { /* ignore */ }
    }
    return /not found|404/i.test(error.message)
      ? 'A função manage-team-member ainda não foi publicada no Supabase.'
      : error.message;
  }
  return null;
}
