-- ============================================================================
-- Cadastro por link + aprovação (08/10/2026)
-- ----------------------------------------------------------------------------
-- O admin gera um link (Configurações → Usuários e acessos → "Link de
-- cadastro") e manda para a pessoa. Ela preenche nome, e-mail, telefone, cargo
-- e senha; a conta nasce com status 'pending' (e banida no Auth) até alguém
-- com "Criar/convidar usuário" aprovar e escolher o perfil.
--
-- 1. app_users.status aceita 'pending' (aguardando aprovação).
-- 2. signup_links: links por org (token secreto, perfil/equipe sugeridos,
--    validade e limite de usos opcionais, ativo/inativo).
-- 3. Auditoria: pending → active vira "foi aprovado".
-- 4. list_operators() não lista quem ainda não foi aprovado.
-- Quem cria a conta é a Edge Function pública `public-signup` (service role);
-- o handle_new_user NÃO muda (a função usa o mesmo caminho do convite).
-- Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public, extensions;

-- ----------------------------------------------------------------------------
-- 1. status 'pending'
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.app_users DROP CONSTRAINT IF EXISTS app_users_status_check;
ALTER TABLE whatsapp_hub.app_users
  ADD CONSTRAINT app_users_status_check CHECK (status IN ('active', 'inactive', 'blocked', 'pending'));

-- ----------------------------------------------------------------------------
-- 2. signup_links
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.signup_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  token          text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(18), 'hex'),
  label          text,
  access_role_id uuid REFERENCES whatsapp_hub.access_roles(id) ON DELETE SET NULL,
  team_id        uuid REFERENCES whatsapp_hub.teams(id) ON DELETE SET NULL,
  is_active      boolean NOT NULL DEFAULT true,
  expires_at     timestamptz,
  max_uses       int CHECK (max_uses IS NULL OR max_uses > 0),
  uses           int NOT NULL DEFAULT 0,
  created_by     uuid DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_links_org_idx ON whatsapp_hub.signup_links (org_id, created_at DESC);

ALTER TABLE whatsapp_hub.signup_links ALTER COLUMN org_id SET DEFAULT whatsapp_hub.current_org_id();
ALTER TABLE whatsapp_hub.signup_links ENABLE ROW LEVEL SECURITY;

-- Só quem pode criar usuário vê/gera/desativa links da própria org.
-- (A página pública NÃO lê esta tabela: passa pela Edge Function.)
DROP POLICY IF EXISTS signup_links_select ON whatsapp_hub.signup_links;
CREATE POLICY signup_links_select ON whatsapp_hub.signup_links
  FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('users.create'));
DROP POLICY IF EXISTS signup_links_insert ON whatsapp_hub.signup_links;
CREATE POLICY signup_links_insert ON whatsapp_hub.signup_links
  FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('users.create'));
DROP POLICY IF EXISTS signup_links_update ON whatsapp_hub.signup_links;
CREATE POLICY signup_links_update ON whatsapp_hub.signup_links
  FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('users.create'))
  WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('users.create'));
DROP POLICY IF EXISTS signup_links_delete ON whatsapp_hub.signup_links;
CREATE POLICY signup_links_delete ON whatsapp_hub.signup_links
  FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('users.create'));

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.signup_links TO authenticated;
GRANT ALL ON whatsapp_hub.signup_links TO service_role;

-- O perfil/equipe sugeridos precisam ser da mesma org do link.
CREATE OR REPLACE FUNCTION whatsapp_hub._signup_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF NEW.access_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_hub.access_roles WHERE id = NEW.access_role_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'Perfil inválido para esta organização.';
  END IF;
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_hub.teams WHERE id = NEW.team_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'Equipe inválida para esta organização.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.org_id := OLD.org_id;
    NEW.token := OLD.token;
    NEW.created_by := OLD.created_by;
    -- "uses" só o servidor (service role) incrementa.
    IF auth.uid() IS NOT NULL THEN NEW.uses := OLD.uses; END IF;
  ELSIF auth.uid() IS NOT NULL THEN
    NEW.uses := 0;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_signup_links_guard ON whatsapp_hub.signup_links;
CREATE TRIGGER trg_signup_links_guard
  BEFORE INSERT OR UPDATE ON whatsapp_hub.signup_links
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._signup_links_guard();

-- ----------------------------------------------------------------------------
-- 3. Auditoria de app_users: aprovação de cadastro.
--    (Mesma função da etapa 3, só com o caso pending → active.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._audit_app_users()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_old_role text;
  v_new_role text;
  v_who text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT name INTO v_new_role FROM whatsapp_hub.access_roles WHERE id = NEW.access_role_id;
    PERFORM whatsapp_hub._audit(NEW.org_id, 'user.created', 'user', NEW.user_id::text, NEW.user_id,
      format('Usuário %s criado (perfil %s)', COALESCE(whatsapp_hub._user_label(NEW.user_id), 'novo'), COALESCE(v_new_role, NEW.role::text)),
      jsonb_build_object('role', v_new_role));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM whatsapp_hub._audit(OLD.org_id,
      CASE WHEN OLD.status = 'pending' THEN 'user.signup_rejected' ELSE 'user.removed' END,
      'user', OLD.user_id::text, OLD.user_id,
      CASE WHEN OLD.status = 'pending'
        THEN format('Cadastro de %s recusado', COALESCE(OLD.display_name, OLD.user_id::text))
        ELSE format('Usuário %s removido da equipe', COALESCE(OLD.display_name, OLD.user_id::text)) END,
      '{}'::jsonb);
    RETURN OLD;
  END IF;

  v_who := COALESCE(whatsapp_hub._user_label(NEW.user_id), NEW.user_id::text);

  IF NEW.access_role_id IS DISTINCT FROM OLD.access_role_id THEN
    SELECT name INTO v_old_role FROM whatsapp_hub.access_roles WHERE id = OLD.access_role_id;
    SELECT name INTO v_new_role FROM whatsapp_hub.access_roles WHERE id = NEW.access_role_id;
    PERFORM whatsapp_hub._audit(NEW.org_id, 'user.role_changed', 'user', NEW.user_id::text, NEW.user_id,
      format('Perfil de %s: %s → %s', v_who, COALESCE(v_old_role, '—'), COALESCE(v_new_role, '—')),
      jsonb_build_object('from', v_old_role, 'to', v_new_role));
  END IF;

  -- active → pending só acontece no cadastro pelo link (a Edge Function já
  -- registra o pedido com IP); não duplica.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'pending' THEN
    PERFORM whatsapp_hub._audit(NEW.org_id,
      CASE
        WHEN OLD.status = 'pending' AND NEW.status = 'active' THEN 'user.signup_approved'
        WHEN NEW.status = 'active' THEN 'user.reactivated'
        WHEN NEW.status = 'blocked' THEN 'user.blocked'
        ELSE 'user.deactivated' END,
      'user', NEW.user_id::text, NEW.user_id,
      format('%s %s', v_who, CASE
        WHEN OLD.status = 'pending' AND NEW.status = 'active' THEN 'teve o cadastro aprovado'
        WHEN NEW.status = 'active' THEN 'foi reativado'
        WHEN NEW.status = 'blocked' THEN 'foi bloqueado'
        ELSE 'foi desativado' END),
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.job_title IS DISTINCT FROM OLD.job_title
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
    PERFORM whatsapp_hub._audit(NEW.org_id, 'user.updated', 'user', NEW.user_id::text, NEW.user_id,
      format('Dados de %s alterados', v_who),
      jsonb_strip_nulls(jsonb_build_object(
        'team', CASE WHEN NEW.team_id IS DISTINCT FROM OLD.team_id
                     THEN (SELECT name FROM whatsapp_hub.teams WHERE id = NEW.team_id) END,
        'job_title', CASE WHEN NEW.job_title IS DISTINCT FROM OLD.job_title THEN NEW.job_title END,
        'phone_changed', CASE WHEN NEW.phone IS DISTINCT FROM OLD.phone THEN true END,
        'must_change_password', CASE WHEN NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN NEW.must_change_password END)));
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Seletores de atribuição não mostram cadastro aguardando aprovação.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.list_operators()
RETURNS TABLE (
  user_id      uuid,
  email        text,
  role         whatsapp_hub.tenant_role,
  display_name text,
  avatar_url   text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, public, pg_temp
AS $$
  SELECT au.user_id, u.email::text, au.role, au.display_name, au.avatar_url
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
   WHERE au.org_id = whatsapp_hub.current_org_id()
     AND au.status <> 'pending'
   ORDER BY au.role, COALESCE(au.display_name, u.email::text);
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_operators() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_operators() TO authenticated, service_role;
