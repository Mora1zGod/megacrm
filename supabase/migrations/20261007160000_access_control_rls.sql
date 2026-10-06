-- ============================================================================
-- Controle de acesso — ETAPA 4: regras do banco (RLS) — 07/10/2026
-- ----------------------------------------------------------------------------
-- PARTE A — CORREÇÃO DE SEGURANÇA: tabelas com a policy "authenticated_all"
--   (USING true / CHECK true) liberavam leitura e escrita para QUALQUER usuário
--   logado de QUALQUER organização (tasks, api_keys, audit_log, quadros…).
--   Troca por regras presas à organização do usuário.
--
-- PARTE B — escrita passa a seguir as PERMISSÕES do perfil (has_perm) em vez
--   do papel fixo admin/operator, e leads / tarefas / agenda passam a respeitar
--   o ESCOPO do perfil (somente próprios / próprios + equipe / todos).
--   Os perfis padrão já foram montados para dar exatamente o acesso de antes:
--   Administrador = tudo; Atendimento = o que o operador fazia.
--
-- Edge Functions, IA e webhooks usam a service role (ignoram RLS) — não mudam.
-- Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

-- Org do usuário logado e ativa (o predicado padrão de todas as tabelas).
CREATE OR REPLACE FUNCTION whatsapp_hub.in_org(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT p_org = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
$$;

-- Registro do "dono" p_owner está no escopo do usuário? (escopo já resolvido)
-- own  = meu ou sem dono · team = + da minha equipe · all = tudo.
CREATE OR REPLACE FUNCTION whatsapp_hub.owner_in_scope(p_scope text, p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT CASE
    WHEN p_scope = 'all' OR p_scope IS NULL THEN true
    WHEN p_owner IS NULL OR p_owner = auth.uid() THEN true
    WHEN p_scope = 'team' THEN EXISTS (
      SELECT 1
        FROM whatsapp_hub.app_users me
        JOIN whatsapp_hub.app_users other ON other.team_id = me.team_id
       WHERE me.user_id = auth.uid() AND me.team_id IS NOT NULL
         AND other.user_id = p_owner AND other.org_id = me.org_id)
    ELSE false
  END
$$;

GRANT EXECUTE ON FUNCTION whatsapp_hub.in_org(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.owner_in_scope(text, uuid) TO authenticated, service_role;

-- ============================================================================
-- PARTE A — fim do "authenticated_all"
-- ============================================================================
DO $$
DECLARE
  t text;
  has_org boolean;
  has_board boolean;
  has_card boolean;
  has_checklist boolean;
  expr text;
BEGIN
  FOR t IN
    SELECT DISTINCT tablename FROM pg_policies
     WHERE schemaname = 'whatsapp_hub' AND policyname = 'authenticated_all'
  LOOP
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = t AND column_name = 'org_id') INTO has_org;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = t AND column_name = 'board_id') INTO has_board;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = t AND column_name = 'card_id') INTO has_card;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = t AND column_name = 'checklist_id') INTO has_checklist;

    IF has_org THEN
      expr := 'whatsapp_hub.in_org(org_id)';
    ELSIF has_board THEN
      expr := format('EXISTS (SELECT 1 FROM whatsapp_hub.boards b WHERE b.id = %I.board_id AND whatsapp_hub.in_org(b.org_id))', t);
    ELSIF has_card THEN
      expr := format('EXISTS (SELECT 1 FROM whatsapp_hub.board_cards c WHERE c.id = %I.card_id AND whatsapp_hub.in_org(c.org_id))', t);
    ELSIF has_checklist THEN
      expr := format('EXISTS (SELECT 1 FROM whatsapp_hub.card_checklists cl JOIN whatsapp_hub.board_cards c ON c.id = cl.card_id WHERE cl.id = %I.checklist_id AND whatsapp_hub.in_org(c.org_id))', t);
    ELSE
      RAISE NOTICE 'ATENCAO: % sem org_id/board_id/card_id — policy authenticated_all mantida, revisar manualmente', t;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS authenticated_all ON whatsapp_hub.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.%I', t);
    EXECUTE format('CREATE POLICY org_scoped_all ON whatsapp_hub.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)', t, expr, expr);
    RAISE NOTICE 'OK: % agora restrita à organização', t;
  END LOOP;
END $$;

-- api_keys: só o servidor usa (api/api-keys.ts e public-api com service role).
-- No navegador, só quem gerencia integrações enxerga — e ninguém escreve.
DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.api_keys;
DROP POLICY IF EXISTS api_keys_select ON whatsapp_hub.api_keys;
CREATE POLICY api_keys_select ON whatsapp_hub.api_keys
  FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('settings.integrations')));

-- audit_log (antigo): lê quem tem "Ver auditoria"; grava só em nome próprio.
DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.audit_log;
DROP POLICY IF EXISTS audit_log_select ON whatsapp_hub.audit_log;
DROP POLICY IF EXISTS audit_log_insert ON whatsapp_hub.audit_log;
CREATE POLICY audit_log_select ON whatsapp_hub.audit_log
  FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('audit.view')));
CREATE POLICY audit_log_insert ON whatsapp_hub.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND actor_id = auth.uid());

-- ai_usage_log: só o servidor grava (process-ai-message); a tela só lê.
DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.ai_usage_log;
DROP POLICY IF EXISTS ai_usage_log_select ON whatsapp_hub.ai_usage_log;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = 'ai_usage_log' AND column_name = 'org_id') THEN
    EXECUTE 'CREATE POLICY ai_usage_log_select ON whatsapp_hub.ai_usage_log FOR SELECT TO authenticated USING (whatsapp_hub.in_org(org_id))';
  END IF;
END $$;

-- ============================================================================
-- PARTE B — escrita por permissão
-- (SELECT has_perm(...)) = calculado 1x por consulta, não por linha.
-- ============================================================================

-- Recria a policy de escrita "X_admin_write" / "X_write" de uma tabela com a
-- permissão indicada (mesma regra de organização de antes).
CREATE OR REPLACE FUNCTION whatsapp_hub._set_write_policy(p_table text, p_old text, p_perms text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_perm_expr text;
BEGIN
  IF to_regclass('whatsapp_hub.' || p_table) IS NULL THEN
    RAISE NOTICE 'tabela % não existe — ignorada', p_table;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'whatsapp_hub' AND table_name = p_table AND column_name = 'org_id') THEN
    RAISE NOTICE 'tabela % sem org_id — mantida como está', p_table;
    RETURN;
  END IF;
  SELECT string_agg(format('(SELECT whatsapp_hub.has_perm(%L))', p), ' OR ') INTO v_perm_expr FROM unnest(p_perms) p;
  EXECUTE format('DROP POLICY IF EXISTS %I ON whatsapp_hub.%I', p_old, p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON whatsapp_hub.%I', p_table || '_perm_write', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON whatsapp_hub.%I FOR ALL TO authenticated USING (whatsapp_hub.in_org(org_id) AND (%s)) WITH CHECK (whatsapp_hub.in_org(org_id) AND (%s))',
    p_table || '_perm_write', p_table, v_perm_expr, v_perm_expr);
END;
$$;

-- Áreas que eram "só admin": agora pela permissão correspondente.
SELECT whatsapp_hub._set_write_policy('ai_agent_config',   'ai_agent_config_admin_write',   ARRAY['settings.ai']);
SELECT whatsapp_hub._set_write_policy('ai_agent_profiles', 'ai_agent_profiles_admin_write', ARRAY['settings.ai']);
SELECT whatsapp_hub._set_write_policy('ai_agent_media',    'ai_agent_media_admin_write',    ARRAY['settings.ai']);
SELECT whatsapp_hub._set_write_policy('knowledge_base',    'knowledge_base_admin_write',    ARRAY['settings.ai']);
SELECT whatsapp_hub._set_write_policy('knowledge_chunks',  'knowledge_chunks_admin_write',  ARRAY['settings.ai']);
SELECT whatsapp_hub._set_write_policy('app_settings',      'app_settings_admin_write',      ARRAY['settings.edit', 'settings.ai', 'financial.goals']);
SELECT whatsapp_hub._set_write_policy('channels',          'channels_admin_write',          ARRAY['settings.channels']);
SELECT whatsapp_hub._set_write_policy('campaigns',         'campaigns_admin_write',         ARRAY['campaigns.manage']);
SELECT whatsapp_hub._set_write_policy('campaign_contacts', 'campaign_contacts_admin_write', ARRAY['campaigns.manage']);
SELECT whatsapp_hub._set_write_policy('templates',         'templates_admin_write',         ARRAY['campaigns.manage']);
SELECT whatsapp_hub._set_write_policy('follow_up_rules',   'follow_up_rules_admin_write',   ARRAY['automations.manage', 'campaigns.manage']);
SELECT whatsapp_hub._set_write_policy('automation_flows',  'automation_flows_admin_write',  ARRAY['automations.manage']);
-- automation_flows já tem automation_flows_select; a regra genérica da Parte A sai.
DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.automation_flows;
SELECT whatsapp_hub._set_write_policy('funnel_automations','funnel_automations_admin_write',ARRAY['automations.manage']);
SELECT whatsapp_hub._set_write_policy('revenue_goals',     'revenue_goals_admin_write',     ARRAY['financial.goals']);
SELECT whatsapp_hub._set_write_policy('sales_records',     'sales_records_admin_write',     ARRAY['financial.edit', 'financial.goals']);
SELECT whatsapp_hub._set_write_policy('custom_fields',     'custom_fields_admin_write',     ARRAY['settings.edit']);
SELECT whatsapp_hub._set_write_policy('queues',            'queues_admin_write',            ARRAY['users.edit']);
SELECT whatsapp_hub._set_write_policy('queue_members',     'queue_members_admin_write',     ARRAY['users.edit']);
SELECT whatsapp_hub._set_write_policy('lead_assignment_queue', 'lead_assignment_queue_admin_write', ARRAY['users.edit']);
SELECT whatsapp_hub._set_write_policy('repurchase_config', 'repurchase_config_admin_write', ARRAY['automations.manage']);
SELECT whatsapp_hub._set_write_policy('deal_installments', 'deal_installments_operator_write', ARRAY['financial.create', 'financial.edit', 'financial.approve']);
SELECT whatsapp_hub._set_write_policy('campaign_segments', 'org_scoped_all',                ARRAY['campaigns.view']);

-- campaign_segments: a policy acima cobre escrita; leitura para a org toda.
DO $$
BEGIN
  IF to_regclass('whatsapp_hub.campaign_segments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'whatsapp_hub' AND table_name = 'campaign_segments' AND column_name = 'org_id') THEN
    EXECUTE 'DROP POLICY IF EXISTS campaign_segments_select ON whatsapp_hub.campaign_segments';
    EXECUTE 'CREATE POLICY campaign_segments_select ON whatsapp_hub.campaign_segments FOR SELECT TO authenticated USING (whatsapp_hub.in_org(org_id))';
  END IF;
END $$;

-- Equipe (app_users): editar quem tem "Editar usuário" (o trigger guard ainda
-- confere perfil/status com as permissões próprias); excluir só admin total.
DROP POLICY IF EXISTS app_users_admin_write ON whatsapp_hub.app_users;
DROP POLICY IF EXISTS app_users_manage_update ON whatsapp_hub.app_users;
DROP POLICY IF EXISTS app_users_admin_delete ON whatsapp_hub.app_users;
CREATE POLICY app_users_manage_update ON whatsapp_hub.app_users
  FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('users.edit') OR whatsapp_hub.has_perm('users.change_role') OR whatsapp_hub.has_perm('users.deactivate')))
  WITH CHECK (whatsapp_hub.in_org(org_id));
CREATE POLICY app_users_admin_delete ON whatsapp_hub.app_users
  FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.is_full_admin()));

-- ----------------------------------------------------------------------------
-- Contatos: criar / editar / excluir separados
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS contacts_write ON whatsapp_hub.contacts;
DROP POLICY IF EXISTS contacts_insert ON whatsapp_hub.contacts;
DROP POLICY IF EXISTS contacts_update ON whatsapp_hub.contacts;
DROP POLICY IF EXISTS contacts_delete ON whatsapp_hub.contacts;
CREATE POLICY contacts_insert ON whatsapp_hub.contacts FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('contacts.create') OR whatsapp_hub.has_perm('inbox.start') OR whatsapp_hub.has_perm('financial.create')));
CREATE POLICY contacts_update ON whatsapp_hub.contacts FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('contacts.edit') OR whatsapp_hub.has_perm('inbox.reply')))
  WITH CHECK (whatsapp_hub.in_org(org_id));
CREATE POLICY contacts_delete ON whatsapp_hub.contacts FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('contacts.delete')));

-- ----------------------------------------------------------------------------
-- Leads (deals): escopo na leitura + permissões na escrita.
-- "Dono" do lead = owner_id. Nova venda (financial.create) cria/atualiza lead.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON whatsapp_hub.deals;
DROP POLICY IF EXISTS deals_write ON whatsapp_hub.deals;
DROP POLICY IF EXISTS deals_insert ON whatsapp_hub.deals;
DROP POLICY IF EXISTS deals_update ON whatsapp_hub.deals;
DROP POLICY IF EXISTS deals_delete ON whatsapp_hub.deals;
CREATE POLICY deals_select ON whatsapp_hub.deals FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('deals')), owner_id));
CREATE POLICY deals_insert ON whatsapp_hub.deals FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('deals.create') OR whatsapp_hub.has_perm('financial.create')));
CREATE POLICY deals_update ON whatsapp_hub.deals FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id)
         AND whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('deals')), owner_id)
         AND (SELECT whatsapp_hub.has_perm('deals.edit') OR whatsapp_hub.has_perm('deals.move')
                  OR whatsapp_hub.has_perm('financial.create') OR whatsapp_hub.has_perm('financial.edit')))
  WITH CHECK (whatsapp_hub.in_org(org_id));
CREATE POLICY deals_delete ON whatsapp_hub.deals FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('deals.delete') OR whatsapp_hub.has_perm('financial.delete')));

-- ----------------------------------------------------------------------------
-- Tarefas: escopo (responsável) + permissões. A pessoa sempre vê as próprias.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS org_scoped_all ON whatsapp_hub.tasks;
DROP POLICY IF EXISTS tasks_select ON whatsapp_hub.tasks;
DROP POLICY IF EXISTS tasks_insert ON whatsapp_hub.tasks;
DROP POLICY IF EXISTS tasks_update ON whatsapp_hub.tasks;
DROP POLICY IF EXISTS tasks_delete ON whatsapp_hub.tasks;
CREATE POLICY tasks_select ON whatsapp_hub.tasks FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id)
         AND (assigned_to = auth.uid() OR created_by = auth.uid()
              OR whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('tasks')), assigned_to)));
CREATE POLICY tasks_insert ON whatsapp_hub.tasks FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id)
              AND (SELECT whatsapp_hub.has_perm('tasks.create'))
              -- atribuir para outra pessoa exige "Atribuir"
              AND (assigned_to IS NULL OR assigned_to = auth.uid() OR (SELECT whatsapp_hub.has_perm('tasks.assign'))));
CREATE POLICY tasks_update ON whatsapp_hub.tasks FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id)
         AND (assigned_to = auth.uid() OR created_by = auth.uid()
              OR whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('tasks')), assigned_to))
         AND (SELECT whatsapp_hub.has_perm('tasks.edit') OR whatsapp_hub.has_perm('tasks.complete')))
  WITH CHECK (whatsapp_hub.in_org(org_id));
CREATE POLICY tasks_delete ON whatsapp_hub.tasks FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('tasks.delete'))
         AND (assigned_to = auth.uid() OR created_by = auth.uid()
              OR whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('tasks')), assigned_to)));

-- ----------------------------------------------------------------------------
-- Agenda (park_visits): escopo pelo criador + permissões.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS park_visits_select ON whatsapp_hub.park_visits;
DROP POLICY IF EXISTS park_visits_write ON whatsapp_hub.park_visits;
DROP POLICY IF EXISTS park_visits_insert ON whatsapp_hub.park_visits;
DROP POLICY IF EXISTS park_visits_update ON whatsapp_hub.park_visits;
DROP POLICY IF EXISTS park_visits_delete ON whatsapp_hub.park_visits;
CREATE POLICY park_visits_select ON whatsapp_hub.park_visits FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('visits')), created_by));
CREATE POLICY park_visits_insert ON whatsapp_hub.park_visits FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('visits.create')));
CREATE POLICY park_visits_update ON whatsapp_hub.park_visits FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id)
         AND whatsapp_hub.owner_in_scope((SELECT whatsapp_hub.perm_scope('visits')), created_by)
         AND (SELECT whatsapp_hub.has_perm('visits.edit') OR whatsapp_hub.has_perm('visits.cancel')))
  WITH CHECK (whatsapp_hub.in_org(org_id));
CREATE POLICY park_visits_delete ON whatsapp_hub.park_visits FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (SELECT whatsapp_hub.has_perm('visits.cancel')));

-- ----------------------------------------------------------------------------
-- Lembretes: criar exige "Criar lembrete"; compartilhar exige "Compartilhar".
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS reminders_insert ON whatsapp_hub.reminders;
CREATE POLICY reminders_insert ON whatsapp_hub.reminders FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND created_by = auth.uid()
              AND (SELECT whatsapp_hub.has_perm('reminders.create'))
              AND (NOT shared OR (SELECT whatsapp_hub.has_perm('reminders.share'))));
DROP POLICY IF EXISTS reminders_update ON whatsapp_hub.reminders;
CREATE POLICY reminders_update ON whatsapp_hub.reminders FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND created_by = auth.uid())
  WITH CHECK (whatsapp_hub.in_org(org_id) AND created_by = auth.uid()
              AND (NOT shared OR (SELECT whatsapp_hub.has_perm('reminders.share'))));

DROP FUNCTION whatsapp_hub._set_write_policy(text, text, text[]);

-- ----------------------------------------------------------------------------
-- Verificação: nenhuma policy "libera tudo" pode sobrar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_policies
            WHERE schemaname = 'whatsapp_hub' AND (qual = 'true' OR with_check = 'true')
              AND tablename <> 'permissions'
  LOOP
    RAISE WARNING 'Ainda liberada para todos: %', r.tablename;
  END LOOP;
END $$;
