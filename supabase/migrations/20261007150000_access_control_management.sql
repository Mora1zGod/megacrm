-- ============================================================================
-- Controle de acesso — ETAPA 3: gestão (tela "Usuários e acessos") — 07/10/2026
-- ----------------------------------------------------------------------------
-- * access_audit_log: auditoria gravada SÓ pelo servidor (triggers e funções
--   SECURITY DEFINER) — o navegador não consegue forjar nem apagar.
-- * list_members(): equipe com e-mail, perfil, equipe, status e último acesso.
-- * save_access_role / duplicate_access_role / delete_access_role:
--   editar perfil + matriz de permissões numa transação, com auditoria.
-- * set_user_overrides: exceções por usuário (liberar/bloquear), com auditoria.
-- * log_access_event: login/logout.
-- Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Auditoria
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.access_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  actor_id       uuid,                 -- quem fez (null = sistema)
  action         text NOT NULL,        -- ex.: user.role_changed
  entity_type    text NOT NULL,        -- user | role | team | auth
  entity_id      text,
  target_user_id uuid,
  summary        text,                 -- frase pronta para a tela
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_audit_org_created_idx ON whatsapp_hub.access_audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS access_audit_target_idx ON whatsapp_hub.access_audit_log (target_user_id, created_at DESC);

ALTER TABLE whatsapp_hub.access_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_audit_select ON whatsapp_hub.access_audit_log;
CREATE POLICY access_audit_select ON whatsapp_hub.access_audit_log
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.has_perm('audit.view'));
-- Sem policy de INSERT/UPDATE/DELETE: só o servidor escreve.
GRANT SELECT ON whatsapp_hub.access_audit_log TO authenticated;
GRANT ALL ON whatsapp_hub.access_audit_log TO service_role;

CREATE OR REPLACE FUNCTION whatsapp_hub._audit(
  p_org uuid, p_action text, p_entity_type text, p_entity_id text,
  p_target uuid, p_summary text, p_meta jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  INSERT INTO whatsapp_hub.access_audit_log (org_id, actor_id, action, entity_type, entity_id, target_user_id, summary, metadata)
  VALUES (p_org, COALESCE(p_actor, auth.uid()), p_action, p_entity_type, p_entity_id, p_target, p_summary, COALESCE(p_meta, '{}'::jsonb));
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._audit(uuid, text, text, text, uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._audit(uuid, text, text, text, uuid, text, jsonb, uuid) TO service_role;

-- Nome exibível de um usuário (para as frases da auditoria).
CREATE OR REPLACE FUNCTION whatsapp_hub._user_label(p_user uuid)
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
  SELECT COALESCE(NULLIF(btrim(au.display_name), ''), split_part(u.email::text, '@', 1), p_user::text)
    FROM auth.users u
    LEFT JOIN whatsapp_hub.app_users au ON au.user_id = u.id
   WHERE u.id = p_user
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._user_label(uuid) FROM PUBLIC, anon, authenticated;

-- app_users: criação, troca de perfil, status, dados, remoção.
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
    PERFORM whatsapp_hub._audit(OLD.org_id, 'user.removed', 'user', OLD.user_id::text, OLD.user_id,
      format('Usuário %s removido da equipe', COALESCE(OLD.display_name, OLD.user_id::text)), '{}'::jsonb);
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

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM whatsapp_hub._audit(NEW.org_id,
      CASE NEW.status WHEN 'active' THEN 'user.reactivated' WHEN 'blocked' THEN 'user.blocked' ELSE 'user.deactivated' END,
      'user', NEW.user_id::text, NEW.user_id,
      format('%s %s', v_who, CASE NEW.status WHEN 'active' THEN 'foi reativado' WHEN 'blocked' THEN 'foi bloqueado' ELSE 'foi desativado' END),
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
DROP TRIGGER IF EXISTS trg_audit_app_users ON whatsapp_hub.app_users;
CREATE TRIGGER trg_audit_app_users
  AFTER INSERT OR UPDATE OR DELETE ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._audit_app_users();

-- Equipes.
CREATE OR REPLACE FUNCTION whatsapp_hub._audit_teams()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM whatsapp_hub._audit(OLD.org_id, 'team.deleted', 'team', OLD.id::text, NULL, format('Equipe %s excluída', OLD.name));
    RETURN OLD;
  END IF;
  PERFORM whatsapp_hub._audit(NEW.org_id, CASE TG_OP WHEN 'INSERT' THEN 'team.created' ELSE 'team.updated' END,
    'team', NEW.id::text, NULL,
    format(CASE TG_OP WHEN 'INSERT' THEN 'Equipe %s criada' ELSE 'Equipe %s alterada' END, NEW.name));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_teams ON whatsapp_hub.teams;
CREATE TRIGGER trg_audit_teams
  AFTER INSERT OR UPDATE OR DELETE ON whatsapp_hub.teams
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._audit_teams();

-- ----------------------------------------------------------------------------
-- 2. Lista da equipe (com e-mail e último acesso de auth.users)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS whatsapp_hub.list_members();
CREATE FUNCTION whatsapp_hub.list_members()
RETURNS TABLE (
  user_id          uuid,
  email            text,
  display_name     text,
  avatar_url       text,
  phone            text,
  job_title        text,
  team_id          uuid,
  team_name        text,
  access_role_id   uuid,
  role_name        text,
  role_is_admin    boolean,
  status           text,
  is_super_admin   boolean,
  must_change_password boolean,
  invite_pending   boolean,
  last_sign_in_at  timestamptz,
  created_at       timestamptz
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
  SELECT au.user_id, u.email::text, au.display_name, au.avatar_url, au.phone, au.job_title,
         au.team_id, t.name, au.access_role_id, ar.name, COALESCE(ar.is_admin, au.role = 'admin'),
         au.status, au.is_super_admin, au.must_change_password,
         (u.last_sign_in_at IS NULL), u.last_sign_in_at, au.created_at
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
    LEFT JOIN whatsapp_hub.teams t ON t.id = au.team_id
    LEFT JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
   WHERE au.org_id = whatsapp_hub.current_org_id()
     AND whatsapp_hub.current_org_active()
     AND (whatsapp_hub.has_perm('users.view') OR au.user_id = auth.uid())
   ORDER BY (au.status = 'active') DESC, COALESCE(NULLIF(btrim(au.display_name), ''), u.email::text)
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.list_members() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.list_members() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Perfis: salvar (com matriz), duplicar, excluir — só acesso total
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.save_access_role(
  p_id uuid, p_name text, p_description text, p_scopes jsonb, p_permissions text[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_id uuid := p_id;
  v_role whatsapp_hub.access_roles%ROWTYPE;
  v_added text[];
  v_removed text[];
  v_scopes jsonb;
BEGIN
  IF NOT whatsapp_hub.is_full_admin() THEN
    RAISE EXCEPTION 'Só um administrador pode editar perfis.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Dê um nome ao perfil.' USING ERRCODE = 'check_violation';
  END IF;
  -- Escopos válidos: own | team | all (o que vier diferente vira "all").
  SELECT COALESCE(jsonb_object_agg(k, CASE WHEN v IN ('own', 'team', 'all') THEN v ELSE 'all' END), '{}'::jsonb)
    INTO v_scopes
    FROM jsonb_each_text(COALESCE(p_scopes, '{}'::jsonb)) AS s(k, v)
   WHERE k IN ('inbox', 'deals', 'tasks', 'visits');

  IF v_id IS NULL THEN
    INSERT INTO whatsapp_hub.access_roles (org_id, name, description, scopes)
    VALUES (v_org, btrim(p_name), NULLIF(btrim(COALESCE(p_description, '')), ''),
            '{"inbox":"all","deals":"all","tasks":"all","visits":"all"}'::jsonb || v_scopes)
    RETURNING id INTO v_id;
    PERFORM whatsapp_hub._audit(v_org, 'role.created', 'role', v_id::text, NULL, format('Perfil %s criado', btrim(p_name)));
  ELSE
    SELECT * INTO v_role FROM whatsapp_hub.access_roles WHERE id = v_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Perfil não encontrado.' USING ERRCODE = 'no_data_found';
    END IF;
    -- Perfis do sistema mantêm o nome (o app e os convites procuram por ele).
    IF v_role.is_system AND v_role.name IS DISTINCT FROM btrim(p_name) THEN
      RAISE EXCEPTION 'Perfis padrão não podem ser renomeados. Duplique para criar um com outro nome.' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE whatsapp_hub.access_roles
       SET name = btrim(p_name),
           description = NULLIF(btrim(COALESCE(p_description, '')), ''),
           scopes = scopes || v_scopes
     WHERE id = v_id;
    IF v_role.name IS DISTINCT FROM btrim(p_name) OR v_role.scopes IS DISTINCT FROM (v_role.scopes || v_scopes) THEN
      PERFORM whatsapp_hub._audit(v_org, 'role.updated', 'role', v_id::text, NULL,
        format('Perfil %s alterado', btrim(p_name)),
        jsonb_build_object('old_name', v_role.name, 'scopes', v_role.scopes || v_scopes));
    END IF;
  END IF;

  -- Perfil com acesso total não usa matriz.
  IF EXISTS (SELECT 1 FROM whatsapp_hub.access_roles WHERE id = v_id AND is_admin) THEN
    RETURN v_id;
  END IF;

  SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_added
    FROM unnest(COALESCE(p_permissions, '{}')) k
   WHERE k IN (SELECT key FROM whatsapp_hub.permissions)
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.role_permissions WHERE role_id = v_id AND permission_key = k);
  SELECT COALESCE(array_agg(permission_key ORDER BY permission_key), '{}') INTO v_removed
    FROM whatsapp_hub.role_permissions
   WHERE role_id = v_id AND NOT (permission_key = ANY (COALESCE(p_permissions, '{}')));

  DELETE FROM whatsapp_hub.role_permissions WHERE role_id = v_id AND permission_key = ANY (v_removed);
  INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
  SELECT v_id, k FROM unnest(v_added) k ON CONFLICT DO NOTHING;

  IF cardinality(v_added) > 0 OR cardinality(v_removed) > 0 THEN
    PERFORM whatsapp_hub._audit(v_org, 'role.permissions_changed', 'role', v_id::text, NULL,
      format('Permissões do perfil %s: +%s / −%s', btrim(p_name), cardinality(v_added), cardinality(v_removed)),
      jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)));
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.duplicate_access_role(p_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_src whatsapp_hub.access_roles%ROWTYPE;
  v_new uuid;
BEGIN
  IF NOT whatsapp_hub.is_full_admin() THEN
    RAISE EXCEPTION 'Só um administrador pode duplicar perfis.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_src FROM whatsapp_hub.access_roles WHERE id = p_id AND org_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Perfil não encontrado.' USING ERRCODE = 'no_data_found'; END IF;
  -- A cópia nunca nasce com acesso total: copia a matriz (ou todas, se admin).
  INSERT INTO whatsapp_hub.access_roles (org_id, name, description, scopes)
  VALUES (v_org, btrim(p_name), v_src.description, v_src.scopes)
  RETURNING id INTO v_new;
  INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
  SELECT v_new, CASE WHEN v_src.is_admin THEN p.key END
    FROM whatsapp_hub.permissions p WHERE v_src.is_admin
  UNION ALL
  SELECT v_new, rp.permission_key FROM whatsapp_hub.role_permissions rp WHERE rp.role_id = p_id AND NOT v_src.is_admin;
  PERFORM whatsapp_hub._audit(v_org, 'role.created', 'role', v_new::text, NULL,
    format('Perfil %s criado (cópia de %s)', btrim(p_name), v_src.name));
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.delete_access_role(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_name text;
BEGIN
  IF NOT whatsapp_hub.is_full_admin() THEN
    RAISE EXCEPTION 'Só um administrador pode excluir perfis.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT name INTO v_name FROM whatsapp_hub.access_roles WHERE id = p_id AND org_id = v_org;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Perfil não encontrado.' USING ERRCODE = 'no_data_found'; END IF;
  DELETE FROM whatsapp_hub.access_roles WHERE id = p_id;   -- o guard barra sistema/em uso
  PERFORM whatsapp_hub._audit(v_org, 'role.deleted', 'role', p_id::text, NULL, format('Perfil %s excluído', v_name));
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Exceções por usuário (substitui o conjunto inteiro)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.set_user_overrides(p_user uuid, p_allow text[], p_deny text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_allow text[];
  v_deny text[];
BEGIN
  IF NOT whatsapp_hub.is_full_admin() THEN
    RAISE EXCEPTION 'Só um administrador pode alterar permissões individuais.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE user_id = p_user AND org_id = v_org) THEN
    RAISE EXCEPTION 'Usuário não encontrado.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT k), '{}') INTO v_allow FROM unnest(COALESCE(p_allow, '{}')) k
   WHERE k IN (SELECT key FROM whatsapp_hub.permissions);
  SELECT COALESCE(array_agg(DISTINCT k), '{}') INTO v_deny FROM unnest(COALESCE(p_deny, '{}')) k
   WHERE k IN (SELECT key FROM whatsapp_hub.permissions) AND NOT (k = ANY (v_allow));

  DELETE FROM whatsapp_hub.user_permission_overrides WHERE org_id = v_org AND user_id = p_user;
  INSERT INTO whatsapp_hub.user_permission_overrides (org_id, user_id, permission_key, effect)
  SELECT v_org, p_user, k, 'allow' FROM unnest(v_allow) k
  UNION ALL
  SELECT v_org, p_user, k, 'deny' FROM unnest(v_deny) k;

  PERFORM whatsapp_hub._audit(v_org, 'user.permissions_changed', 'user', p_user::text, p_user,
    format('Permissões individuais de %s: %s liberadas, %s bloqueadas',
           COALESCE(whatsapp_hub._user_label(p_user), p_user::text), cardinality(v_allow), cardinality(v_deny)),
    jsonb_build_object('allow', to_jsonb(v_allow), 'deny', to_jsonb(v_deny)));
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Login / logout (chamado pelo app logo após entrar/sair)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.log_access_event(p_action text, p_user_agent text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR p_action NOT IN ('auth.login', 'auth.logout') THEN
    RETURN;
  END IF;
  -- Evita spam: no máximo 1 registro do mesmo tipo por minuto por usuário.
  IF EXISTS (SELECT 1 FROM whatsapp_hub.access_audit_log
              WHERE actor_id = auth.uid() AND action = p_action AND created_at > now() - interval '1 minute') THEN
    RETURN;
  END IF;
  PERFORM whatsapp_hub._audit(v_org, p_action, 'auth', auth.uid()::text, auth.uid(),
    format('%s %s', COALESCE(whatsapp_hub._user_label(auth.uid()), 'Usuário'),
           CASE p_action WHEN 'auth.login' THEN 'entrou no sistema' ELSE 'saiu do sistema' END),
    jsonb_strip_nulls(jsonb_build_object('user_agent', left(p_user_agent, 300))));
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.save_access_role(uuid, text, text, jsonb, text[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.duplicate_access_role(uuid, text)                FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.delete_access_role(uuid)                         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.set_user_overrides(uuid, text[], text[])         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.log_access_event(text, text)                     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.save_access_role(uuid, text, text, jsonb, text[]) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.duplicate_access_role(uuid, text)                TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.delete_access_role(uuid)                         TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.set_user_overrides(uuid, text[], text[])         TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.log_access_event(text, text)                     TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.app_users; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
