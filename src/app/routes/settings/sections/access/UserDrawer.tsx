import { useMemo, useState } from 'react';
import { maskPhoneBR } from '@/lib/phone';
import { toast } from 'sonner';
import { Check, Minus, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Drawer, Field, inputCls } from './ui';
import { invokeManage, type AccessRole, type Member, type Override, type Permission, type Team } from './useAccessData';

type Effect = 'inherit' | 'allow' | 'deny';

// Cadastro (convite) e edição de usuário, com permissões individuais.
export function UserDrawer({ member, roles, teams, modules, rolePerms, overrides, onClose, onSaved }: {
  member: Member | null; // null = novo usuário
  roles: AccessRole[];
  teams: Team[];
  modules: { module: string; label: string; perms: Permission[] }[];
  rolePerms: Map<string, Set<string>>;
  overrides: Override[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const perms = usePermission();
  const { userId } = useAppUser();
  const creating = !member;
  const isSelf = member?.user_id === userId;
  const defaultRole = roles.find((r) => r.name === 'Atendimento') ?? roles.find((r) => !r.is_admin) ?? roles[0];

  const [name, setName] = useState(member?.display_name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(maskPhoneBR(member?.phone));
  const [job, setJob] = useState(member?.job_title ?? '');
  const [teamId, setTeamId] = useState(member?.team_id ?? '');
  const [roleId, setRoleId] = useState(member?.access_role_id ?? defaultRole?.id ?? '');
  const [mustChange, setMustChange] = useState(member?.must_change_password ?? false);
  const [saving, setSaving] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);

  const initialOv = useMemo(() => {
    const m = new Map<string, Effect>();
    if (member) for (const o of overrides) if (o.user_id === member.user_id) m.set(o.permission_key, o.effect);
    return m;
  }, [overrides, member]);
  const [ov, setOv] = useState<Map<string, Effect>>(initialOv);

  const role = roles.find((r) => r.id === roleId);
  const base = role?.is_admin ? null : (rolePerms.get(roleId) ?? new Set<string>());
  const canPickRole = creating ? perms.can('users.create') : perms.can('users.change_role') && !isSelf && !member?.is_super_admin;
  const canEditOverrides = perms.isAdmin && !creating && !isSelf && !role?.is_admin;
  const canEditInfo = creating || perms.can('users.edit');
  const ovChanged = useMemo(() => {
    if (ov.size !== initialOv.size) return true;
    for (const [k, v] of ov) if (initialOv.get(k) !== v) return true;
    return false;
  }, [ov, initialOv]);
  const ovCount = { allow: [...ov.values()].filter((v) => v === 'allow').length, deny: [...ov.values()].filter((v) => v === 'deny').length };

  const setEffect = (key: string, e: Effect) => setOv((cur) => {
    const next = new Map(cur);
    if (e === 'inherit') next.delete(key); else next.set(key, e);
    return next;
  });

  const save = async () => {
    if (creating) {
      if (!email.trim()) { toast.error('Informe o e-mail.'); return; }
      if (!roleId) { toast.error('Escolha o perfil de acesso.'); return; }
      setSaving(true);
      const err = await invokeManage({
        action: 'invite', email: email.trim(), display_name: name, phone, job_title: job,
        team_id: teamId || null, access_role_id: roleId, must_change_password: mustChange,
      });
      setSaving(false);
      if (err) { toast.error('Não foi possível criar o usuário', { description: err }); return; }
      toast.success('Usuário criado. O convite foi enviado por e-mail.');
      onSaved();
      return;
    }

    setSaving(true);
    const patch: Record<string, unknown> = {};
    if (canEditInfo) {
      if ((member.display_name ?? '') !== name.trim()) patch.display_name = name.trim() || null;
      if (maskPhoneBR(member.phone) !== phone.trim()) patch.phone = phone.trim() || null;
      if ((member.job_title ?? '') !== job.trim()) patch.job_title = job.trim() || null;
      if ((member.team_id ?? '') !== teamId) patch.team_id = teamId || null;
      if (member.must_change_password !== mustChange && !isSelf) patch.must_change_password = mustChange;
    }
    if (canPickRole && member.access_role_id !== roleId && roleId) patch.access_role_id = roleId;

    const sb = getSupabase();
    if (Object.keys(patch).length) {
      const { error } = await sb.from('app_users').update(patch).eq('user_id', member.user_id);
      if (error) { setSaving(false); toast.error('Não foi possível salvar', { description: error.message }); return; }
    }
    if (canEditOverrides && ovChanged) {
      const allow = [...ov].filter(([, v]) => v === 'allow').map(([k]) => k);
      const deny = [...ov].filter(([, v]) => v === 'deny').map(([k]) => k);
      const { error } = await sb.rpc('set_user_overrides', { p_user: member.user_id, p_allow: allow, p_deny: deny });
      if (error) { setSaving(false); toast.error('Não foi possível salvar as permissões individuais', { description: error.message }); return; }
    }
    setSaving(false);
    toast.success(patch.access_role_id ? 'Salvo. O novo perfil vale quando a pessoa entrar de novo (ou em até 1h).' : 'Usuário atualizado.');
    onSaved();
  };

  return (
    <Drawer
      open
      wide={showOverrides}
      title={creating ? 'Novo usuário' : `Editar ${member.display_name || member.email}`}
      subtitle={creating ? 'A pessoa recebe um convite por e-mail para criar a senha.' : member.email}
      onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Salvando…' : creating ? 'CRIAR USUÁRIO' : 'Salvar alterações'}</Button>
      </>}
    >
      <section className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Dados do usuário</h3>
        <Field label="Nome completo" htmlFor="u-name">
          <input id="u-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEditInfo} className={inputCls} placeholder="Ex.: Maria da Silva" />
        </Field>
        <Field label="E-mail" htmlFor="u-email">
          <input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!creating} className={inputCls} placeholder="maria@amaipark.com" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Telefone" htmlFor="u-phone">
            <input id="u-phone" value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} inputMode="tel" maxLength={15} disabled={!canEditInfo} className={inputCls} placeholder="(68) 99999-0000" />
          </Field>
          <Field label="Cargo" htmlFor="u-job">
            <input id="u-job" value={job} onChange={(e) => setJob(e.target.value)} disabled={!canEditInfo} className={inputCls} placeholder="Ex.: Atendente" />
          </Field>
        </div>
        <Field label="Equipe / setor" htmlFor="u-team">
          <select id="u-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!canEditInfo} className={inputCls}>
            <option value="">Sem equipe</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </section>

      <section className="mt-6 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Acesso</h3>
        <Field label="Perfil de acesso" htmlFor="u-role"
          hint={isSelf ? 'Você não pode alterar o próprio perfil.' : member?.is_super_admin ? 'Super admin: acesso protegido.' : undefined}>
          <select id="u-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={!canPickRole} className={inputCls}>
            {roles.filter((r) => !r.is_admin || perms.isAdmin || r.id === member?.access_role_id).map((r) => (
              <option key={r.id} value={r.id}>{r.name}{r.is_admin ? ' — acesso total' : ''}</option>
            ))}
          </select>
        </Field>
        {role?.is_admin && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-accent-subtle)] px-3 py-2 text-sm text-[var(--accent-primary)]">
            <ShieldCheck className="h-4 w-4" /> Administrador: acesso total, não depende da matriz de permissões.
          </div>
        )}
        {!isSelf && (
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} disabled={!canEditInfo} className="h-4 w-4 accent-[var(--accent-fill)]" />
            Exigir alteração de senha no próximo acesso
          </label>
        )}
        {creating && (
          <p className="text-xs text-[var(--color-text-muted)]">O convite por e-mail é enviado automaticamente ao criar.</p>
        )}
      </section>

      {canEditOverrides && (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Permissões individuais</h3>
            <button type="button" onClick={() => setShowOverrides((v) => !v)} className="text-sm font-medium text-[var(--accent-primary)] hover:underline">
              {showOverrides ? 'Esconder' : `Ajustar (${ovCount.allow} liberadas, ${ovCount.deny} bloqueadas)`}
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Permissão final = perfil <b>{role?.name}</b> + liberadas − bloqueadas. Só para esta pessoa.
          </p>
          {showOverrides && base && (
            <div className="mt-3 space-y-3">
              {modules.map((g) => (
                <div key={g.module} className="rounded-lg border border-[var(--color-border-soft)]">
                  <div className="border-b border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 py-1.5 text-sm font-semibold text-[var(--color-text-primary)]">{g.label}</div>
                  <ul className="divide-y divide-[var(--color-border-soft)]">
                    {g.perms.map((p) => {
                      const inRole = base.has(p.key);
                      const eff = ov.get(p.key) ?? 'inherit';
                      const finalOn = eff === 'allow' || (eff === 'inherit' && inRole);
                      return (
                        <li key={p.key} className="flex items-center gap-3 px-3 py-1.5">
                          <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', finalOn ? 'bg-[var(--color-success)] text-white' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]')}>
                            {finalOn ? <Check className="h-3 w-3" strokeWidth={3} /> : <Minus className="h-3 w-3" />}
                          </span>
                          <span className="min-w-0 flex-1 text-sm text-[var(--color-text-primary)]">
                            {p.label}
                            <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{inRole ? '(no perfil)' : ''}</span>
                          </span>
                          <div className="flex overflow-hidden rounded-md border border-[var(--color-border-card)] text-[11px] font-semibold">
                            {([['inherit', 'Padrão'], ['allow', 'Liberar'], ['deny', 'Bloquear']] as [Effect, string][]).map(([v, l]) => (
                              <button key={v} type="button" onClick={() => setEffect(p.key, v)} aria-pressed={eff === v}
                                className={cn('px-2 py-1 transition-colors',
                                  eff === v
                                    ? v === 'allow' ? 'bg-[var(--color-success)] text-white' : v === 'deny' ? 'bg-[var(--color-error)] text-white' : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
                                {l}
                              </button>
                            ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {ov.size > 0 && (
                <button type="button" onClick={() => setOv(new Map())} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-error)]">
                  <X className="h-3.5 w-3.5" /> Voltar tudo ao padrão do perfil
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </Drawer>
  );
}
