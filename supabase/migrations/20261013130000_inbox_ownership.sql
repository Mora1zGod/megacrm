-- ============================================================================
-- Conversas separadas por responsável (13/10/2026)
-- ----------------------------------------------------------------------------
-- Antes: todo membro da org recebia TODAS as conversas e mensagens do banco; o escopo do perfil
-- ("Somente próprias / Equipe / Todas") só trancava a conversa na tela.
-- Agora a regra vale no banco (RLS):
--   * conversa SEM responsável → todo mundo vê (fila: quem assumir fica com ela);
--   * conversa COM responsável → só o responsável, a equipe dele (escopo "equipe") e quem vê todas;
--   * "ver todas": permissão nova inbox.view_all (por pessoa em Permissões individuais, ou no perfil)
--     — ou escopo "Todas" no perfil, ou perfil Administrador / super admin.
--   * mensagens seguem a conversa; aviso de mensagem nova vai só para o responsável (sem responsável:
--     para todos, como antes) e não vai mais para usuário desativado.
-- Policies RESTRICTIVE: somam-se às regras da org que já existem (não abrem nada novo).
-- Idempotente. Roda inteiro ou nada.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pg_temp._patch(p_fn regprocedure, p_old text, p_new text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef(p_fn);
  IF position(p_new in d) > 0 THEN RETURN; END IF;
  IF position(p_old in d) = 0 THEN
    RAISE EXCEPTION 'conversas: trecho não encontrado em % → %', p_fn, left(p_old, 90);
  END IF;
  EXECUTE replace(d, p_old, p_new);
END $$;

-- ------------------------------------------------------------------ permissão "ver todas"
INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('inbox.view_all', 'inbox', 'view_all', 'Ver as conversas de todos os responsáveis', 207)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- Perfil que já estava com escopo "Todas" nas conversas continua vendo tudo.
INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, 'inbox.view_all' FROM whatsapp_hub.access_roles ar
 WHERE NOT ar.is_admin AND COALESCE(ar.scopes->>'inbox', 'all') = 'all'
   AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.role_permissions rp WHERE rp.permission_key = 'inbox.view_all')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ escopo das conversas
-- 'all' | 'team' | 'own' do usuário logado na org em uso.
CREATE OR REPLACE FUNCTION whatsapp_hub.inbox_scope()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN 'all'
    WHEN whatsapp_hub.is_super_admin() OR whatsapp_hub.is_full_admin() OR whatsapp_hub.has_perm('inbox.view_all') THEN 'all'
    -- "Bloquear" o ver todas na pessoa vence o escopo "Todas" do perfil.
    WHEN EXISTS (SELECT 1 FROM whatsapp_hub.user_permission_overrides o
                  WHERE o.user_id = auth.uid() AND o.org_id = whatsapp_hub.current_org_id()
                    AND o.permission_key = 'inbox.view_all' AND o.effect = 'deny')
      THEN CASE WHEN whatsapp_hub.perm_scope('inbox') = 'team' THEN 'team' ELSE 'own' END
    ELSE COALESCE(whatsapp_hub.perm_scope('inbox'), 'own')
  END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.inbox_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_scope() TO authenticated, service_role;

-- Colegas da mesma equipe (para o escopo "equipe").
CREATE OR REPLACE FUNCTION whatsapp_hub.inbox_team_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT COALESCE(array_agg(o.user_id), '{}')
    FROM whatsapp_hub.app_users me
    JOIN whatsapp_hub.app_users o ON o.org_id = me.org_id AND o.team_id = me.team_id
   WHERE me.user_id = auth.uid() AND me.org_id = whatsapp_hub.current_org_id() AND me.team_id IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.inbox_team_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_team_ids() TO authenticated, service_role;

-- O front recebe o escopo efetivo (com o "ver todas").
SELECT pg_temp._patch('whatsapp_hub.my_permissions()',
  $o$'inbox',  whatsapp_hub.perm_scope('inbox'),$o$,
  $n$'inbox',  whatsapp_hub.inbox_scope(),$n$);

-- ------------------------------------------------------------------ regras no banco
-- (SELECT …) = calculado 1x por consulta, não por linha (ver 20261010090000_rls_fast.sql).
DROP POLICY IF EXISTS conversations_owner_scope_sel ON whatsapp_hub.conversations;
CREATE POLICY conversations_owner_scope_sel ON whatsapp_hub.conversations AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    assigned_to IS NULL
    OR assigned_to = (SELECT auth.uid())
    OR (SELECT whatsapp_hub.inbox_scope()) = 'all'
    OR ((SELECT whatsapp_hub.inbox_scope()) = 'team' AND assigned_to IN (SELECT unnest(whatsapp_hub.inbox_team_ids())))
  );
-- Alterar (assumir, transferir, encerrar…): só conversa que a pessoa enxerga. Transferir para outro é permitido.
DROP POLICY IF EXISTS conversations_owner_scope_upd ON whatsapp_hub.conversations;
CREATE POLICY conversations_owner_scope_upd ON whatsapp_hub.conversations AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (
    assigned_to IS NULL
    OR assigned_to = (SELECT auth.uid())
    OR (SELECT whatsapp_hub.inbox_scope()) = 'all'
    OR ((SELECT whatsapp_hub.inbox_scope()) = 'team' AND assigned_to IN (SELECT unnest(whatsapp_hub.inbox_team_ids())))
  )
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));
DROP POLICY IF EXISTS conversations_owner_scope_del ON whatsapp_hub.conversations;
CREATE POLICY conversations_owner_scope_del ON whatsapp_hub.conversations AS RESTRICTIVE
  FOR DELETE TO authenticated
  USING (
    assigned_to IS NULL
    OR assigned_to = (SELECT auth.uid())
    OR (SELECT whatsapp_hub.inbox_scope()) = 'all'
    OR ((SELECT whatsapp_hub.inbox_scope()) = 'team' AND assigned_to IN (SELECT unnest(whatsapp_hub.inbox_team_ids())))
  );

-- Mensagens: só de conversa que a pessoa enxerga (a subconsulta já passa pela regra acima).
DROP POLICY IF EXISTS messages_owner_scope ON whatsapp_hub.messages;
CREATE POLICY messages_owner_scope ON whatsapp_hub.messages AS RESTRICTIVE
  FOR ALL TO authenticated
  USING ((SELECT whatsapp_hub.inbox_scope()) = 'all' OR conversation_id IN (SELECT c.id FROM whatsapp_hub.conversations c))
  WITH CHECK ((SELECT whatsapp_hub.inbox_scope()) = 'all' OR conversation_id IN (SELECT c.id FROM whatsapp_hub.conversations c));

-- Atribuir / transferir / devolver para a fila. Pela tela direta o banco recusaria transferir para OUTRA
-- pessoa (a conversa sai da vista de quem transfere). Aqui: precisa enxergar a conversa; passar para outra
-- pessoa exige inbox.transfer e o destino ativo na org; assumir (para si) ou devolver para a fila não.
CREATE OR REPLACE FUNCTION whatsapp_hub.inbox_set_assignee(p_conversation uuid, p_to uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); v_cur uuid; v_scope text := whatsapp_hub.inbox_scope();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT whatsapp_hub.current_org_active() THEN
    RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT assigned_to INTO v_cur FROM whatsapp_hub.conversations WHERE id = p_conversation AND org_id = v_org;
  IF NOT FOUND OR NOT (
       v_cur IS NULL OR v_cur = auth.uid() OR v_scope = 'all'
       OR (v_scope = 'team' AND v_cur = ANY (whatsapp_hub.inbox_team_ids()))) THEN
    RAISE EXCEPTION 'Conversa não encontrada.' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_to IS NOT NULL AND p_to <> auth.uid() THEN
    IF NOT whatsapp_hub.has_perm('inbox.transfer') THEN
      RAISE EXCEPTION 'Seu perfil não pode transferir conversas.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE user_id = p_to AND org_id = v_org AND status = 'active') THEN
      RAISE EXCEPTION 'Essa pessoa não está ativa nesta organização.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE whatsapp_hub.conversations
     SET assigned_to = p_to, assigned_at = CASE WHEN p_to IS NULL THEN NULL ELSE now() END
   WHERE id = p_conversation;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.inbox_set_assignee(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_set_assignee(uuid, uuid) TO authenticated;

-- "Iniciar conversa" com um número que já está com outra pessoa: diz com quem (sem mostrar a conversa).
CREATE OR REPLACE FUNCTION whatsapp_hub.inbox_contact_owner(p_contact uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
  SELECT COALESCE(NULLIF(au.display_name, ''), split_part(u.email, '@', 1))
    FROM whatsapp_hub.conversations c
    JOIN whatsapp_hub.app_users au ON au.user_id = c.assigned_to AND au.org_id = c.org_id
    JOIN auth.users u ON u.id = c.assigned_to
   WHERE c.contact_id = p_contact
     AND c.org_id = whatsapp_hub.current_org_id()
     AND whatsapp_hub.current_org_active()
     AND c.assigned_to IS NOT NULL AND c.assigned_to <> auth.uid()
   ORDER BY c.last_message_at DESC NULLS LAST
   LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.inbox_contact_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_contact_owner(uuid) TO authenticated;

-- ------------------------------------------------------------------ avisos
-- Mensagem nova em conversa com responsável → aviso só para ele (antes ia para todos, com o texto).
SELECT pg_temp._patch('whatsapp_hub._on_inbound_notify()',
  $o$  PERFORM whatsapp_hub._fanout_notification(
    NEW.org_id,
    'new_message'::whatsapp_hub.notification_type,$o$,
  $n$  -- Conversa com responsável: só ele recebe (conversas separadas por responsável).
  IF EXISTS (SELECT 1 FROM whatsapp_hub.conversations WHERE id = NEW.conversation_id AND assigned_to IS NOT NULL) THEN
    INSERT INTO whatsapp_hub.notifications (org_id, user_id, type, conversation_id, message_id, title, body)
    SELECT NEW.org_id, conv.assigned_to, 'new_message'::whatsapp_hub.notification_type, NEW.conversation_id, NEW.id, title_txt, body_txt
      FROM whatsapp_hub.conversations conv WHERE conv.id = NEW.conversation_id;
    RETURN NEW;
  END IF;

  PERFORM whatsapp_hub._fanout_notification(
    NEW.org_id,
    'new_message'::whatsapp_hub.notification_type,$n$);

-- Aviso para "todos" não vai para quem está desativado/pendente.
SELECT pg_temp._patch('whatsapp_hub._fanout_notification(uuid, whatsapp_hub.notification_type, uuid, uuid, text, text)',
  $o$     AND u.role IN ('admin', 'operator');$o$,
  $n$     AND u.role IN ('admin', 'operator')
     AND u.status = 'active';$n$);

CREATE INDEX IF NOT EXISTS conversations_org_assigned_idx ON whatsapp_hub.conversations (org_id, assigned_to);

NOTIFY pgrst, 'reload schema';

-- Conferência: quem vê todas e quantas conversas têm dono.
SELECT
  (SELECT count(*) FROM whatsapp_hub.role_permissions WHERE permission_key = 'inbox.view_all') AS perfis_que_veem_todas,
  (SELECT count(*) FROM whatsapp_hub.conversations WHERE assigned_to IS NOT NULL) AS conversas_com_responsavel,
  (SELECT count(*) FROM whatsapp_hub.conversations WHERE assigned_to IS NULL) AS conversas_na_fila;
