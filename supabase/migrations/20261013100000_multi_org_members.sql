-- ============================================================================
-- Mesmo usuário em várias organizações (13/10/2026)
-- ----------------------------------------------------------------------------
-- Antes: app_users tinha UNIQUE (user_id) — cada pessoa só podia estar em UMA
-- organização. Agora: UMA LINHA POR ORGANIZAÇÃO (UNIQUE user_id + org_id), cada
-- uma com o próprio perfil de acesso, equipe e status. A organização "em uso" continua
-- sendo a claim org_id do JWT; trocar de organização = switch_my_org() + refreshSession.
--
-- O que muda:
--  1. UNIQUE (user_id) → UNIQUE (user_id, org_id).
--  2. Funções que liam app_users só pelo user_id passam a filtrar a organização
--     (trecho trocado no texto ATUAL do banco — mudanças feitas em produção ficam).
--  3. current_org_active(): exige linha ATIVA do usuário na organização (antes bastava
--     não ter linha inativa — com várias orgs, quem foi tirado de uma ainda entraria).
--  4. my_orgs(), switch_my_org(org), org_add_member(email, perfil, …).
--  5. Trigger: desativado/removido da org em uso → o token passa para outra org ativa dele.
-- Idempotente. Roda inteiro ou nada (o SQL Editor executa tudo numa transação).
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;
SET lock_timeout = '5s';

-- Troca um trecho no texto atual da função. Já trocado = pula; trecho não achado = ERRO
-- (nada é aplicado e a mensagem diz qual função conferir).
CREATE OR REPLACE FUNCTION pg_temp._patch(p_fn regprocedure, p_old text, p_new text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef(p_fn);
  IF position(p_new in d) > 0 THEN RETURN; END IF;
  IF position(p_old in d) = 0 THEN
    RAISE EXCEPTION 'multi-org: trecho não encontrado em % → %', p_fn, left(p_old, 90);
  END IF;
  EXECUTE replace(d, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------- 1. UNIQUE
DO $$
DECLARE r record; v_att smallint;
BEGIN
  SELECT attnum INTO v_att FROM pg_attribute WHERE attrelid = 'whatsapp_hub.app_users'::regclass AND attname = 'user_id';
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'whatsapp_hub.app_users'::regclass AND contype = 'u' AND conkey = ARRAY[v_att]
  LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.app_users DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT i.indexrelid::regclass::text AS idx FROM pg_index i
            WHERE i.indrelid = 'whatsapp_hub.app_users'::regclass AND i.indisunique AND NOT i.indisprimary
              AND i.indkey::text = v_att::text
              AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
  LOOP
    EXECUTE format('DROP INDEX %s', r.idx);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'whatsapp_hub.app_users'::regclass AND conname = 'app_users_user_org_key') THEN
    ALTER TABLE whatsapp_hub.app_users ADD CONSTRAINT app_users_user_org_key UNIQUE (user_id, org_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS app_users_user_idx ON whatsapp_hub.app_users (user_id);

-- ---------------------------------------------------------------- 2. funções por organização
SELECT pg_temp._patch('whatsapp_hub.handle_new_user()',
  'ON CONFLICT (user_id) DO NOTHING', 'ON CONFLICT (user_id, org_id) DO NOTHING');

SELECT pg_temp._patch('whatsapp_hub._pur_can_approve(uuid, bigint)',
  'FROM whatsapp_hub.app_users WHERE user_id = auth.uid();',
  'FROM whatsapp_hub.app_users WHERE user_id = auth.uid() AND org_id = p_org;');

SELECT pg_temp._patch('whatsapp_hub._chat_notify_mentions()',
  'WHERE au.user_id = NEW.sender_id;',
  'WHERE au.user_id = NEW.sender_id AND au.org_id = NEW.org_id;');

SELECT pg_temp._patch('whatsapp_hub._chat_system_message(uuid, uuid, text)',
  'FROM whatsapp_hub.app_users WHERE user_id = p_actor;',
  'FROM whatsapp_hub.app_users WHERE user_id = p_actor AND org_id = v_org;');

SELECT pg_temp._patch('whatsapp_hub._user_label(uuid)',
  'LEFT JOIN whatsapp_hub.app_users au ON au.user_id = u.id',
  'LEFT JOIN whatsapp_hub.app_users au ON au.user_id = u.id AND au.org_id = COALESCE(whatsapp_hub.current_org_id(), au.org_id)');

SELECT pg_temp._patch('whatsapp_hub.chat_add_members(uuid, uuid[])',
  'JOIN whatsapp_hub.app_users au ON au.user_id = novos.user_id;',
  'JOIN whatsapp_hub.app_users au ON au.user_id = novos.user_id AND au.org_id = v_org;');

SELECT pg_temp._patch('whatsapp_hub.chat_list()',
  'JOIN whatsapp_hub.app_users au ON au.user_id = cm.user_id',
  'JOIN whatsapp_hub.app_users au ON au.user_id = cm.user_id AND au.org_id = cm.org_id');

SELECT pg_temp._patch('whatsapp_hub.chat_remove_member(uuid, uuid)',
  'FROM whatsapp_hub.app_users WHERE user_id = p_user;',
  'FROM whatsapp_hub.app_users WHERE user_id = p_user AND org_id = v_org;');

-- A senha é da conta (vale em todas as orgs): o UPDATE continua em todas as linhas.
SELECT pg_temp._patch('whatsapp_hub.clear_my_password_flag()',
  'FROM whatsapp_hub.app_users WHERE user_id = auth.uid();',
  'FROM whatsapp_hub.app_users WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id();');

SELECT pg_temp._patch('whatsapp_hub.owner_in_scope(text, uuid)',
  'WHERE me.user_id = auth.uid() AND me.team_id IS NOT NULL',
  'WHERE me.user_id = auth.uid() AND me.org_id = whatsapp_hub.current_org_id() AND me.team_id IS NOT NULL');

-- ---------------------------------------------------- 3. acesso exige linha ATIVA na org
SELECT pg_temp._patch('whatsapp_hub.current_org_active()',
  $old$OR NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.app_users
       WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id() AND status <> 'active'
    )$old$,
  $new$OR EXISTS (
      SELECT 1 FROM whatsapp_hub.app_users
       WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id() AND status = 'active'
    )$new$);

-- Desativados do jeito antigo (antes de 07/10 só bloqueava o login e o status ficava 'active'):
-- vira status 'inactive' de verdade. Assim, liberar o login dessa pessoa para OUTRA org
-- não devolve o acesso à org de onde ela foi tirada.
UPDATE whatsapp_hub.app_users au SET status = 'inactive'
  FROM auth.users u
 WHERE u.id = au.user_id AND au.status = 'active' AND u.banned_until > now();

-- Token apontando para uma org onde a pessoa não está ativa, mas ativa em outra:
-- passa a apontar para a outra (senão, com a regra acima, ela ficaria sem acesso).
UPDATE auth.users u
   SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object('org_id', a.org_id::text, 'role', a.role::text)
  FROM (SELECT DISTINCT ON (user_id) user_id, org_id, role
          FROM whatsapp_hub.app_users WHERE status = 'active'
         ORDER BY user_id, accepted_at NULLS LAST, org_id) a
 WHERE a.user_id = u.id
   AND COALESCE((u.raw_app_meta_data->>'is_super_admin')::boolean, false) = false
   AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users x
                    WHERE x.user_id = u.id AND x.status = 'active'
                      AND x.org_id::text = u.raw_app_meta_data->>'org_id');

-- ------------------------------------------------------- 4. trocar / listar / adicionar
-- Organizações em que eu estou ativo (seletor do topo e tela "Acesso desativado").
CREATE OR REPLACE FUNCTION whatsapp_hub.my_orgs()
RETURNS TABLE (id uuid, name text, is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT o.id, o.name, o.id = whatsapp_hub.current_org_id()
    FROM whatsapp_hub.app_users au
    JOIN whatsapp_hub.organizations o ON o.id = au.org_id
   WHERE au.user_id = auth.uid() AND au.status = 'active' AND o.status = 'active'
   ORDER BY o.name;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.my_orgs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.my_orgs() TO authenticated;

-- Trocar de organização (o navegador chama refreshSession depois para o token novo).
CREATE OR REPLACE FUNCTION whatsapp_hub.switch_my_org(p_org uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
DECLARE v_role whatsapp_hub.tenant_role; v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT au.role, o.name INTO v_role, v_name
    FROM whatsapp_hub.app_users au JOIN whatsapp_hub.organizations o ON o.id = au.org_id
   WHERE au.user_id = auth.uid() AND au.org_id = p_org AND au.status = 'active' AND o.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Você não tem acesso a esta organização.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('org_id', p_org::text, 'role', v_role::text)
   WHERE id = auth.uid();
  PERFORM whatsapp_hub._audit(p_org, 'auth.org_switch', 'auth', auth.uid()::text, auth.uid(),
    format('%s entrou na organização %s', COALESCE(whatsapp_hub._user_label(auth.uid()), 'Usuário'), v_name));
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.switch_my_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.switch_my_org(uuid) TO authenticated;

-- Dar acesso a esta organização para quem JÁ tem conta (o convite por e-mail recusa
-- "e-mail já cadastrado"). Mesmas regras do convite: users.create, perfil/equipe desta org,
-- perfil com acesso total só por administrador.
CREATE OR REPLACE FUNCTION whatsapp_hub.org_add_member(
  p_email text, p_access_role uuid, p_team uuid DEFAULT NULL,
  p_job_title text DEFAULT NULL, p_phone text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_user uuid; v_email text; v_is_admin boolean; v_role_name text;
  v_name text; v_avatar text; v_status text;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT whatsapp_hub.current_org_active() THEN
    RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT whatsapp_hub.has_perm('users.create') THEN
    RAISE EXCEPTION 'Seu perfil não tem permissão para esta ação.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT is_admin, name INTO v_is_admin, v_role_name FROM whatsapp_hub.access_roles WHERE id = p_access_role AND org_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Perfil inválido.' USING ERRCODE = 'check_violation'; END IF;
  IF v_is_admin AND NOT whatsapp_hub.is_full_admin() THEN
    RAISE EXCEPTION 'Só um administrador pode dar acesso de administrador.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_team IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.teams WHERE id = p_team AND org_id = v_org) THEN
    RAISE EXCEPTION 'Equipe inválida.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, email INTO v_user, v_email FROM auth.users WHERE lower(email) = lower(trim(p_email)) LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Não existe conta com esse e-mail.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT status INTO v_status FROM whatsapp_hub.app_users WHERE user_id = v_user AND org_id = v_org;
  IF FOUND THEN
    RAISE EXCEPTION 'Esta pessoa já faz parte desta organização (status: %).', v_status USING ERRCODE = 'unique_violation';
  END IF;

  -- Nome e foto vêm da organização de origem (a pessoa troca depois em Meu perfil).
  SELECT display_name, avatar_url INTO v_name, v_avatar FROM whatsapp_hub.app_users
   WHERE user_id = v_user ORDER BY (status = 'active') DESC, accepted_at NULLS LAST LIMIT 1;

  INSERT INTO whatsapp_hub.app_users
    (user_id, org_id, role, is_super_admin, accepted_at, status, access_role_id, team_id,
     job_title, phone, display_name, avatar_url, must_change_password)
  VALUES
    (v_user, v_org, CASE WHEN v_is_admin THEN 'admin' ELSE 'operator' END::whatsapp_hub.tenant_role, false, now(), 'active',
     p_access_role, p_team, NULLIF(trim(p_job_title), ''), NULLIF(trim(p_phone), ''), v_name, v_avatar, false);

  -- Conta bloqueada no login (desativada na única org que tinha): agora está ativa aqui.
  UPDATE auth.users SET banned_until = NULL WHERE id = v_user AND banned_until IS NOT NULL;

  PERFORM whatsapp_hub._audit(v_org, 'user.added', 'user', v_user::text, v_user,
    format('%s ganhou acesso a esta organização (já tinha conta) — perfil %s', v_email, v_role_name));
  RETURN v_user;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.org_add_member(text, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.org_add_member(text, uuid, uuid, text, text) TO authenticated;

-- ------------------------------------------------ 5. token acompanha as organizações ativas
-- Desativado/removido da org em uso → o token passa para outra org ativa da pessoa.
-- Ativado numa org enquanto o token aponta para uma org onde ela não está ativa → passa para esta.
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_follow_claim()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
DECLARE v_user uuid; v_claim text; v_super boolean; v_home text; v_to uuid; v_role whatsapp_hub.tenant_role;
BEGIN
  v_user := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  SELECT raw_app_meta_data->>'org_id', COALESCE((raw_app_meta_data->>'is_super_admin')::boolean, false), raw_app_meta_data->>'home_org_id'
    INTO v_claim, v_super, v_home FROM auth.users WHERE id = v_user;
  IF NOT FOUND OR v_super THEN RETURN NULL; END IF;  -- super admin troca pelo console

  IF TG_OP <> 'DELETE' AND NEW.status = 'active' THEN
    -- Token já aponta para uma org ativa dele: nada a fazer.
    IF EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE user_id = v_user AND status = 'active' AND org_id::text = v_claim) THEN
      RETURN NULL;
    END IF;
    v_to := NEW.org_id; v_role := NEW.role;
  ELSE
    IF v_claim IS DISTINCT FROM (CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END)::text THEN RETURN NULL; END IF;
    SELECT org_id, role INTO v_to, v_role FROM whatsapp_hub.app_users
     WHERE user_id = v_user AND status = 'active' AND org_id::text <> v_claim
     ORDER BY accepted_at NULLS LAST, org_id LIMIT 1;
    IF v_to IS NULL THEN RETURN NULL; END IF;  -- não tem outra: fica onde está (tela "Acesso desativado")
  END IF;

  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('org_id', v_to::text, 'role', v_role::text)
                           || CASE WHEN TG_OP = 'DELETE' AND v_home = OLD.org_id::text
                                   THEN jsonb_build_object('home_org_id', v_to::text) ELSE '{}'::jsonb END
   WHERE id = v_user;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._app_users_follow_claim() FROM PUBLIC, authenticated, anon;
DROP TRIGGER IF EXISTS trg_app_users_follow_claim ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_follow_claim
  AFTER INSERT OR DELETE OR UPDATE OF status ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_follow_claim();

NOTIFY pgrst, 'reload schema';

-- Conferência (uma linha): pessoas em mais de uma org e contas sem nenhuma org ativa.
SELECT
  (SELECT count(*) FROM (SELECT user_id FROM whatsapp_hub.app_users GROUP BY user_id HAVING count(*) > 1) x) AS pessoas_em_varias_orgs,
  (SELECT count(*) FROM whatsapp_hub.app_users) AS acessos_no_total,
  (SELECT count(*) FROM pg_constraint WHERE conname = 'app_users_user_org_key') = 1 AS regra_nova_ok;
