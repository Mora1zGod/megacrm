import { getSupabase } from '@/lib/supabase';

// Mesmo usuário em várias organizações (20261013100000_multi_org_members.sql).
// Cada organização tem a própria linha em app_users (perfil, equipe, status).

export interface MyOrg { id: string; name: string; is_current: boolean }

const db = () => getSupabase().schema('whatsapp_hub');

// Organizações em que estou ativo. Banco sem o SQL novo → lista vazia (sem seletor).
export async function loadMyOrgs(): Promise<MyOrg[]> {
  const { data, error } = await db().rpc('my_orgs');
  if (error) return [];
  return (data ?? []) as MyOrg[];
}

// Depois de trocar de organização: recarrega NA MESMA tela (antes ia para o início = Visão geral, a tela mais
// pesada). Tela de um registro específico (/contacts/<id>) volta para a lista — o registro é da outra org.
export function reloadHere(fallback = '/') {
  const { pathname, search } = window.location;
  const path = pathname === '/' ? fallback : pathname.replace(/^\/contacts\/[^/]+$/, '/contacts');
  window.location.replace(path + (path === pathname ? search : ''));
}

// Troca a organização em uso: o banco muda a claim do token, a sessão é renovada e a tela recarrega.
export async function switchMyOrg(orgId: string): Promise<void> {
  const { error } = await db().rpc('switch_my_org', { p_org: orgId });
  if (error) throw new Error(error.message);
  await getSupabase().auth.refreshSession();
  reloadHere();
}

// Super admin (modo suporte): troca direto no banco (admin_switch_org). Sem a função ainda no banco,
// cai na rota antiga da Vercel (/api/admin/switch-org), que é mais lenta.
export async function adminSwitchOrg(target: { orgId: string } | { back: true }): Promise<void> {
  const back = 'back' in target;
  const { error } = await db().rpc('admin_switch_org', back ? { p_back: true } : { p_org: target.orgId });
  if (error) {
    if (!/admin_switch_org|schema cache|could not find the function/i.test(error.message)) throw new Error(error.message);
    const { data } = await getSupabase().auth.getSession();
    const res = await fetch('/api/admin/switch-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
      body: JSON.stringify(back ? { back: true } : { orgId: target.orgId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao trocar de organização.');
  }
  await getSupabase().auth.refreshSession();
}

// O convite por e-mail recusa quem já tem conta (está em outra organização).
export function isAlreadyRegistered(message: string | null | undefined): boolean {
  return /já existe um usuário com esse e-mail|already.*registered|already been registered/i.test(message ?? '');
}

// Dá acesso a ESTA organização para quem já tem conta. Devolve a mensagem de erro (ou null).
export async function addExistingMember(p: {
  email: string; access_role_id: string; team_id?: string | null; job_title?: string | null; phone?: string | null;
}): Promise<string | null> {
  const { error } = await db().rpc('org_add_member', {
    p_email: p.email.trim(),
    p_access_role: p.access_role_id,
    p_team: p.team_id || null,
    p_job_title: p.job_title?.trim() || null,
    p_phone: p.phone?.trim() || null,
  });
  if (!error) return null;
  if (/org_add_member|schema cache|function/i.test(error.message) && !/organiza|perfil|equipe|conta/i.test(error.message)) {
    return 'Falta rodar no Supabase o SQL "várias organizações" (20261013100000_multi_org_members).';
  }
  return error.message;
}

export const ADDED_EXISTING_MSG = 'Essa pessoa já tinha conta: agora ela também tem acesso a esta organização (troca pelo seletor no topo, com a mesma senha).';
