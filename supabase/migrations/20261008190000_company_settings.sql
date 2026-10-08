-- Configurações › Empresas (08/10/2026)
-- Cadastro completo da empresa do grupo (fin_companies): geral, fiscal, padrões do Financeiro e de Compras,
-- e quem da equipe trabalha em cada empresa (empresa padrão do usuário).
-- SÓ ACRESCENTA colunas/tabela/funções: nada é apagado, nenhum dado muda.
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- ----------------------------------------------------------------------------
-- 1. Colunas novas da empresa
-- ----------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.fin_companies
  -- Geral (name = nome fantasia, como já era usado no sistema)
  ADD COLUMN IF NOT EXISTS legal_name              text CHECK (legal_name IS NULL OR length(legal_name) <= 200),
  ADD COLUMN IF NOT EXISTS person_type             text NOT NULL DEFAULT 'pj' CHECK (person_type IN ('pj', 'pf')),
  ADD COLUMN IF NOT EXISTS state_registration      text CHECK (state_registration IS NULL OR length(state_registration) <= 30),
  ADD COLUMN IF NOT EXISTS municipal_registration  text CHECK (municipal_registration IS NULL OR length(municipal_registration) <= 30),
  ADD COLUMN IF NOT EXISTS phone                   text CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$'),
  ADD COLUMN IF NOT EXISTS email                   text CHECK (email IS NULL OR (length(email) <= 160 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD COLUMN IF NOT EXISTS website                 text CHECK (website IS NULL OR length(website) <= 200),
  ADD COLUMN IF NOT EXISTS logo_url                text CHECK (logo_url IS NULL OR (length(logo_url) <= 500 AND logo_url ~ '^https://')),
  ADD COLUMN IF NOT EXISTS zip_code                text CHECK (zip_code IS NULL OR zip_code ~ '^[0-9]{8}$'),
  ADD COLUMN IF NOT EXISTS street                  text CHECK (street IS NULL OR length(street) <= 160),
  ADD COLUMN IF NOT EXISTS street_number           text CHECK (street_number IS NULL OR length(street_number) <= 20),
  ADD COLUMN IF NOT EXISTS complement              text CHECK (complement IS NULL OR length(complement) <= 80),
  ADD COLUMN IF NOT EXISTS district                text CHECK (district IS NULL OR length(district) <= 80),
  ADD COLUMN IF NOT EXISTS city                    text CHECK (city IS NULL OR length(city) <= 80),
  ADD COLUMN IF NOT EXISTS state                   text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS founded_on              date,
  ADD COLUMN IF NOT EXISTS legal_status            text CHECK (legal_status IS NULL OR length(legal_status) <= 40),
  ADD COLUMN IF NOT EXISTS notes                   text CHECK (notes IS NULL OR length(notes) <= 500),
  ADD COLUMN IF NOT EXISTS cnpj_data               jsonb CHECK (cnpj_data IS NULL OR (jsonb_typeof(cnpj_data) = 'object' AND pg_column_size(cnpj_data) <= 65536)),
  ADD COLUMN IF NOT EXISTS cnpj_checked_at         timestamptz,
  -- Fiscal
  ADD COLUMN IF NOT EXISTS tax_regime              text CHECK (tax_regime IS NULL OR tax_regime IN ('mei', 'simples', 'simples_excesso', 'presumido', 'real')),
  ADD COLUMN IF NOT EXISTS main_activity           text CHECK (main_activity IS NULL OR length(main_activity) <= 300),
  ADD COLUMN IF NOT EXISTS secondary_activities    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secondary_activities) = 'array' AND jsonb_array_length(secondary_activities) <= 100),
  ADD COLUMN IF NOT EXISTS service_code            text CHECK (service_code IS NULL OR length(service_code) <= 30),
  ADD COLUMN IF NOT EXISTS fiscal_env              text NOT NULL DEFAULT 'homologation' CHECK (fiscal_env IN ('production', 'homologation')),
  ADD COLUMN IF NOT EXISTS nfe_series              int CHECK (nfe_series IS NULL OR nfe_series BETWEEN 0 AND 999),
  ADD COLUMN IF NOT EXISTS nfce_series             int CHECK (nfce_series IS NULL OR nfce_series BETWEEN 0 AND 999),
  ADD COLUMN IF NOT EXISTS nfse_series             int CHECK (nfse_series IS NULL OR nfse_series BETWEEN 0 AND 999),
  ADD COLUMN IF NOT EXISTS tax_settings            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tax_settings) = 'object' AND pg_column_size(tax_settings) <= 16384),
  -- Padrões do Financeiro
  ADD COLUMN IF NOT EXISTS pix_key                 text CHECK (pix_key IS NULL OR length(pix_key) <= 120),
  ADD COLUMN IF NOT EXISTS default_account_id      uuid REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_cost_center_id  uuid REFERENCES whatsapp_hub.fin_cost_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_chart_account_id uuid REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_payment_method  text CHECK (default_payment_method IS NULL OR default_payment_method IN ('pix', 'boleto', 'transferencia', 'cartao', 'dinheiro', 'debito_automatico')),
  -- Padrões de Compras
  ADD COLUMN IF NOT EXISTS purchase_location_id    uuid REFERENCES whatsapp_hub.inv_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_cost_center_id uuid REFERENCES whatsapp_hub.fin_cost_centers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_chart_account_id uuid REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_account_id     uuid REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_requires_approval boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS purchase_limit_cents    bigint CHECK (purchase_limit_cents IS NULL OR purchase_limit_cents >= 0),
  ADD COLUMN IF NOT EXISTS purchase_manager_id     uuid,
  ADD COLUMN IF NOT EXISTS purchase_rules          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(purchase_rules) = 'object' AND pg_column_size(purchase_rules) <= 16384);

-- ----------------------------------------------------------------------------
-- 2. Gravação: só por RPC, com permissão por grupo de campos e referências da mesma org/empresa
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_company_update(p_id uuid, p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  c whatsapp_hub.fin_companies;
  n whatsapp_hub.fin_companies;
  k text;
  g_general text[] := ARRAY['name','legal_name','person_type','cnpj','state_registration','municipal_registration','phone','email','website',
    'logo_url','zip_code','street','street_number','complement','district','city','state','founded_on','legal_status','notes','cnpj_data',
    'cnpj_checked_at','is_active','is_default'];
  g_fiscal text[] := ARRAY['tax_regime','main_activity','secondary_activities','service_code','fiscal_env','nfe_series','nfce_series','nfse_series','tax_settings'];
  g_fin text[] := ARRAY['pix_key','default_account_id','default_cost_center_id','default_chart_account_id','default_payment_method'];
  g_pur text[] := ARRAY['purchase_location_id','purchase_cost_center_id','purchase_chart_account_id','purchase_account_id',
    'purchase_requires_approval','purchase_limit_cents','purchase_manager_id','purchase_rules'];
  v_clean jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p) <> 'object' THEN PERFORM whatsapp_hub.fin_fail('Dados inválidos.'); END IF;
  SELECT * INTO c FROM whatsapp_hub.fin_companies WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Empresa não encontrada.'); END IF;

  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k = ANY (g_general || g_fiscal || g_fin) THEN
      PERFORM whatsapp_hub.fin_require('financial.setup', 'alterar o cadastro da empresa');
    ELSIF k = ANY (g_pur) THEN
      PERFORM whatsapp_hub.fin_require('purchases.setup', 'alterar as regras de Compras da empresa');
    ELSE
      PERFORM whatsapp_hub.fin_fail(format('Campo desconhecido: %s', k));
    END IF;
    -- texto vazio = limpar o campo
    v_clean := v_clean || jsonb_build_object(k, CASE WHEN jsonb_typeof(p->k) = 'string' AND btrim(p->>k) = '' THEN 'null'::jsonb ELSE p->k END);
  END LOOP;

  -- Só dígitos nos documentos/telefone/CEP.
  FOREACH k IN ARRAY ARRAY['cnpj','phone','zip_code'] LOOP
    IF v_clean ? k AND jsonb_typeof(v_clean->k) = 'string' THEN
      v_clean := v_clean || jsonb_build_object(k, NULLIF(regexp_replace(v_clean->>k, '\D', '', 'g'), ''));
    END IF;
  END LOOP;
  IF v_clean ? 'state' AND jsonb_typeof(v_clean->'state') = 'string' THEN v_clean := v_clean || jsonb_build_object('state', upper(btrim(v_clean->>'state'))); END IF;
  IF v_clean ? 'name' AND length(btrim(COALESCE(v_clean->>'name', ''))) < 2 THEN PERFORM whatsapp_hub.fin_fail('Informe o nome fantasia.'); END IF;
  IF v_clean ? 'cnpj' AND v_clean->>'cnpj' IS NOT NULL AND length(v_clean->>'cnpj') NOT IN (11, 14) THEN
    PERFORM whatsapp_hub.fin_fail('CNPJ/CPF inválido.');
  END IF;
  IF v_clean ? 'cnpj' AND v_clean->>'cnpj' IS NOT NULL AND EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_companies WHERE org_id = v_org AND id <> p_id AND cnpj = v_clean->>'cnpj') THEN
    PERFORM whatsapp_hub.fin_fail('Já existe outra empresa com este CNPJ.');
  END IF;

  n := jsonb_populate_record(c, v_clean);
  IF n.email IS NOT NULL AND n.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN PERFORM whatsapp_hub.fin_fail('E-mail inválido.'); END IF;
  IF n.phone IS NOT NULL AND n.phone !~ '^[0-9]{10,13}$' THEN PERFORM whatsapp_hub.fin_fail('Telefone inválido: use DDD + número.'); END IF;
  IF n.zip_code IS NOT NULL AND n.zip_code !~ '^[0-9]{8}$' THEN PERFORM whatsapp_hub.fin_fail('CEP inválido: são 8 números.'); END IF;
  IF n.state IS NOT NULL AND n.state !~ '^[A-Z]{2}$' THEN PERFORM whatsapp_hub.fin_fail('UF inválida (ex.: AC).'); END IF;
  IF n.logo_url IS NOT NULL AND n.logo_url !~ '^https://' THEN PERFORM whatsapp_hub.fin_fail('Logo inválido.'); END IF;

  -- Referências: da mesma organização; banco/almoxarifado da própria empresa.
  IF n.default_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_accounts WHERE id = n.default_account_id AND org_id = v_org AND company_id = p_id) THEN
    PERFORM whatsapp_hub.fin_fail('A conta bancária padrão precisa ser desta empresa.');
  END IF;
  IF n.purchase_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_accounts WHERE id = n.purchase_account_id AND org_id = v_org AND company_id = p_id) THEN
    PERFORM whatsapp_hub.fin_fail('A conta financeira de Compras precisa ser desta empresa.');
  END IF;
  IF n.purchase_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.inv_locations WHERE id = n.purchase_location_id AND org_id = v_org AND (company_id IS NULL OR company_id = p_id)) THEN
    PERFORM whatsapp_hub.fin_fail('Almoxarifado inválido para esta empresa.');
  END IF;
  IF (n.default_cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_cost_centers WHERE id = n.default_cost_center_id AND org_id = v_org))
     OR (n.purchase_cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_cost_centers WHERE id = n.purchase_cost_center_id AND org_id = v_org)) THEN
    PERFORM whatsapp_hub.fin_fail('Centro de custo inválido.');
  END IF;
  IF (n.default_chart_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE id = n.default_chart_account_id AND org_id = v_org AND NOT is_synthetic))
     OR (n.purchase_chart_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE id = n.purchase_chart_account_id AND org_id = v_org AND NOT is_synthetic AND (type = 'expense' OR nature = 'deduction'))) THEN
    PERFORM whatsapp_hub.fin_fail('Conta do plano de contas inválida (escolha uma conta analítica).');
  END IF;
  IF n.purchase_manager_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE user_id = n.purchase_manager_id AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Responsável inválido.');
  END IF;

  UPDATE whatsapp_hub.fin_companies SET
    name = n.name, legal_name = n.legal_name, person_type = n.person_type, cnpj = n.cnpj, state_registration = n.state_registration,
    municipal_registration = n.municipal_registration, phone = n.phone, email = n.email, website = n.website, logo_url = n.logo_url,
    zip_code = n.zip_code, street = n.street, street_number = n.street_number, complement = n.complement, district = n.district,
    city = n.city, state = n.state, founded_on = n.founded_on, legal_status = n.legal_status, notes = n.notes, cnpj_data = n.cnpj_data,
    cnpj_checked_at = n.cnpj_checked_at, is_active = n.is_active, is_default = n.is_default,
    tax_regime = n.tax_regime, main_activity = n.main_activity, secondary_activities = COALESCE(n.secondary_activities, '[]'::jsonb),
    service_code = n.service_code, fiscal_env = COALESCE(n.fiscal_env, 'homologation'), nfe_series = n.nfe_series, nfce_series = n.nfce_series,
    nfse_series = n.nfse_series, tax_settings = COALESCE(n.tax_settings, '{}'::jsonb),
    pix_key = n.pix_key, default_account_id = n.default_account_id, default_cost_center_id = n.default_cost_center_id,
    default_chart_account_id = n.default_chart_account_id, default_payment_method = n.default_payment_method,
    purchase_location_id = n.purchase_location_id, purchase_cost_center_id = n.purchase_cost_center_id,
    purchase_chart_account_id = n.purchase_chart_account_id, purchase_account_id = n.purchase_account_id,
    purchase_requires_approval = COALESCE(n.purchase_requires_approval, true), purchase_limit_cents = n.purchase_limit_cents,
    purchase_manager_id = n.purchase_manager_id, purchase_rules = COALESCE(n.purchase_rules, '{}'::jsonb)
  WHERE id = p_id AND org_id = v_org;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_company_update(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_company_update(uuid, jsonb) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Quem trabalha em cada empresa (e a empresa padrão de cada usuário)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_company_users (
  org_id      uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_company_users_one_default ON whatsapp_hub.fin_company_users (org_id, user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS fin_company_users_user ON whatsapp_hub.fin_company_users (org_id, user_id);

ALTER TABLE whatsapp_hub.fin_company_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_company_users_select ON whatsapp_hub.fin_company_users;
CREATE POLICY fin_company_users_select ON whatsapp_hub.fin_company_users FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (user_id = auth.uid() OR whatsapp_hub.has_perm('users.view') OR whatsapp_hub.has_perm('financial.setup')));
GRANT SELECT ON whatsapp_hub.fin_company_users TO authenticated;
GRANT ALL ON whatsapp_hub.fin_company_users TO service_role;
-- Escrita só pela função abaixo (sem policy de INSERT/UPDATE/DELETE).

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_company_user_set(p_company uuid, p_user uuid, p_member boolean, p_default boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id();
BEGIN
  PERFORM whatsapp_hub.fin_require('users.edit', 'definir as empresas dos usuários');
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = p_company AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Empresa não encontrada.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users WHERE user_id = p_user AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Usuário não encontrado nesta organização.');
  END IF;
  IF NOT p_member THEN
    DELETE FROM whatsapp_hub.fin_company_users WHERE company_id = p_company AND user_id = p_user AND org_id = v_org;
    RETURN;
  END IF;
  IF p_default THEN
    UPDATE whatsapp_hub.fin_company_users SET is_default = false WHERE org_id = v_org AND user_id = p_user AND is_default AND company_id <> p_company;
  END IF;
  INSERT INTO whatsapp_hub.fin_company_users (org_id, company_id, user_id, is_default)
  VALUES (v_org, p_company, p_user, p_default)
  ON CONFLICT (company_id, user_id) DO UPDATE SET is_default = EXCLUDED.is_default;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_company_user_set(uuid, uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_company_user_set(uuid, uuid, boolean, boolean) TO authenticated, service_role;

-- Empresa padrão de quem está logado (para abrir os formulários já nela).
CREATE OR REPLACE FUNCTION whatsapp_hub.my_default_company()
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT cu.company_id FROM whatsapp_hub.fin_company_users cu
  JOIN whatsapp_hub.fin_companies c ON c.id = cu.company_id AND c.is_active
  WHERE cu.org_id = whatsapp_hub.current_org_id() AND cu.user_id = auth.uid() AND cu.is_default
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.my_default_company() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.my_default_company() TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. "Convite pendente" só para quem foi CONVIDADO por e-mail e ainda não entrou.
--    Quem se cadastrou pelo link já criou a senha: depois de aprovado é só entrar.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.list_members()
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
         (u.invited_at IS NOT NULL AND u.last_sign_in_at IS NULL), u.last_sign_in_at, au.created_at
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
