// ============================================================================
// public-signup  (PÚBLICA — deploy com --no-verify-jwt)
// ----------------------------------------------------------------------------
// Página /cadastro/<token>: a pessoa se cadastra pelo link que o admin mandou
// e fica AGUARDANDO APROVAÇÃO (app_users.status = 'pending', conta banida no
// Auth). Quem aprova é a tela "Usuários e acessos" (manage-team-member).
//
//   { action: 'info',   token }  → nome/logo da organização (link válido?)
//   { action: 'submit', token, display_name, email, phone?, job_title?, password }
//
// Nunca aceita perfil/org vindos do navegador: tudo sai do link no banco.
// Limites: 5 cadastros por IP a cada 10 min; 30 pendentes por organização.
// ============================================================================

import { getAdminClient, getAuthAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

const TOKEN_RE = /^[0-9a-f]{20,64}$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const BAN_FOREVER = '876000h';
const MAX_PENDING_PER_ORG = 30;
const MAX_PER_IP = 5;

type LinkRow = {
  id: string;
  org_id: string;
  access_role_id: string | null;
  team_id: string | null;
  is_active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
};

function clean(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, max) : null;
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 64) || null;
  return (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? '').trim().slice(0, 64) || null;
}

function linkProblem(link: LinkRow | null): string | null {
  if (!link || !link.is_active) return 'Este link de cadastro não existe ou foi desativado. Peça um novo ao administrador.';
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'Este link de cadastro expirou. Peça um novo ao administrador.';
  if (link.max_uses != null && link.uses >= link.max_uses) return 'Este link já atingiu o limite de cadastros. Peça um novo ao administrador.';
  return null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Método não permitido.' }, { status: 405 });

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!TOKEN_RE.test(token)) return jsonResponse({ ok: false, error: 'Link de cadastro inválido.' }, { status: 404 });

    const db = getAdminClient();
    const { data: linkData } = await db
      .from('signup_links')
      .select('id, org_id, access_role_id, team_id, is_active, expires_at, max_uses, uses')
      .eq('token', token)
      .maybeSingle();
    const link = linkData as LinkRow | null;
    const problem = linkProblem(link);
    if (problem) return jsonResponse({ ok: false, error: problem }, { status: 404 });

    const { data: orgData } = await db
      .from('organizations').select('id, name, status, logo_url').eq('id', link!.org_id).maybeSingle();
    const org = orgData as { id: string; name: string; status: string; logo_url: string | null } | null;
    if (!org || org.status !== 'active') {
      return jsonResponse({ ok: false, error: 'Este link de cadastro não está mais disponível.' }, { status: 404 });
    }

    if (body.action === 'info') {
      return jsonResponse({ ok: true, org: { name: org.name, logo_url: org.logo_url } });
    }
    if (body.action !== 'submit') return jsonResponse({ ok: false, error: 'Ação inválida.' }, { status: 400 });

    // ------------------------------------------------------------- validação
    const name = clean(body.display_name, 120);
    const email = (clean(body.email, 254) ?? '').toLowerCase();
    const phone = clean(body.phone, 30);
    const job = clean(body.job_title, 80);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || name.length < 3) return jsonResponse({ ok: false, error: 'Informe seu nome completo.' }, { status: 400 });
    if (!EMAIL_RE.test(email)) return jsonResponse({ ok: false, error: 'E-mail inválido.' }, { status: 400 });
    if (phone && phone.replace(/\D/g, '').length < 10) return jsonResponse({ ok: false, error: 'Telefone incompleto.' }, { status: 400 });
    if (password.length < 8 || password.length > 72) {
      return jsonResponse({ ok: false, error: 'A senha precisa ter de 8 a 72 caracteres.' }, { status: 400 });
    }

    // --------------------------------------------------------------- limites
    const ip = clientIp(req);
    if (ip) {
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const { count } = await db
        .from('access_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('action', 'user.signup_link_used')
        .eq('metadata->>ip', ip)
        .gte('created_at', since);
      if ((count ?? 0) >= MAX_PER_IP) {
        return jsonResponse({ ok: false, error: 'Muitos cadastros em sequência. Aguarde alguns minutos.' }, { status: 429 });
      }
    }
    const { count: pending } = await db
      .from('app_users')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', org.id)
      .eq('status', 'pending');
    if ((pending ?? 0) >= MAX_PENDING_PER_ORG) {
      return jsonResponse({ ok: false, error: 'Há muitos cadastros aguardando aprovação. Fale com o administrador.' }, { status: 429 });
    }

    // ------------------------------------------------- cria a conta (banida)
    // Mesmo caminho do convite (handle_new_user exige invited_org_id +
    // invited_role); o papel é sempre 'operator' até a aprovação definir o perfil.
    const authAdmin = getAuthAdminClient();
    const { data: created, error: createErr } = await authAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ban_duration: BAN_FOREVER,
      user_metadata: {
        invited_role: 'operator',
        invited_org_id: org.id,
        display_name: name,
        signup_link_id: link!.id,
      },
    });
    if (createErr || !created?.user) {
      const raw = createErr?.message ?? '';
      const msg = /already.*registered|already been registered|exists/i.test(raw)
        ? 'Já existe uma conta com esse e-mail. Se for sua, use "Esqueci minha senha" no login.'
        : /password/i.test(raw) ? 'Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.'
        : 'Não foi possível concluir o cadastro. Tente novamente.';
      console.error(JSON.stringify({ event: 'public_signup_create_failed', message: raw }));
      return jsonResponse({ ok: false, error: msg }, { status: 400 });
    }
    const newId = created.user.id;

    // Garante o bloqueio mesmo se o Auth ignorar ban_duration na criação.
    await authAdmin.auth.admin.updateUserById(newId, { ban_duration: BAN_FOREVER });

    const { error: upErr } = await db
      .from('app_users')
      .update({
        status: 'pending',
        display_name: name,
        phone,
        job_title: job,
        team_id: link!.team_id,
        ...(link!.access_role_id ? { access_role_id: link!.access_role_id } : {}),
      })
      .eq('user_id', newId)
      .eq('org_id', org.id);
    if (upErr) {
      // Sem a linha "pendente" a conta não pode ficar solta: desfaz.
      console.error(JSON.stringify({ event: 'public_signup_profile_failed', message: upErr.message }));
      await authAdmin.auth.admin.deleteUser(newId);
      return jsonResponse({ ok: false, error: 'Não foi possível concluir o cadastro. Tente novamente.' }, { status: 500 });
    }

    await db.from('signup_links').update({ uses: link!.uses + 1 }).eq('id', link!.id);
    await db.rpc('_audit', {
      p_org: org.id,
      p_action: 'user.signup_link_used',
      p_entity_type: 'user',
      p_entity_id: newId,
      p_target: newId,
      p_summary: `${name} (${email}) se cadastrou pelo link e aguarda aprovação`,
      p_meta: { ip, email, link_id: link!.id, user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null },
      p_actor: newId,
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('public-signup error', err);
    return jsonResponse({ ok: false, error: 'Erro interno. Tente novamente.' }, { status: 500 });
  }
});
