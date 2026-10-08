import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Copy, History, KeyRound, Link2, Mail, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2, UserCheck, UserPlus, UserX, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { maskPhoneBR } from '@/lib/phone';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { UserDrawer } from './UserDrawer';
import { ApproveSignupDialog, SignupLinkDialog } from './SignupLinks';
import { RoleEditor } from './RoleEditor';
import { formatWhen, inputCls, StatusPill } from './ui';
import { invokeManage, memberLabel, MODULE_LABELS, useAccessData, type AccessRole, type Member } from './useAccessData';

type Tab = 'users' | 'roles' | 'teams' | 'audit';

// Configurações → Usuários e acessos.
export function AccessSettings({ initialTab = 'users' }: { initialTab?: 'users' | 'roles' | 'teams' | 'audit' } = {}) {
  const perms = usePermission();
  const data = useAccessData();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [editingRole, setEditingRole] = useState<AccessRole | 'new' | null>(null);
  const [historyUser, setHistoryUser] = useState<Member | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const tabs: [Tab, string, boolean][] = [
    ['users', 'Usuários', true],
    ['roles', 'Perfis de acesso', true],
    ['teams', 'Equipes', true],
    ['audit', 'Auditoria', perms.can('audit.view')],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Usuários e acessos</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">Gerencie sua equipe, perfis e permissões.</p>
        </div>
        {tab === 'users' && perms.can('users.create') && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setLinkOpen(true)}><Link2 className="h-4 w-4" /> Link de cadastro</Button>
            <Button onClick={() => setEditing('new')}><UserPlus className="h-4 w-4" /> Novo usuário</Button>
          </div>
        )}
        {tab === 'roles' && perms.isAdmin && (
          <Button onClick={() => setEditingRole('new')}><Plus className="h-4 w-4" /> Novo perfil</Button>
        )}
      </div>

      <div className="flex gap-1 border-b border-[var(--color-border-card)]" role="tablist">
        {tabs.filter(([, , show]) => show).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); if (id !== 'audit') setHistoryUser(null); }}
            className={cn('-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors',
              tab === id ? 'border-[var(--accent-fill)] text-[var(--accent-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
            {label}
          </button>
        ))}
      </div>

      {data.error ? (
        <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-4 text-sm text-[var(--color-error)]">{data.error}</div>
      ) : data.loading ? (
        <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : tab === 'users' ? (
        <UsersTab data={data} onEdit={setEditing} onHistory={(m) => { setHistoryUser(m); setTab('audit'); }} />
      ) : tab === 'roles' ? (
        <RolesTab data={data} onEdit={setEditingRole} />
      ) : tab === 'teams' ? (
        <TeamsTab data={data} />
      ) : (
        <AuditTab members={data.members} user={historyUser} onClearUser={() => setHistoryUser(null)} />
      )}

      {editing && (
        <UserDrawer
          member={editing === 'new' ? null : editing}
          roles={data.roles}
          teams={data.teams}
          modules={data.modules}
          rolePerms={data.rolePerms}
          overrides={data.overrides}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void data.reload(); }}
        />
      )}
      {linkOpen && <SignupLinkDialog roles={data.roles} teams={data.teams} onClose={() => setLinkOpen(false)} />}
      {editingRole && (
        <RoleEditor
          role={editingRole === 'new' ? null : editingRole}
          modules={data.modules}
          rolePerms={data.rolePerms}
          onClose={() => setEditingRole(null)}
          onSaved={() => { setEditingRole(null); void data.reload(); }}
        />
      )}
    </div>
  );
}

type Data = ReturnType<typeof useAccessData>;

// ----------------------------------------------------------------- Usuários
function UsersTab({ data, onEdit, onHistory }: { data: Data; onEdit: (m: Member) => void; onHistory: (m: Member) => void }) {
  const perms = usePermission();
  const { userId } = useAppUser();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive' | 'pending' | 'approval'>('all');
  const [approving, setApproving] = useState<Member | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.members.filter((m) => {
      if (status === 'active' && (m.status !== 'active' || m.invite_pending)) return false;
      if (status === 'inactive' && (m.status === 'active' || m.status === 'pending')) return false;
      if (status === 'approval' && m.status !== 'pending') return false;
      if (status === 'pending' && !(m.invite_pending && m.status === 'active')) return false;
      if (!t) return true;
      return `${m.display_name ?? ''} ${m.email} ${m.job_title ?? ''} ${m.role_name ?? ''} ${m.team_name ?? ''}`.toLowerCase().includes(t);
    });
  }, [data.members, q, status]);

  const act = async (m: Member, action: 'deactivate' | 'reactivate' | 'reset_password' | 'resend_invite') => {
    setMenu(null);
    if (action === 'deactivate' && !window.confirm(`Desativar ${memberLabel(m)}? A pessoa perde o acesso na hora e não consegue mais entrar.`)) return;
    setBusy(m.user_id);
    const err = await invokeManage({ action, user_id: m.user_id });
    setBusy(null);
    if (err) { toast.error('Não foi possível concluir', { description: err }); return; }
    toast.success({
      deactivate: `${memberLabel(m)} foi desativado.`,
      reactivate: `${memberLabel(m)} foi reativado.`,
      reset_password: `E-mail para redefinir a senha enviado para ${m.email}.`,
      resend_invite: `Convite reenviado para ${m.email}.`,
    }[action]);
    void data.reload();
  };

  const reject = async (m: Member) => {
    if (!window.confirm(`Recusar o cadastro de ${memberLabel(m)}? A conta criada pelo link será apagada.`)) return;
    setBusy(m.user_id);
    const err = await invokeManage({ action: 'reject', user_id: m.user_id });
    setBusy(null);
    if (err) { toast.error('Não foi possível recusar', { description: err }); return; }
    toast.success(`Cadastro de ${memberLabel(m)} recusado.`);
    void data.reload();
  };

  const counts = {
    all: data.members.length,
    approval: data.members.filter((m) => m.status === 'pending').length,
    active: data.members.filter((m) => m.status === 'active' && !m.invite_pending).length,
    pending: data.members.filter((m) => m.status === 'active' && m.invite_pending).length,
    inactive: data.members.filter((m) => m.status !== 'active' && m.status !== 'pending').length,
  };

  return (
    <div className="space-y-3">
      {counts.approval > 0 && status !== 'approval' && perms.can('users.create') && (
        <button type="button" onClick={() => setStatus('approval')}
          className="flex w-full items-center gap-2 rounded-[var(--radius-card)] border border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] px-4 py-2.5 text-left text-sm font-medium text-[var(--color-text-primary)] hover:bg-[rgba(245,158,11,0.14)]">
          <span className="h-2 w-2 rounded-full bg-[#F59E0B]" />
          {counts.approval === 1 ? '1 cadastro aguardando aprovação' : `${counts.approval} cadastros aguardando aprovação`}
          <span className="ml-auto text-xs font-semibold text-[var(--accent-primary)]">Ver e aprovar</span>
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, e-mail, cargo ou perfil" aria-label="Buscar usuário" className={cn(inputCls, 'pl-9')} />
        </label>
        <div className="flex gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1">
          {([['all', 'Todos'], ['active', 'Ativos'], ['approval', 'Aguardando aprovação'], ['pending', 'Convite pendente'], ['inactive', 'Inativos']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setStatus(k)}
              className={cn('rounded-[8px] px-3 py-1.5 text-xs font-semibold', status === k ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
              {l} <span className="opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-card)] text-left text-xs font-semibold text-[var(--color-text-muted)]">
              <th className="px-4 py-3">Nome</th>
              <th className="px-3 py-3">Cargo</th>
              <th className="px-3 py-3">Equipe</th>
              <th className="px-3 py-3">Perfil de acesso</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Último acesso</th>
              <th className="px-3 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--color-text-muted)]">Nenhum usuário encontrado.</td></tr>
            )}
            {list.map((m) => {
              const me = m.user_id === userId;
              const canManage = !me && (!m.is_super_admin || false);
              return (
                <tr key={m.user_id} className={cn('border-b border-[var(--color-border-soft)] last:border-0', m.status !== 'active' && m.status !== 'pending' && 'opacity-60')}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar src={m.avatar_url} name={memberLabel(m)} size="sm" className="!h-9 !w-9" />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-[var(--color-text-primary)]">
                          {memberLabel(m)} {me && <span className="text-xs font-normal text-[var(--color-text-muted)]">(você)</span>}
                        </div>
                        <div className="truncate text-xs text-[var(--color-text-secondary)]">{m.email}</div>
                        {m.phone && <div className="truncate text-xs text-[var(--color-text-muted)]">{maskPhoneBR(m.phone)}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-[var(--color-text-secondary)]">{m.job_title || '—'}</td>
                  <td className="px-3 py-3 text-[var(--color-text-secondary)]">{m.team_name || '—'}</td>
                  <td className="px-3 py-3">
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                      m.role_is_admin ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-primary)]')}>
                      {m.role_is_admin && <ShieldCheck className="h-3 w-3" />}
                      {m.is_super_admin ? 'Super Admin' : m.role_name ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-3"><StatusPill m={m} /></td>
                  <td className="px-3 py-3 text-xs text-[var(--color-text-secondary)]">{formatWhen(m.last_sign_in_at)}</td>
                  <td className="px-3 py-3">
                    {m.status === 'pending' ? (
                      <div className="flex justify-end gap-1">
                        {perms.can('users.create') ? (
                          <>
                            <Button size="sm" onClick={() => setApproving(m)} disabled={busy === m.user_id}><UserCheck className="h-3.5 w-3.5" /> Aprovar</Button>
                            <Button size="sm" variant="outline" onClick={() => void reject(m)} disabled={busy === m.user_id} className="text-[var(--color-error)]"><UserX className="h-3.5 w-3.5" /> Recusar</Button>
                          </>
                        ) : <span className="text-xs text-[var(--color-text-muted)]">Aguardando</span>}
                      </div>
                    ) : (
                    <div className="relative flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => onEdit(m)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
                      <button type="button" onClick={() => setMenu(menu === m.user_id ? null : m.user_id)} disabled={busy === m.user_id}
                        aria-label="Mais ações" className="rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menu === m.user_id && (
                        <>
                          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setMenu(null)} />
                          <div className="absolute right-0 top-[calc(100%+4px)] z-[calc(var(--z-dropdown)+1)] w-56 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
                            <MenuItem icon={Pencil} label="Editar / alterar perfil" onClick={() => { setMenu(null); onEdit(m); }} />
                            {perms.isAdmin && !me && !m.role_is_admin && <MenuItem icon={KeyRound} label="Alterar permissões" onClick={() => { setMenu(null); onEdit(m); }} />}
                            {canManage && m.invite_pending && m.status === 'active' && perms.can('users.create') &&
                              <MenuItem icon={Mail} label="Reenviar convite" onClick={() => void act(m, 'resend_invite')} />}
                            {canManage && !m.invite_pending && perms.can('users.reset_password') &&
                              <MenuItem icon={KeyRound} label="Resetar senha" onClick={() => void act(m, 'reset_password')} />}
                            {canManage && perms.can('users.deactivate') && (m.status === 'active'
                              ? <MenuItem icon={UserX} label="Desativar" danger onClick={() => void act(m, 'deactivate')} />
                              : <MenuItem icon={UserCheck} label="Reativar" onClick={() => void act(m, 'reactivate')} />)}
                            {perms.can('audit.view') && <MenuItem icon={History} label="Ver histórico" onClick={() => { setMenu(null); onHistory(m); }} />}
                          </div>
                        </>
                      )}
                    </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {approving && (
        <ApproveSignupDialog
          member={approving}
          roles={data.roles}
          teams={data.teams}
          canGrantAdmin={perms.isAdmin}
          onClose={() => setApproving(null)}
          onDone={() => { setApproving(null); void data.reload(); }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)]',
        danger ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]')}>
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

// ----------------------------------------------------------- Perfis de acesso
function roleSummary(role: AccessRole, perms: Set<string> | undefined): string {
  if (role.is_admin) return 'Acesso total';
  if (!perms || perms.size === 0) return 'Sem acesso';
  const mods = new Set<string>();
  for (const k of perms) if (k.endsWith('.view')) mods.add(k.split('.')[0]);
  const names = [...mods].map((m) => MODULE_LABELS[m] ?? m).filter(Boolean);
  return names.length ? names.slice(0, 4).join(' + ') + (names.length > 4 ? ` + ${names.length - 4}` : '') : `${perms.size} permissões`;
}

function RolesTab({ data, onEdit }: { data: Data; onEdit: (r: AccessRole) => void }) {
  const perms = usePermission();

  const duplicate = async (r: AccessRole) => {
    const name = window.prompt('Nome do novo perfil:', `${r.name} (cópia)`);
    if (!name?.trim()) return;
    const { error } = await getSupabase().rpc('duplicate_access_role', { p_id: r.id, p_name: name.trim() });
    if (error) { toast.error('Não foi possível duplicar', { description: error.message }); return; }
    toast.success('Perfil duplicado.');
    void data.reload();
  };

  const remove = async (r: AccessRole) => {
    if (!window.confirm(`Excluir o perfil "${r.name}"?`)) return;
    const { error } = await getSupabase().rpc('delete_access_role', { p_id: r.id });
    if (error) { toast.error('Não foi possível excluir', { description: error.message }); return; }
    toast.success('Perfil excluído.');
    void data.reload();
  };

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {data.roles.map((r) => {
        const count = data.usersByRole.get(r.id) ?? 0;
        return (
          <div key={r.id} className="flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-base font-bold text-[var(--color-text-primary)]">
                  {r.is_admin && <ShieldCheck className="h-4 w-4 text-[var(--accent-primary)]" />}
                  {r.name}
                </div>
                <div className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{roleSummary(r, data.rolePerms.get(r.id))}</div>
              </div>
              {r.is_system && <span className="shrink-0 rounded-full bg-[var(--color-fill-subtle)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">padrão</span>}
            </div>
            {r.description && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{r.description}</p>}
            <div className="mt-3 flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]">
              <Users className="h-4 w-4" /> {count} {count === 1 ? 'usuário' : 'usuários'}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border-soft)] pt-3">
              <Button size="sm" variant="outline" onClick={() => onEdit(r)}><Pencil className="h-3.5 w-3.5" /> {perms.isAdmin && !r.is_admin ? 'Editar' : 'Ver'}</Button>
              {perms.isAdmin && <Button size="sm" variant="outline" onClick={() => void duplicate(r)}><Copy className="h-3.5 w-3.5" /> Duplicar</Button>}
              {perms.isAdmin && !r.is_system && (
                <Button size="sm" variant="ghost" onClick={() => void remove(r)} disabled={count > 0} title={count > 0 ? 'Perfil em uso: troque o perfil dos usuários antes' : undefined}>
                  <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" /> Excluir
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ Equipes
function TeamsTab({ data }: { data: Data }) {
  const perms = usePermission();
  const canEdit = perms.can('users.edit');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const sb = getSupabase();

  const add = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const { error } = await sb.from('teams').insert({ name: name.trim() });
    setSaving(false);
    if (error) { toast.error('Não foi possível criar a equipe', { description: /duplicate|unique/i.test(error.message) ? 'Já existe uma equipe com esse nome.' : error.message }); return; }
    setName('');
    void data.reload();
  };

  const rename = async (id: string, current: string) => {
    const next = window.prompt('Novo nome da equipe:', current);
    if (!next?.trim() || next.trim() === current) return;
    const { error } = await sb.from('teams').update({ name: next.trim() }).eq('id', id);
    if (error) { toast.error('Não foi possível renomear', { description: error.message }); return; }
    void data.reload();
  };

  const setManager = async (id: string, manager: string) => {
    const { error } = await sb.from('teams').update({ manager_user_id: manager || null }).eq('id', id);
    if (error) { toast.error('Não foi possível salvar o gestor', { description: error.message }); return; }
    void data.reload();
  };

  const remove = async (id: string, n: string) => {
    if (!window.confirm(`Excluir a equipe "${n}"? Os membros ficam sem equipe.`)) return;
    const { error } = await sb.from('teams').delete().eq('id', id);
    if (error) { toast.error('Não foi possível excluir', { description: error.message }); return; }
    void data.reload();
  };

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
            placeholder="Nova equipe (ex.: Bilheteria, Comercial, Bar)" className={cn(inputCls, 'max-w-md')} aria-label="Nome da nova equipe" />
          <Button onClick={() => void add()} disabled={saving || !name.trim()}><Plus className="h-4 w-4" /> Criar equipe</Button>
        </div>
      )}
      {data.teams.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Nenhuma equipe ainda. Equipes servem para o escopo “Próprios + equipe” e para organizar a lista de usuários.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.teams.map((t) => {
            const members = data.members.filter((m) => m.team_id === t.id);
            return (
              <div key={t.id} className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-base font-bold text-[var(--color-text-primary)]">{t.name}</div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <button type="button" onClick={() => void rename(t.id, t.name)} aria-label="Renomear equipe" className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--accent-primary)]"><Pencil className="h-4 w-4" /></button>
                      <button type="button" onClick={() => void remove(t.id, t.name)} aria-label="Excluir equipe" className="rounded p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-error)]"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>
                <label className="mt-3 block text-xs font-semibold text-[var(--color-text-secondary)]">Gestor</label>
                <select value={t.manager_user_id ?? ''} onChange={(e) => void setManager(t.id, e.target.value)} disabled={!canEdit} className={cn(inputCls, 'mt-1')}>
                  <option value="">Sem gestor</option>
                  {data.members.filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
                </select>
                <div className="mt-3 text-xs font-semibold text-[var(--color-text-secondary)]">{members.length} {members.length === 1 ? 'membro' : 'membros'}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {members.map((m) => (
                    <span key={m.user_id} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-fill-subtle)] py-0.5 pl-0.5 pr-2.5 text-xs text-[var(--color-text-primary)]">
                      <Avatar src={m.avatar_url} name={memberLabel(m)} size="sm" className="!h-5 !w-5 !text-[9px]" /> {memberLabel(m)}
                    </span>
                  ))}
                  {members.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">Defina a equipe no cadastro do usuário (Editar).</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Auditoria
interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  summary: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'user.created': 'Usuário criado',
  'user.invited': 'Convite enviado',
  'user.invite_resent': 'Convite reenviado',
  'user.updated': 'Dados alterados',
  'user.role_changed': 'Perfil alterado',
  'user.permissions_changed': 'Permissões individuais',
  'user.deactivated': 'Usuário desativado',
  'user.reactivated': 'Usuário reativado',
  'user.blocked': 'Usuário bloqueado',
  'user.removed': 'Usuário removido',
  'user.password_reset': 'Reset de senha',
  'auth.password_changed': 'Senha trocada',
  'role.created': 'Perfil criado',
  'role.updated': 'Perfil alterado',
  'role.permissions_changed': 'Permissões do perfil',
  'role.deleted': 'Perfil excluído',
  'team.created': 'Equipe criada',
  'team.updated': 'Equipe alterada',
  'team.deleted': 'Equipe excluída',
};

function AuditTab({ members, user, onClearUser }: { members: Member[]; user: Member | null; onClearUser: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<'all' | 'auth' | 'user' | 'role' | 'team'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    let q = getSupabase()
      .from('access_audit_log')
      .select('id, actor_id, action, summary, target_user_id, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (user) q = q.or(`target_user_id.eq.${user.user_id},actor_id.eq.${user.user_id}`);
    if (kind !== 'all') q = q.like('action', `${kind}.%`);
    const { data, error } = await q;
    if (error) toast.error('Não foi possível carregar a auditoria', { description: error.message });
    setRows((data ?? []) as AuditRow[]);
    setLoading(false);
  }, [user, kind]);

  useEffect(() => { void load(); }, [load]);

  const nameOf = (id: string | null) => (id ? memberLabel(members.find((m) => m.user_id === id)) : 'Sistema');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1">
          {([['all', 'Tudo'], ['auth', 'Login/Logout'], ['user', 'Usuários'], ['role', 'Perfis'], ['team', 'Equipes']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={cn('rounded-[8px] px-3 py-1.5 text-xs font-semibold', kind === k ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
              {l}
            </button>
          ))}
        </div>
        {user && (
          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--color-accent-subtle)] px-3 py-1 text-xs font-semibold text-[var(--accent-primary)]">
            Histórico de {memberLabel(user)}
            <button type="button" onClick={onClearUser} className="underline">limpar</button>
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-card)] text-left text-xs font-semibold text-[var(--color-text-muted)]">
              <th className="px-4 py-3">Data/hora</th>
              <th className="px-3 py-3">Usuário</th>
              <th className="px-3 py-3">Ação</th>
              <th className="px-3 py-3">Alvo</th>
              <th className="px-3 py-3">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6"><Skeleton className="h-8" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--color-text-muted)]">Nada registrado ainda.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--color-border-soft)] last:border-0 align-top">
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[var(--color-text-secondary)]">
                  {new Date(r.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-3 py-2.5 font-medium text-[var(--color-text-primary)]">{nameOf(r.actor_id)}</td>
                <td className="px-3 py-2.5">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold',
                    /deactivated|deleted|removed|blocked/.test(r.action) ? 'bg-[rgba(239,68,68,0.1)] text-[var(--color-error)]' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-primary)]')}>
                    {ACTION_LABELS[r.action] ?? r.action}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-[var(--color-text-secondary)]">{r.target_user_id ? nameOf(r.target_user_id) : '—'}</td>
                <td className="px-3 py-2.5 text-[var(--color-text-secondary)]">
                  {r.summary}
                  {(typeof r.metadata?.device === 'string' || typeof r.metadata?.ip === 'string') && (
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {[r.metadata.device, r.metadata.ip ? `IP ${String(r.metadata.ip)}` : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
