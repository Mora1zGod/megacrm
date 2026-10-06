// ============================================================================
// manage-team-member
// ----------------------------------------------------------------------------
// Ações sensíveis da tela "Usuários e acessos", sempre validadas NO SERVIDOR
// pela camada de permissões (perfil + exceções — _shared/auth.ts::callerCan):
//
//   invite        { email, display_name?, phone?, job_title?, team_id?,
//                   access_role_id, must_change_password? }   → users.create
//   deactivate    { user_id }   → users.deactivate  (bloqueia o login: ban)
//   reactivate    { user_id }   → users.deactivate
//   reset_password{ user_id }   → users.reset_password (e-mail de redefinição)
//   resend_invite { user_id }   → users.create (convite ainda não aceito)
//
// Regras: ninguém age sobre si mesmo; super admin só por super admin; dar
// perfil com acesso total exige ser administrador. Tudo vai para a auditoria.
// ============================================================================

import { AuthError, callerCan, requireOrgCaller, type Caller } from '../_shared/auth.ts';
import { getAdminClient, getAuthAdminClient } from '../_shared/supabase-admin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

type OrgCaller = Caller & { orgId: string };
type Action = 'invite' | 'deactivate' | 'reactivate' | 'reset_password' | 'resend_invite';

const PERM: Record<Action, string> = {
  invite: 'users.create',
  deactivate: 'users.deactivate',
  reactivate: 'users.deactivate',
  reset_password: 'users.reset_password',
  resend_invite: 'users.create',
};

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const BAN_FOREVER = '876000h'; // ~100 anos

function clean(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function translateAuthError(raw: string): string {
  if (/already.*registered|User already registered|already been registered/i.test(raw)) return 'Já existe um usuário com esse e-mail.';
  if (/rate limit/i.test(raw)) return 'Muitos envios em sequência. Aguarde alguns minutos e tente de novo.';
  if (/invalid email|invalid format/i.test(raw)) return 'E-mail inválido.';
  return raw;
}

async function appUrl(orgId: string, bodyUrl: unknown): Promise<string> {
  const cred = (await getCredential(orgId, 'app_url'))?.replace(/\/$/, '') || '';
  const b = typeof bodyUrl === 'string' ? bodyUrl.trim().replace(/\/$/, '') : '';
  return cred || (/^https:\/\/[^\s/]+\.[^\s/]+/.test(b) ? b : '');
}

// Grava na auditoria em nome de quem fez a ação (a função roda como serviço).
async function audit(db: ReturnType<typeof getAdminClient>, caller: OrgCaller, action: string, target: string | null, summary: string, meta: Record<string, unknown> = {}) {
  await db.rpc('_audit', {
    p_org: caller.orgId,
    p_action: action,
    p_entity_type: 'user',
    p_entity_id: target,
    p_target: target,
    p_summary: summary,
    p_meta: meta,
    p_actor: caller.userId,
  });
}

// Os triggers de auditoria gravam sem autor quando a mudança vem do serviço;
// carimba o autor real nas linhas recém-criadas daquele usuário.
async function stampActor(db: ReturnType<typeof getAdminClient>, caller: OrgCaller, target: string) {
  const since = new Date(Date.now() - 15_000).toISOString();
  await db
    .from('access_audit_log')
    .update({ actor_id: caller.userId })
    .eq('org_id', caller.orgId)
    .eq('target_user_id', target)
    .is('actor_id', null)
    .gte('created_at', since);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireOrgCaller(req);
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    const action = body.action as Action;
    if (!action || !(action in PERM)) {
      return jsonResponse({ ok: false, error: 'Ação inválida.' }, { status: 400 });
    }
    if (!(await callerCan(caller, PERM[action]))) {
      return jsonResponse({ ok: false, error: 'Seu perfil não tem permissão para esta ação.' }, { status: 403 });
    }

    const db = getAdminClient();
    const authAdmin = getAuthAdminClient();
    const isFullAdmin = caller.isSuperAdmin || caller.role === 'admin';

    // ---------------------------------------------------------------- invite
    if (action === 'invite') {
      const email = (clean(body.email, 254) ?? '').toLowerCase();
      if (!EMAIL_RE.test(email)) return jsonResponse({ ok: false, error: 'E-mail inválido.' }, { status: 400 });
      const roleId = clean(body.access_role_id, 36);
      if (!roleId || !UUID_RE.test(roleId)) return jsonResponse({ ok: false, error: 'Escolha o perfil de acesso.' }, { status: 400 });

      const { data: roleRow } = await db
        .from('access_roles').select('id, org_id, name, is_admin').eq('id', roleId).maybeSingle();
      const role = roleRow as { id: string; org_id: string; name: string; is_admin: boolean } | null;
      if (!role || role.org_id !== caller.orgId) return jsonResponse({ ok: false, error: 'Perfil inválido.' }, { status: 400 });
      if (role.is_admin && !isFullAdmin) {
        return jsonResponse({ ok: false, error: 'Só um administrador pode criar outro administrador.' }, { status: 403 });
      }

      const teamId = clean(body.team_id, 36);
      if (teamId) {
        const { data: team } = await db.from('teams').select('id, org_id').eq('id', teamId).maybeSingle();
        if (!team || (team as { org_id: string }).org_id !== caller.orgId) {
          return jsonResponse({ ok: false, error: 'Equipe inválida.' }, { status: 400 });
        }
      }

      const base = await appUrl(caller.orgId, body.app_url);
      const { data, error } = await authAdmin.auth.admin.inviteUserByEmail(email, {
        data: {
          invited_role: role.is_admin ? 'admin' : 'operator',
          invited_org_id: caller.orgId,
          invited_by: caller.email,
        },
        ...(base ? { redirectTo: `${base}/invite` } : {}),
      });
      if (error || !data.user) {
        return jsonResponse({ ok: false, error: translateAuthError(error?.message ?? 'Falha no convite.') }, { status: error?.status ?? 400 });
      }
      const newId = data.user.id;

      const patch: Record<string, unknown> = {
        access_role_id: role.id,
        team_id: teamId,
        display_name: clean(body.display_name, 120),
        job_title: clean(body.job_title, 80),
        phone: clean(body.phone, 30),
        must_change_password: body.must_change_password === true,
      };
      const { error: upErr } = await db.from('app_users').update(patch).eq('user_id', newId).eq('org_id', caller.orgId);
      if (upErr) console.error(JSON.stringify({ event: 'invite_profile_update_failed', message: upErr.message }));

      await stampActor(db, caller, newId);
      await audit(db, caller, 'user.invited', newId, `Convite enviado para ${email} (perfil ${role.name})`, { email, role: role.name });
      return jsonResponse({ ok: true, user_id: newId });
    }

    // -------------------------------------------------- ações sobre um membro
    const userId = clean(body.user_id, 36);
    if (!userId || !UUID_RE.test(userId)) return jsonResponse({ ok: false, error: 'user_id inválido.' }, { status: 400 });
    if (userId === caller.userId) {
      return jsonResponse({ ok: false, error: 'Você não pode fazer isso na sua própria conta.' }, { status: 400 });
    }
    const { data: memberRow } = await db
      .from('app_users').select('user_id, org_id, is_super_admin, status, display_name').eq('user_id', userId).maybeSingle();
    const member = memberRow as { user_id: string; org_id: string; is_super_admin: boolean; status: string; display_name: string | null } | null;
    if (!member || member.org_id !== caller.orgId) return jsonResponse({ ok: false, error: 'Usuário não encontrado.' }, { status: 404 });
    if (member.is_super_admin && !caller.isSuperAdmin) {
      return jsonResponse({ ok: false, error: 'O acesso do super admin não pode ser alterado.' }, { status: 403 });
    }

    const { data: authUser } = await authAdmin.auth.admin.getUserById(userId);
    const email = authUser?.user?.email ?? null;
    const label = member.display_name || email || userId;

    if (action === 'deactivate' || action === 'reactivate') {
      const active = action === 'reactivate';
      const { error: banErr } = await authAdmin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : BAN_FOREVER });
      if (banErr) return jsonResponse({ ok: false, error: banErr.message }, { status: 400 });
      const { error: stErr } = await db.from('app_users').update({ status: active ? 'active' : 'inactive' }).eq('user_id', userId);
      if (stErr) return jsonResponse({ ok: false, error: stErr.message }, { status: 500 });
      await stampActor(db, caller, userId);
      return jsonResponse({ ok: true });
    }

    if (!email) return jsonResponse({ ok: false, error: 'Usuário sem e-mail.' }, { status: 400 });
    const base = await appUrl(caller.orgId, body.app_url);

    if (action === 'reset_password') {
      const { error } = await authAdmin.auth.resetPasswordForEmail(email, base ? { redirectTo: `${base}/invite` } : undefined);
      if (error) return jsonResponse({ ok: false, error: translateAuthError(error.message) }, { status: error.status ?? 400 });
      await audit(db, caller, 'user.password_reset', userId, `E-mail de redefinição de senha enviado para ${label}`, { email });
      return jsonResponse({ ok: true });
    }

    // resend_invite
    if (authUser?.user?.last_sign_in_at) {
      return jsonResponse({ ok: false, error: 'Este usuário já aceitou o convite. Use "Resetar senha".' }, { status: 400 });
    }
    const { error } = await authAdmin.auth.admin.inviteUserByEmail(email, base ? { redirectTo: `${base}/invite` } : undefined);
    if (error) return jsonResponse({ ok: false, error: translateAuthError(error.message) }, { status: error.status ?? 400 });
    await audit(db, caller, 'user.invite_resent', userId, `Convite reenviado para ${label}`, { email });
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    console.error('manage-team-member error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
