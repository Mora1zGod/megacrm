-- ============================================================================
-- Controle de acesso — ETAPA 5: login (07/10/2026)
-- ----------------------------------------------------------------------------
-- 1. Usuário DESATIVADO/BLOQUEADO perde o acesso aos dados NA HORA: a função
--    current_org_active() — usada em TODAS as policies — passa a exigir também
--    que o usuário logado esteja ativo na organização. Antes, o token aberto
--    continuava valendo até expirar (~1h).
-- 2. clear_my_password_flag(): depois de trocar a senha obrigatória.
-- Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

-- Org ativa E usuário ativo nela. Super admin (modo suporte) não depende do
-- status na org visitada. Service role (sem usuário) segue como antes.
CREATE OR REPLACE FUNCTION whatsapp_hub.current_org_active()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_hub.organizations
     WHERE id = whatsapp_hub.current_org_id() AND status = 'active'
  )
  AND (
    auth.uid() IS NULL
    OR whatsapp_hub.is_super_admin()
    OR NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.app_users
       WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id() AND status <> 'active'
    )
  )
$$;
GRANT EXECUTE ON FUNCTION whatsapp_hub.current_org_active() TO authenticated, service_role, anon;

-- Troca obrigatória concluída: limpa a exigência (só da própria conta).
CREATE OR REPLACE FUNCTION whatsapp_hub.clear_my_password_flag()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid;
  v_was boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT org_id, must_change_password INTO v_org, v_was
    FROM whatsapp_hub.app_users WHERE user_id = auth.uid();
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE whatsapp_hub.app_users SET must_change_password = false WHERE user_id = auth.uid() AND must_change_password;
  IF v_was THEN
    PERFORM whatsapp_hub._audit(v_org, 'auth.password_changed', 'auth', auth.uid()::text, auth.uid(),
      format('%s definiu uma nova senha (troca obrigatória)', COALESCE(whatsapp_hub._user_label(auth.uid()), 'Usuário')));
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.clear_my_password_flag() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.clear_my_password_flag() TO authenticated;
