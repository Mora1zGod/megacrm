-- ============================================================================
-- Usuários desativados não aparecem nos seletores (12/10/2026)
-- ----------------------------------------------------------------------------
-- list_operators() escondia só os pendentes: desativado/bloqueado continuava nas
-- listas de "Nova conversa", atribuir, compartilhar quadro etc. Agora a função
-- devolve também o status; o sistema mostra nos seletores só os ATIVOS e usa a
-- lista completa apenas para exibir o nome de quem fez algo no passado
-- (histórico, auditoria, autor de mensagem). Nada é apagado.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- Tipo de retorno muda (coluna nova) → recriar a função; permissões refeitas abaixo.
DROP FUNCTION IF EXISTS whatsapp_hub.list_operators();
CREATE FUNCTION whatsapp_hub.list_operators()
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
  SELECT au.user_id, u.email::text, au.role, au.display_name, au.avatar_url, au.status
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
   WHERE au.org_id = whatsapp_hub.current_org_id()
     AND au.status <> 'pending'
   ORDER BY (au.status <> 'active'), au.role, COALESCE(au.display_name, u.email::text);
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_operators() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_operators() TO authenticated, service_role;



-- Desativado/bloqueado fica "offline": o rodízio de conversas (_on_handoff_autoassign) só escolhe quem está
-- online, então quem foi desativado para de receber conversa automaticamente — sem mexer na função do rodízio.
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_offline_when_inactive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' AND NEW.is_online THEN
    NEW.is_online := false;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_app_users_offline_when_inactive ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_offline_when_inactive
  BEFORE INSERT OR UPDATE OF status, is_online ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_offline_when_inactive();

-- Quem já está desativado hoje e ainda aparecia online.
UPDATE whatsapp_hub.app_users SET is_online = false WHERE status <> 'active' AND is_online;

-- Conferência: usuários listados (sem pendentes) e quantos desativados/bloqueados.
SELECT count(*) FILTER (WHERE status = 'active') AS ativos,
       count(*) FILTER (WHERE status <> 'active') AS desativados_ocultos_nos_seletores
  FROM whatsapp_hub.app_users WHERE status <> 'pending';

NOTIFY pgrst, 'reload schema';
