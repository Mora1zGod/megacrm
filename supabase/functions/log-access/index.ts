// ============================================================================
// log-access
// ----------------------------------------------------------------------------
// Registra login / logout na auditoria (access_audit_log) com IP e dispositivo.
// O IP só é visível no servidor (cabeçalhos da requisição), por isso isto é
// uma Edge Function e não uma chamada direta do navegador ao banco.
//
// Body: { action: 'auth.login' | 'auth.logout', user_agent?: string }
// No máximo 1 registro do mesmo tipo por minuto por usuário (evita duplicar
// quando a aba recarrega).
// ============================================================================

import { requireOrgCaller, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

const ACTIONS = new Set(['auth.login', 'auth.logout']);

function clientIp(req: Request): string | null {
  const h = req.headers;
  const xff = h.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 64) || null;
  return (h.get('cf-connecting-ip') ?? h.get('x-real-ip') ?? '').trim().slice(0, 64) || null;
}

// Resumo legível do navegador/sistema a partir do user agent.
function describeDevice(ua: string): string {
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iPhone/iPad'
    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux' : 'Outro sistema';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari' : 'Navegador';
  const mobile = /Mobile|Android|iPhone/i.test(ua) ? ' (celular)' : '';
  return `${browser} · ${os}${mobile}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = await requireOrgCaller(req);
    let body: { action?: string; user_agent?: string };
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const action = body.action ?? '';
    if (!ACTIONS.has(action)) return jsonResponse({ ok: false, error: 'Ação inválida.' }, { status: 400 });

    const db = getAdminClient();

    const since = new Date(Date.now() - 60_000).toISOString();
    const { data: recent } = await db
      .from('access_audit_log')
      .select('id')
      .eq('actor_id', caller.userId)
      .eq('action', action)
      .gte('created_at', since)
      .limit(1);
    if (recent && recent.length > 0) return jsonResponse({ ok: true, deduped: true });

    const ua = (body.user_agent ?? req.headers.get('user-agent') ?? '').slice(0, 300);
    const ip = clientIp(req);
    const device = ua ? describeDevice(ua) : null;

    const { data: me } = await db
      .from('app_users').select('display_name').eq('user_id', caller.userId).maybeSingle();
    const name = (me as { display_name?: string | null } | null)?.display_name?.trim()
      || caller.email?.split('@')[0] || 'Usuário';

    const verb = action === 'auth.login' ? 'entrou no sistema' : 'saiu do sistema';

    const { error } = await db.rpc('_audit', {
      p_org: caller.orgId,
      p_action: action,
      p_entity_type: 'auth',
      p_entity_id: caller.userId,
      p_target: caller.userId,
      p_summary: `${name} ${verb}`,
      p_meta: { ip, device, user_agent: ua || null },
      p_actor: caller.userId,
    });
    if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 });
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    console.error('log-access error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
