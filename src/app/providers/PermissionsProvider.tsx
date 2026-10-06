import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from './AppUserProvider';

// ----------------------------------------------------------------------------
// Permissões do usuário logado — espelho da camada do banco
// (whatsapp_hub.my_permissions(): perfil + exceções ALLOW − DENY).
// O banco continua sendo quem bloqueia de verdade (RLS / Edge Functions);
// aqui só decidimos o que mostrar (menu, rotas, botões).
// ----------------------------------------------------------------------------

export type Scope = 'own' | 'team' | 'all';
export type ScopeModule = 'inbox' | 'deals' | 'tasks' | 'visits';

interface PermissionsState {
  loading: boolean;
  isAdmin: boolean;       // acesso total (perfil Administrador / super admin)
  active: boolean;        // usuário ativo na org
  permissions: Set<string>;
  scopes: Record<ScopeModule, Scope>;
  roleName: string | null;
  teamId: string | null;
  mustChangePassword: boolean;
  // user_id → team_id dos membros da org (escopo "equipe").
  teamOf: Map<string, string | null>;
  // true quando o banco ainda não tem a camada nova (SQL da etapa 1 ausente).
  legacy: boolean;
}

interface PermissionsContextValue extends PermissionsState {
  can: (key: string) => boolean;
  canAny: (...keys: string[]) => boolean;
  canAll: (...keys: string[]) => boolean;
  scope: (module: ScopeModule) => Scope;
  // Conversa/lead/tarefa atribuída a `assignee` está no escopo do usuário?
  inScope: (module: ScopeModule, assignee: string | null | undefined) => boolean;
  reload: () => Promise<void>;
}

// Fallback (banco sem my_permissions): o que o operador fazia antes.
const LEGACY_OPERATOR = [
  'inbox.view', 'inbox.reply', 'inbox.start', 'inbox.transfer', 'inbox.close', 'inbox.archive', 'inbox.resume_ai',
  'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.delete', 'contacts.export',
  'deals.create', 'deals.edit', 'deals.move',
  'visits.view', 'visits.create', 'visits.edit', 'visits.cancel',
  'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.complete', 'tasks.delete', 'tasks.assign',
  'reminders.view', 'reminders.create', 'reminders.edit', 'reminders.delete', 'reminders.share',
  'campaigns.view', 'files.view', 'chat.view', 'boards.view', 'financial.create', 'settings.view',
];

const ALL_SCOPE: Record<ScopeModule, Scope> = { inbox: 'all', deals: 'all', tasks: 'all', visits: 'all' };

const EMPTY: PermissionsState = {
  loading: true,
  isAdmin: false,
  active: true,
  permissions: new Set(),
  scopes: ALL_SCOPE,
  roleName: null,
  teamId: null,
  mustChangePassword: false,
  teamOf: new Map(),
  legacy: false,
};

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

function asScope(v: unknown): Scope {
  return v === 'own' || v === 'team' ? v : 'all';
}

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { userId, orgId, role, isSuperAdmin, loading: userLoading } = useAppUser();
  const [state, setState] = useState<PermissionsState>(EMPTY);

  const load = useCallback(async () => {
    if (!userId || !orgId) {
      setState({ ...EMPTY, loading: userLoading });
      return;
    }
    const supabase = getSupabase();
    const [permsQ, membersQ] = await Promise.all([
      supabase.rpc('my_permissions'),
      supabase.from('app_users').select('*').eq('org_id', orgId),
    ]);

    const teamOf = new Map<string, string | null>();
    for (const m of (membersQ.data ?? []) as Array<{ user_id: string; team_id?: string | null }>) {
      teamOf.set(m.user_id, m.team_id ?? null);
    }

    if (permsQ.error || !permsQ.data || typeof permsQ.data !== 'object' || Array.isArray(permsQ.data)) {
      // Banco sem a etapa 1: comportamento antigo (admin vê tudo).
      const full = role === 'admin' || isSuperAdmin;
      setState({
        ...EMPTY,
        loading: false,
        isAdmin: full,
        permissions: new Set(full ? [] : LEGACY_OPERATOR),
        scopes: full ? ALL_SCOPE : { inbox: 'own', deals: 'all', tasks: 'all', visits: 'all' },
        teamOf,
        legacy: true,
      });
      return;
    }

    const d = permsQ.data as {
      is_admin?: boolean;
      active?: boolean;
      permissions?: string[];
      scopes?: Record<string, unknown>;
      role?: { id: string; name: string } | null;
      team_id?: string | null;
      must_change_password?: boolean;
    };
    setState({
      loading: false,
      isAdmin: Boolean(d.is_admin),
      active: d.active !== false,
      permissions: new Set(d.permissions ?? []),
      scopes: {
        inbox: asScope(d.scopes?.inbox),
        deals: asScope(d.scopes?.deals),
        tasks: asScope(d.scopes?.tasks),
        visits: asScope(d.scopes?.visits),
      },
      roleName: d.role?.name ?? null,
      teamId: d.team_id ?? null,
      mustChangePassword: Boolean(d.must_change_password),
      teamOf,
      legacy: false,
    });
  }, [userId, orgId, role, isSuperAdmin, userLoading]);

  useEffect(() => { void load(); }, [load]);

  // Admin mexeu no perfil/exceções/status: recarrega na hora.
  useEffect(() => {
    if (!userId || !orgId) return;
    const supabase = getSupabase();
    const ch = supabase
      .channel(`perms-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'role_permissions' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'access_roles' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'user_permission_overrides' }, () => void load())
      .subscribe();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { void supabase.removeChannel(ch); window.removeEventListener('focus', onFocus); };
  }, [userId, orgId, load]);

  const value = useMemo<PermissionsContextValue>(() => {
    const can = (key: string) => state.isAdmin || (state.active && state.permissions.has(key));
    const scope = (module: ScopeModule): Scope => (state.isAdmin ? 'all' : state.scopes[module]);
    return {
      ...state,
      can,
      canAny: (...keys) => keys.some(can),
      canAll: (...keys) => keys.every(can),
      scope,
      inScope: (module, assignee) => {
        const s = scope(module);
        if (s === 'all' || !assignee || assignee === userId) return true;
        if (s === 'team') {
          const mine = state.teamId;
          return Boolean(mine) && state.teamOf.get(assignee) === mine;
        }
        return false;
      },
      reload: load,
    };
  }, [state, userId, load]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermission(): PermissionsContextValue {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermission must be used inside <PermissionsProvider>');
  return ctx;
}
