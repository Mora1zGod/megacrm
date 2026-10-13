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

// Troca a organização em uso: o banco muda a claim do token, a sessão é renovada e a tela recarrega.
export async function switchMyOrg(orgId: string): Promise<void> {
  const { error } = await db().rpc('switch_my_org', { p_org: orgId });
  if (error) throw new Error(error.message);
  await getSupabase().auth.refreshSession();
  window.location.href = '/';
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
