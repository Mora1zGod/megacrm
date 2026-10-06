-- ============================================================================
-- Controle de acesso — ETAPA 2 (07/10/2026): ajuste do perfil "Atendimento"
-- ----------------------------------------------------------------------------
-- Mantém EXATAMENTE o comportamento de hoje do operador:
--   * conversa atribuída a outra pessoa fica travada → escopo do Atendimento
--     = "own" (próprias + sem responsável), não "all";
--   * operador já exportava contatos → contacts.export no perfil.
-- Só altera o perfil padrão se ele ainda estiver como a etapa 1 criou.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

UPDATE whatsapp_hub.access_roles
   SET scopes = jsonb_set(scopes, '{inbox}', '"own"')
 WHERE is_system AND name = 'Atendimento' AND scopes->>'inbox' = 'all';

INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, 'contacts.export'
  FROM whatsapp_hub.access_roles ar
 WHERE ar.is_system AND ar.name = 'Atendimento'
ON CONFLICT DO NOTHING;

-- Checagem de permissão para as Edge Functions (service role): o usuário X,
-- na org Y, tem a permissão Z? Mesma regra do has_perm(), sem depender do JWT.
CREATE OR REPLACE FUNCTION whatsapp_hub.user_has_perm(p_user uuid, p_org uuid, p_key text)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_hub.organizations WHERE id = p_org AND status = 'active'
  ) AND EXISTS (
    SELECT 1 FROM whatsapp_hub.effective_permissions(p_user, p_org) k WHERE k = p_key
  )
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.user_has_perm(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.user_has_perm(uuid, uuid, text) TO service_role;
