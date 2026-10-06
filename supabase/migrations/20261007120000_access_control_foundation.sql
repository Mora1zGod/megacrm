-- ============================================================================
-- Controle de acesso — ETAPA 1: base no banco (07/10/2026)
-- ----------------------------------------------------------------------------
-- Perfis de acesso por organização + catálogo de permissões + exceções por
-- usuário + equipes. NADA muda para quem já usa o CRM:
--   * todo admin atual  → perfil "Administrador" (acesso total);
--   * todo operador     → perfil "Atendimento" (o mesmo acesso de hoje).
-- As policies antigas (current_user_role() = 'admin') continuam valendo; a
-- troca para has_perm() é feita tabela por tabela na etapa 4.
--
-- Regra final:  permissão = perfil base + exceções ALLOW − exceções DENY.
-- Super admin e perfil com is_admin = acesso total (não dependem da matriz).
--
-- Também corrige: trocar o papel na tela Equipe não atualizava o JWT
-- (raw_app_meta_data.role), então o acesso real não mudava.
--
-- Idempotente: pode rodar mais de uma vez.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. Catálogo de permissões (global, igual para todas as orgs)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.permissions (
  key         text PRIMARY KEY,
  module      text NOT NULL,
  action      text NOT NULL,
  label       text NOT NULL,
  description text,
  sort        int  NOT NULL DEFAULT 0
);

INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  -- Tela inicial / visão geral
  ('dashboard.view',        'dashboard',   'view',         'Acessar a Visão geral', 100),
  -- Atendimento
  ('inbox.view',            'inbox',       'view',         'Acessar o Atendimento', 200),
  ('inbox.reply',           'inbox',       'reply',        'Responder conversa', 201),
  ('inbox.start',           'inbox',       'start',        'Iniciar conversa', 202),
  ('inbox.transfer',        'inbox',       'transfer',     'Transferir conversa', 203),
  ('inbox.close',           'inbox',       'close',        'Concluir conversa', 204),
  ('inbox.archive',         'inbox',       'archive',      'Arquivar conversa', 205),
  ('inbox.resume_ai',       'inbox',       'resume_ai',    'Pausar/retomar a IA', 206),
  -- Contatos
  ('contacts.view',         'contacts',    'view',         'Acessar Contatos', 300),
  ('contacts.create',       'contacts',    'create',       'Criar contato', 301),
  ('contacts.edit',         'contacts',    'edit',         'Editar contato', 302),
  ('contacts.delete',       'contacts',    'delete',       'Excluir contato', 303),
  ('contacts.export',       'contacts',    'export',       'Exportar contatos', 304),
  -- Leads / Funil
  ('deals.view',            'deals',       'view',         'Acessar o Funil', 400),
  ('deals.create',          'deals',       'create',       'Criar lead', 401),
  ('deals.edit',            'deals',       'edit',         'Editar lead', 402),
  ('deals.move',            'deals',       'move',         'Mover etapa', 403),
  ('deals.delete',          'deals',       'delete',       'Excluir lead', 404),
  -- Agenda / agendamentos
  ('visits.view',           'visits',      'view',         'Acessar a Agenda', 500),
  ('visits.create',         'visits',      'create',       'Criar agendamento', 501),
  ('visits.edit',           'visits',      'edit',         'Editar/remarcar agendamento', 502),
  ('visits.cancel',         'visits',      'cancel',       'Cancelar agendamento', 503),
  -- Tarefas
  ('tasks.view',            'tasks',       'view',         'Acessar Tarefas', 600),
  ('tasks.create',          'tasks',       'create',       'Criar tarefa', 601),
  ('tasks.edit',            'tasks',       'edit',         'Editar tarefa', 602),
  ('tasks.complete',        'tasks',       'complete',     'Concluir tarefa', 603),
  ('tasks.delete',          'tasks',       'delete',       'Excluir tarefa', 604),
  ('tasks.assign',          'tasks',       'assign',       'Atribuir para outra pessoa', 605),
  -- Lembretes
  ('reminders.view',        'reminders',   'view',         'Usar Lembretes', 700),
  ('reminders.create',      'reminders',   'create',       'Criar lembrete', 701),
  ('reminders.edit',        'reminders',   'edit',         'Editar lembrete', 702),
  ('reminders.delete',      'reminders',   'delete',       'Excluir lembrete', 703),
  ('reminders.share',       'reminders',   'share',        'Compartilhar com a equipe', 704),
  -- Campanhas
  ('campaigns.view',        'campaigns',   'view',         'Acessar Campanhas', 800),
  ('campaigns.manage',      'campaigns',   'manage',       'Criar e disparar campanhas/modelos', 801),
  -- Automações
  ('automations.view',      'automations', 'view',         'Acessar Automações', 850),
  ('automations.manage',    'automations', 'manage',       'Criar e editar automações', 851),
  -- Colaboração
  ('files.view',            'files',       'view',         'Acessar Arquivos', 900),
  ('chat.view',             'chat',        'view',         'Usar o Chat da equipe', 910),
  ('boards.view',           'boards',      'view',         'Acessar Quadros', 920),
  -- Financeiro (vendas, metas, parcelas, custos, painel TV)
  ('financial.view',        'financial',   'view',         'Ver vendas, metas e valores', 1000),
  ('financial.create',      'financial',   'create',       'Registrar venda', 1001),
  ('financial.edit',        'financial',   'edit',         'Editar venda/parcelas', 1002),
  ('financial.delete',      'financial',   'delete',       'Excluir venda', 1003),
  ('financial.approve',     'financial',   'approve',      'Dar baixa / aprovar pagamentos', 1004),
  ('financial.export',      'financial',   'export',       'Exportar financeiro', 1005),
  ('financial.goals',       'financial',   'goals',        'Definir metas e custos', 1006),
  ('financial.tv',          'financial',   'tv',           'Abrir o Painel TV', 1007),
  -- Relatórios
  ('reports.view',          'reports',     'view',         'Acessar Relatórios', 1100),
  ('reports.export',        'reports',     'export',       'Exportar relatórios', 1101),
  ('reports.financial',     'reports',     'financial',    'Ver dados financeiros nos relatórios', 1102),
  ('reports.productivity',  'reports',     'productivity', 'Ver produtividade da equipe', 1103),
  -- Equipe / usuários
  ('users.view',            'users',       'view',         'Ver usuários', 1200),
  ('users.create',          'users',       'create',       'Criar/convidar usuário', 1201),
  ('users.edit',            'users',       'edit',         'Editar usuário', 1202),
  ('users.deactivate',      'users',       'deactivate',   'Desativar/reativar usuário', 1203),
  ('users.change_role',     'users',       'change_role',  'Alterar perfil de acesso', 1204),
  ('users.permissions',     'users',       'permissions',  'Editar perfis e permissões', 1205),
  ('users.reset_password',  'users',       'reset_password','Resetar senha', 1206),
  ('audit.view',            'users',       'audit',        'Ver auditoria', 1207),
  -- Configurações
  ('settings.view',         'settings',    'view',         'Acessar Configurações', 1300),
  ('settings.edit',         'settings',    'edit',         'Alterar configurações gerais', 1301),
  ('settings.integrations', 'settings',    'integrations', 'Gerenciar integrações e API', 1302),
  ('settings.ai',           'settings',    'ai',           'Gerenciar a IA AMAIA', 1303),
  ('settings.channels',     'settings',    'channels',     'Gerenciar canais (números)', 1304)
ON CONFLICT (key) DO UPDATE
  SET module = EXCLUDED.module, action = EXCLUDED.action, label = EXCLUDED.label, sort = EXCLUDED.sort;

ALTER TABLE whatsapp_hub.permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permissions_read ON whatsapp_hub.permissions;
CREATE POLICY permissions_read ON whatsapp_hub.permissions
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON whatsapp_hub.permissions TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Perfis de acesso (por org) + permissões do perfil
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.access_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE
              DEFAULT whatsapp_hub.current_org_id(),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  is_system   boolean NOT NULL DEFAULT false,   -- criado pelo sistema (não exclui)
  is_admin    boolean NOT NULL DEFAULT false,   -- acesso total, ignora a matriz
  -- Escopo de visualização por módulo: own | team | all
  scopes      jsonb NOT NULL DEFAULT '{"inbox":"all","deals":"all","tasks":"all","visits":"all"}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS access_roles_org_idx ON whatsapp_hub.access_roles (org_id);

DROP TRIGGER IF EXISTS trg_access_roles_updated_at ON whatsapp_hub.access_roles;
CREATE TRIGGER trg_access_roles_updated_at
  BEFORE UPDATE ON whatsapp_hub.access_roles
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

CREATE TABLE IF NOT EXISTS whatsapp_hub.role_permissions (
  role_id        uuid NOT NULL REFERENCES whatsapp_hub.access_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES whatsapp_hub.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- ----------------------------------------------------------------------------
-- 3. Equipes / setores
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE
                  DEFAULT whatsapp_hub.current_org_id(),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  manager_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS teams_org_idx ON whatsapp_hub.teams (org_id);

-- ----------------------------------------------------------------------------
-- 4. app_users: colunas novas (todas opcionais / com default seguro)
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS job_title text;
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES whatsapp_hub.teams(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS access_role_id uuid REFERENCES whatsapp_hub.access_roles(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_status_check') THEN
    ALTER TABLE whatsapp_hub.app_users
      ADD CONSTRAINT app_users_status_check CHECK (status IN ('active', 'inactive', 'blocked'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS app_users_access_role_idx ON whatsapp_hub.app_users (access_role_id);
CREATE INDEX IF NOT EXISTS app_users_team_idx ON whatsapp_hub.app_users (team_id);

-- ----------------------------------------------------------------------------
-- 5. Exceções por usuário (ALLOW soma, DENY remove)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.user_permission_overrides (
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE
                 DEFAULT whatsapp_hub.current_org_id(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES whatsapp_hub.permissions(key) ON DELETE CASCADE,
  effect         text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_by     uuid DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, permission_key)
);

-- ----------------------------------------------------------------------------
-- 6. Perfis padrão (por org). Atendimento = exatamente o que o operador faz hoje.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.seed_access_roles(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  r record;
  v_role uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('Administrador',   'Acesso total à organização',            true,
         '{"inbox":"all","deals":"all","tasks":"all","visits":"all"}'::jsonb,
         ARRAY[]::text[]),
      ('Gerente',         'Atendimento, funil, financeiro e relatórios', false,
         '{"inbox":"all","deals":"all","tasks":"all","visits":"all"}'::jsonb,
         ARRAY['dashboard.view','inbox.%','contacts.%','deals.%','visits.%','tasks.%','reminders.%',
               'campaigns.view','automations.view','files.view','chat.view','boards.view',
               'financial.%','reports.%','users.view','audit.view','settings.view']),
      ('Supervisor',      'Coordena o atendimento da equipe',       false,
         '{"inbox":"team","deals":"team","tasks":"team","visits":"team"}'::jsonb,
         ARRAY['dashboard.view','inbox.%','contacts.view','contacts.create','contacts.edit','contacts.export',
               'deals.view','deals.create','deals.edit','deals.move','visits.%','tasks.%','reminders.%',
               'campaigns.view','files.view','chat.view','boards.view','financial.view','financial.create',
               'reports.view','reports.productivity','users.view','settings.view']),
      ('Atendimento',     'Atendimento, contatos, agenda e tarefas', false,
         '{"inbox":"own","deals":"all","tasks":"all","visits":"all"}'::jsonb,
         ARRAY['inbox.%','contacts.view','contacts.create','contacts.edit','contacts.delete','contacts.export',
               'deals.create','deals.edit','deals.move','visits.%','tasks.%','reminders.%',
               'campaigns.view','files.view','chat.view','boards.view','financial.create','settings.view']),
      ('Comercial',       'Vendas: funil, contatos e atendimento',  false,
         '{"inbox":"own","deals":"own","tasks":"own","visits":"all"}'::jsonb,
         ARRAY['inbox.%','contacts.view','contacts.create','contacts.edit','deals.view','deals.create',
               'deals.edit','deals.move','visits.%','tasks.%','reminders.%','chat.view','boards.view',
               'financial.create','settings.view']),
      ('Financeiro',      'Vendas, parcelas, metas e relatórios',   false,
         '{"inbox":"all","deals":"all","tasks":"own","visits":"all"}'::jsonb,
         ARRAY['dashboard.view','contacts.view','deals.view','financial.%','reports.%','tasks.%',
               'reminders.%','chat.view','files.view','settings.view']),
      ('Marketing',       'Campanhas, automações e contatos',        false,
         '{"inbox":"all","deals":"all","tasks":"own","visits":"all"}'::jsonb,
         ARRAY['dashboard.view','inbox.view','contacts.view','contacts.create','contacts.edit','contacts.export',
               'campaigns.%','automations.%','files.view','chat.view','boards.view','tasks.%','reminders.%',
               'reports.view','settings.view']),
      ('Operacional',     'Agenda do parque e tarefas',              false,
         '{"inbox":"own","deals":"own","tasks":"team","visits":"all"}'::jsonb,
         ARRAY['visits.%','tasks.%','reminders.%','contacts.view','chat.view','files.view','boards.view','settings.view']),
      ('Somente leitura', 'Só visualiza, não altera nada',           false,
         '{"inbox":"all","deals":"all","tasks":"all","visits":"all"}'::jsonb,
         ARRAY['dashboard.view','inbox.view','contacts.view','deals.view','visits.view','tasks.view',
               'reminders.view','campaigns.view','files.view','chat.view','boards.view','reports.view','settings.view'])
    ) AS t(name, description, is_admin, scopes, perms)
  LOOP
    INSERT INTO whatsapp_hub.access_roles (org_id, name, description, is_system, is_admin, scopes)
    VALUES (p_org, r.name, r.description, true, r.is_admin, r.scopes)
    ON CONFLICT (org_id, name) DO NOTHING
    RETURNING id INTO v_role;

    -- Só semeia as permissões quando o perfil acabou de ser criado (não
    -- sobrescreve ajustes que o admin já tenha feito).
    IF v_role IS NOT NULL AND array_length(r.perms, 1) IS NOT NULL THEN
      INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
      SELECT v_role, p.key
        FROM whatsapp_hub.permissions p
       WHERE EXISTS (SELECT 1 FROM unnest(r.perms) pat WHERE p.key LIKE pat)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_access_roles(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_access_roles(uuid) TO service_role;

-- Toda org existente recebe os perfis padrão.
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM whatsapp_hub.organizations LOOP
    PERFORM whatsapp_hub.seed_access_roles(o.id);
  END LOOP;
END $$;

-- Org nova também.
CREATE OR REPLACE FUNCTION whatsapp_hub._org_seed_access_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.seed_access_roles(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_org_seed_access_roles ON whatsapp_hub.organizations;
CREATE TRIGGER trg_org_seed_access_roles
  AFTER INSERT ON whatsapp_hub.organizations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_seed_access_roles();

-- Usuários atuais: admin → Administrador, operador → Atendimento.
UPDATE whatsapp_hub.app_users au
   SET access_role_id = ar.id
  FROM whatsapp_hub.access_roles ar
 WHERE au.access_role_id IS NULL
   AND ar.org_id = au.org_id
   AND ar.is_system
   AND ar.name = CASE WHEN au.role = 'admin' THEN 'Administrador' ELSE 'Atendimento' END;

-- ----------------------------------------------------------------------------
-- 7. Funções de autorização (camada única — usadas pelo RLS, pelas Edge
--    Functions e pelo frontend via my_permissions()).
-- ----------------------------------------------------------------------------

-- Usuário logado está ativo nesta org?
CREATE OR REPLACE FUNCTION whatsapp_hub.current_user_active()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT whatsapp_hub.is_super_admin() OR EXISTS (
    SELECT 1 FROM whatsapp_hub.app_users
     WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id() AND status = 'active'
  )
$$;

-- Acesso total? (super admin, perfil is_admin, ou admin legado sem perfil)
CREATE OR REPLACE FUNCTION whatsapp_hub.is_full_admin()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT whatsapp_hub.is_super_admin() OR EXISTS (
    SELECT 1
      FROM whatsapp_hub.app_users au
      LEFT JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
     WHERE au.user_id = auth.uid()
       AND au.org_id = whatsapp_hub.current_org_id()
       AND au.status = 'active'
       AND (ar.is_admin IS TRUE OR (au.access_role_id IS NULL AND au.role = 'admin'))
  )
$$;

-- Permissões efetivas de um usuário (perfil + allow − deny) dentro da org.
CREATE OR REPLACE FUNCTION whatsapp_hub.effective_permissions(p_user uuid, p_org uuid)
RETURNS SETOF text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  WITH me AS (
    SELECT au.access_role_id, au.role, au.status,
           COALESCE(ar.is_admin, au.access_role_id IS NULL AND au.role = 'admin') AS full_admin
      FROM whatsapp_hub.app_users au
      LEFT JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
     WHERE au.user_id = p_user AND au.org_id = p_org
  ),
  base AS (
    -- admin: tudo
    SELECT p.key FROM whatsapp_hub.permissions p, me WHERE me.full_admin
    UNION
    -- perfil do usuário (sem perfil e não-admin: usa o "Atendimento" da org)
    SELECT rp.permission_key
      FROM me
      JOIN whatsapp_hub.access_roles ar
        ON ar.id = COALESCE(me.access_role_id,
             (SELECT id FROM whatsapp_hub.access_roles
               WHERE org_id = p_org AND is_system AND name = 'Atendimento'))
      JOIN whatsapp_hub.role_permissions rp ON rp.role_id = ar.id
     WHERE NOT me.full_admin
  )
  SELECT key FROM (
    SELECT key FROM base
    UNION
    SELECT o.permission_key FROM whatsapp_hub.user_permission_overrides o, me
     WHERE o.user_id = p_user AND o.org_id = p_org AND o.effect = 'allow' AND NOT me.full_admin
  ) k
  WHERE EXISTS (SELECT 1 FROM me WHERE me.status = 'active')
    AND (
      (SELECT full_admin FROM me)
      OR NOT EXISTS (
        SELECT 1 FROM whatsapp_hub.user_permission_overrides d
         WHERE d.user_id = p_user AND d.org_id = p_org AND d.effect = 'deny' AND d.permission_key = k.key
      )
    )
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.effective_permissions(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.effective_permissions(uuid, uuid) TO service_role;

-- can(): o usuário logado tem a permissão? (para RLS e RPCs)
CREATE OR REPLACE FUNCTION whatsapp_hub.has_perm(p_key text)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT whatsapp_hub.is_super_admin()
      OR (whatsapp_hub.current_org_active() AND EXISTS (
            SELECT 1 FROM whatsapp_hub.effective_permissions(auth.uid(), whatsapp_hub.current_org_id()) k
             WHERE k = p_key))
$$;

-- Escopo de visualização do usuário logado num módulo: own | team | all.
CREATE OR REPLACE FUNCTION whatsapp_hub.perm_scope(p_module text)
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT CASE
    WHEN whatsapp_hub.is_full_admin() THEN 'all'
    ELSE COALESCE((
      SELECT ar.scopes->>p_module
        FROM whatsapp_hub.app_users au
        JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
       WHERE au.user_id = auth.uid() AND au.org_id = whatsapp_hub.current_org_id()
    ), 'all')
  END
$$;

-- Tudo que o frontend precisa numa chamada só.
CREATE OR REPLACE FUNCTION whatsapp_hub.my_permissions()
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT jsonb_build_object(
    'is_admin',    whatsapp_hub.is_full_admin(),
    'active',      whatsapp_hub.current_user_active(),
    'permissions', COALESCE((
       SELECT jsonb_agg(k ORDER BY k)
         FROM whatsapp_hub.effective_permissions(auth.uid(), whatsapp_hub.current_org_id()) k
     ), '[]'::jsonb),
    'scopes', jsonb_build_object(
       'inbox',  whatsapp_hub.perm_scope('inbox'),
       'deals',  whatsapp_hub.perm_scope('deals'),
       'tasks',  whatsapp_hub.perm_scope('tasks'),
       'visits', whatsapp_hub.perm_scope('visits')),
    'role', (SELECT jsonb_build_object('id', ar.id, 'name', ar.name)
               FROM whatsapp_hub.app_users au
               JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
              WHERE au.user_id = auth.uid() AND au.org_id = whatsapp_hub.current_org_id()),
    'team_id', (SELECT team_id FROM whatsapp_hub.app_users
                 WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id()),
    'must_change_password', COALESCE((SELECT must_change_password FROM whatsapp_hub.app_users
                 WHERE user_id = auth.uid() AND org_id = whatsapp_hub.current_org_id()), false)
  )
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.current_user_active() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.is_full_admin()       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.has_perm(text)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.perm_scope(text)      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.my_permissions()      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.current_user_active() TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.is_full_admin()       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.has_perm(text)        TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.perm_scope(text)      TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.my_permissions()      TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. RLS das tabelas novas
--    Gerenciar perfis/permissões/exceções = só quem tem ACESSO TOTAL (evita que
--    alguém com "Editar permissões" crie um perfil mais forte que o próprio).
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.access_roles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.role_permissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.teams                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.user_permission_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS access_roles_select ON whatsapp_hub.access_roles;
CREATE POLICY access_roles_select ON whatsapp_hub.access_roles
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

DROP POLICY IF EXISTS access_roles_write ON whatsapp_hub.access_roles;
CREATE POLICY access_roles_write ON whatsapp_hub.access_roles
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.is_full_admin())
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.is_full_admin());

DROP POLICY IF EXISTS role_permissions_select ON whatsapp_hub.role_permissions;
CREATE POLICY role_permissions_select ON whatsapp_hub.role_permissions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM whatsapp_hub.access_roles ar
                  WHERE ar.id = role_id AND ar.org_id = whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS role_permissions_write ON whatsapp_hub.role_permissions;
CREATE POLICY role_permissions_write ON whatsapp_hub.role_permissions
  FOR ALL TO authenticated
  USING (whatsapp_hub.is_full_admin() AND EXISTS (SELECT 1 FROM whatsapp_hub.access_roles ar
                  WHERE ar.id = role_id AND ar.org_id = whatsapp_hub.current_org_id()))
  WITH CHECK (whatsapp_hub.is_full_admin() AND EXISTS (SELECT 1 FROM whatsapp_hub.access_roles ar
                  WHERE ar.id = role_id AND ar.org_id = whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS teams_select ON whatsapp_hub.teams;
CREATE POLICY teams_select ON whatsapp_hub.teams
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

DROP POLICY IF EXISTS teams_write ON whatsapp_hub.teams;
CREATE POLICY teams_write ON whatsapp_hub.teams
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.has_perm('users.edit'))
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.has_perm('users.edit'));

DROP POLICY IF EXISTS overrides_select ON whatsapp_hub.user_permission_overrides;
CREATE POLICY overrides_select ON whatsapp_hub.user_permission_overrides
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id()
         AND (user_id = auth.uid() OR whatsapp_hub.has_perm('users.view')));

DROP POLICY IF EXISTS overrides_write ON whatsapp_hub.user_permission_overrides;
CREATE POLICY overrides_write ON whatsapp_hub.user_permission_overrides
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.is_full_admin())
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.is_full_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.access_roles              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.role_permissions          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.teams                     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.user_permission_overrides TO authenticated;
GRANT ALL ON whatsapp_hub.permissions, whatsapp_hub.access_roles, whatsapp_hub.role_permissions,
             whatsapp_hub.teams, whatsapp_hub.user_permission_overrides TO service_role;

-- Perfil do sistema não pode ser excluído; perfil em uso também não.
CREATE OR REPLACE FUNCTION whatsapp_hub._access_roles_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Perfil padrão do sistema não pode ser excluído.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE access_role_id = OLD.id) THEN
      RAISE EXCEPTION 'Perfil em uso: troque o perfil dos usuários antes de excluir.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- O "Administrador" do sistema continua sempre com acesso total.
  IF OLD.is_system AND OLD.is_admin AND NEW.is_admin IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'O perfil Administrador sempre tem acesso total.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Perfil não muda de organização.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_access_roles_guard ON whatsapp_hub.access_roles;
CREATE TRIGGER trg_access_roles_guard
  BEFORE UPDATE OR DELETE ON whatsapp_hub.access_roles
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._access_roles_guard();

-- ----------------------------------------------------------------------------
-- 9. app_users: guard anti-escalada (versão nova) + papel legado coerente
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_admin_role boolean;
BEGIN
  -- Perfil escolhido define o papel legado (admin/operator) usado pelas
  -- policies antigas: perfil com acesso total = admin, os demais = operator.
  IF NEW.access_role_id IS DISTINCT FROM OLD.access_role_id AND NEW.access_role_id IS NOT NULL THEN
    SELECT is_admin INTO v_admin_role FROM whatsapp_hub.access_roles
     WHERE id = NEW.access_role_id AND org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Perfil de acesso inválido para esta organização.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.role := CASE WHEN v_admin_role THEN 'admin' ELSE 'operator' END::whatsapp_hub.tenant_role;
  END IF;

  -- Status: carimba a data de desativação.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.deactivated_at := CASE WHEN NEW.status = 'active' THEN NULL ELSE now() END;
  END IF;

  -- Service role (sem JWT de usuário) passa direto.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Campo protegido de app_users só pode ser alterado pelo super admin.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Ninguém altera o próprio papel, perfil, status ou exigência de senha.
  IF NEW.user_id = auth.uid() AND (
       NEW.role IS DISTINCT FROM OLD.role
    OR NEW.access_role_id IS DISTINCT FROM OLD.access_role_id
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password AND NEW.must_change_password
  ) THEN
    RAISE EXCEPTION 'Você não pode alterar o próprio acesso.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Super admin só é mexido por super admin.
  IF OLD.is_super_admin AND NOT whatsapp_hub.is_super_admin() AND (
       NEW.role IS DISTINCT FROM OLD.role
    OR NEW.access_role_id IS DISTINCT FROM OLD.access_role_id
    OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'O acesso do super admin não pode ser alterado.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Trocar papel/perfil exige "Alterar perfil"; dar acesso total exige ser admin total.
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.access_role_id IS DISTINCT FROM OLD.access_role_id THEN
    IF NOT whatsapp_hub.has_perm('users.change_role') THEN
      RAISE EXCEPTION 'Sem permissão para alterar o perfil de acesso.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.role = 'admin' AND NOT whatsapp_hub.is_full_admin() THEN
      RAISE EXCEPTION 'Só um administrador pode dar acesso total.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Troca só do papel legado (tela Equipe antiga): alinha o perfil.
    IF NEW.access_role_id IS NOT DISTINCT FROM OLD.access_role_id AND NEW.role IS DISTINCT FROM OLD.role THEN
      SELECT id INTO NEW.access_role_id FROM whatsapp_hub.access_roles
       WHERE org_id = NEW.org_id AND is_system
         AND name = CASE WHEN NEW.role = 'admin' THEN 'Administrador' ELSE 'Atendimento' END;
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT whatsapp_hub.has_perm('users.deactivate') THEN
    RAISE EXCEPTION 'Sem permissão para desativar usuários.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_users_guard ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_guard
  BEFORE UPDATE ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_guard();

-- Usuário novo (convite) sem perfil: recebe o perfil padrão do papel.
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_default_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF NEW.access_role_id IS NULL AND NEW.org_id IS NOT NULL THEN
    SELECT id INTO NEW.access_role_id FROM whatsapp_hub.access_roles
     WHERE org_id = NEW.org_id AND is_system
       AND name = CASE WHEN NEW.role = 'admin' THEN 'Administrador' ELSE 'Atendimento' END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_app_users_default_role ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_default_role
  BEFORE INSERT ON whatsapp_hub.app_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_default_role();

-- CORREÇÃO: papel alterado → espelha no JWT (auth.users.raw_app_meta_data).
-- Vale no próximo refresh do token (até ~1h) ou ao sair e entrar de novo.
CREATE OR REPLACE FUNCTION whatsapp_hub._app_users_sync_jwt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                               || jsonb_build_object('role', NEW.role::text)
     WHERE id = NEW.user_id
       -- só a org "em uso" no token: super admin em suporte não é afetado
       AND COALESCE(raw_app_meta_data->>'org_id', NEW.org_id::text) = NEW.org_id::text;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_app_users_sync_jwt ON whatsapp_hub.app_users;
CREATE TRIGGER trg_app_users_sync_jwt
  AFTER UPDATE ON whatsapp_hub.app_users  -- sem "OF role": o papel também muda via trigger
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._app_users_sync_jwt();

-- Realtime: a tela de permissões atualiza sozinha.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.access_roles; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.role_permissions; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.user_permission_overrides; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
