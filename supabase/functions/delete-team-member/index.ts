// ============================================================================
// delete-team-member
// ----------------------------------------------------------------------------
// Admin remove um membro da equipe DESTA organização. Se a pessoa não estiver em
// nenhuma outra organização, a conta (auth.users) também é apagada; se estiver,
// só o acesso a esta org sai e ela continua entrando nas outras.
//
// Só `admin` pode remover. Um admin não pode remover a si mesmo (evita a
// instância ficar sem owner por acidente).
// ============================================================================

import { requireAdmin, AuthError } from '../_shared/auth.ts';
import { getAdminClient, getAuthAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireAdmin(req);

    let body: { user_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }

    const userId = (body.user_id ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return jsonResponse({ ok: false, error: 'user_id inválido.' }, { status: 400 });
    }
    if (userId === caller.userId) {
      return jsonResponse({ ok: false, error: 'Você não pode remover a si mesmo.' }, { status: 400 });
    }

    const db = getAdminClient();

    // Cross-check de org: o membro alvo precisa pertencer à org do caller —
    // senão um admin poderia remover usuários de outra organização.
    const { data: target } = await db
      .from('app_users')
      .select('user_id, org_id')
      .eq('user_id', userId)
      .eq('org_id', caller.orgId)
      .maybeSingle();
    if (!target || (target as { org_id: string }).org_id !== caller.orgId) {
      return jsonResponse({ ok: false, error: 'Membro não encontrado.' }, { status: 404 });
    }

    // Remove o registro de membro (FK cobre, mas fazemos explícito para o caso
    // de a FK não ser ON DELETE CASCADE).
    const { error: rowErr } = await db.from('app_users').delete().eq('user_id', userId).eq('org_id', caller.orgId);
    if (rowErr) return jsonResponse({ ok: false, error: rowErr.message }, { status: 500 });

    // Está em outra organização: mantém a conta.
    const { count: others, error: othersErr } = await db
      .from('app_users').select('org_id', { count: 'exact', head: true }).eq('user_id', userId);
    if (othersErr) return jsonResponse({ ok: false, error: othersErr.message }, { status: 500 });
    if ((others ?? 0) > 0) return jsonResponse({ ok: true, user_id: userId, kept_account: true });

    // Remove o usuário do Auth.
    const authAdmin = getAuthAdminClient();
    const { error } = await authAdmin.auth.admin.deleteUser(userId);
    if (error) {
      return jsonResponse({ ok: false, error: error.message }, { status: error.status ?? 400 });
    }

    return jsonResponse({ ok: true, user_id: userId });
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    }
    console.error('delete-team-member error', err);
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : 'Erro interno' },
      { status: 500 },
    );
  }
});
