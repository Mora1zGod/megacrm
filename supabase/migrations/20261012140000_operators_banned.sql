-- ============================================================================
-- Desativados "do jeito antigo" também somem dos seletores (12/10/2026)
-- ----------------------------------------------------------------------------
-- Antes de 07/10/2026 desativar só bloqueava o login (ban no Supabase Auth) e o
-- app_users.status ficava 'active'. Esses usuários continuavam aparecendo.
-- list_operators() passa a tratar login bloqueado como 'inactive' (só na leitura —
-- nenhum cadastro é alterado). Mesma assinatura: CREATE OR REPLACE basta.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE OR REPLACE FUNCTION whatsapp_hub.list_operators()
RETURNS TABLE (
  user_id      uuid,
  email        text,
  role         whatsapp_hub.tenant_role,
  display_name text,
  avatar_url   text,
  status       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, public, pg_temp
AS $$
  SELECT x.user_id, x.email, x.role, x.display_name, x.avatar_url, x.status
    FROM (
      SELECT au.user_id, u.email::text AS email, au.role, au.display_name, au.avatar_url,
             CASE WHEN au.status = 'active' AND u.banned_until IS NOT NULL AND u.banned_until > now() THEN 'inactive'
                  ELSE au.status END AS status
        FROM whatsapp_hub.app_users au
        JOIN auth.users u ON u.id = au.user_id
       WHERE au.org_id = whatsapp_hub.current_org_id()
         AND au.status <> 'pending'
    ) x
   ORDER BY (x.status <> 'active'), x.role, COALESCE(x.display_name, x.email);
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_operators() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_operators() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Conferência: quem está com login bloqueado mas cadastro "ativo" (agora tratado como desativado).
SELECT COALESCE(au.display_name, u.email) AS usuario, u.email, au.status AS status_no_cadastro,
       (u.banned_until > now()) AS login_bloqueado
  FROM whatsapp_hub.app_users au JOIN auth.users u ON u.id = au.user_id
 WHERE au.status <> 'pending'
 ORDER BY login_bloqueado DESC NULLS LAST, 1;
