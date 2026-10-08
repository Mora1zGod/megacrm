-- ============================================================================
-- Módulo FINANCEIRO (08/10/2026)
-- ----------------------------------------------------------------------------
-- Contas a pagar/receber, baixas, transferências, fechamento de período,
-- relatórios (agenda, fluxo, custos, DRE) e cobrança ASAAS — para um GRUPO com
-- várias empresas dentro da mesma organização (fin_companies).
--
-- Regras que não se negociam (garantidas AQUI, no banco):
--   * dinheiro em CENTAVOS (bigint) — nunca numeric/float;
--   * nada financeiro se apaga: DELETE bloqueado; cancelar exige motivo;
--     estorno é contra-lançamento (linha nova, a original continua visível);
--   * toda escrita de lançamento/baixa/transferência/fechamento passa por RPC
--     SECURITY DEFINER que confere a permissão (has_perm);
--   * trilha de auditoria (fin_audit_log): antes, depois, quem e quando;
--   * erros em português, dizendo o que fazer;
--   * "hoje" = dia em America/Sao_Paulo (fin_today()).
-- Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public, extensions;

-- ----------------------------------------------------------------------------
-- 0. Permissões (módulo "financial" = Financeiro na matriz de perfis).
--    Os perfis Gerente e Financeiro já recebem 'financial.%' em orgs novas.
-- ----------------------------------------------------------------------------
INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('financial.ledger_view',    'financial', 'ledger_view',    'Ver contas a pagar/receber, bancos e saldos', 1010),
  ('financial.ledger_create',  'financial', 'ledger_create',  'Lançar conta a pagar/receber', 1011),
  ('financial.ledger_edit',    'financial', 'ledger_edit',    'Editar lançamento (cabeçalho)', 1012),
  ('financial.ledger_settle',  'financial', 'ledger_settle',  'Dar baixa (pagar/receber)', 1013),
  ('financial.ledger_reverse', 'financial', 'ledger_reverse', 'Cancelar lançamento e estornar baixa', 1014),
  ('financial.transfer',       'financial', 'transfer',       'Transferir entre contas', 1015),
  ('financial.period_close',   'financial', 'period_close',   'Fechar e reabrir período', 1016),
  ('financial.setup',          'financial', 'setup',          'Cadastros financeiros (empresas, bancos, plano de contas…)', 1017),
  ('financial.ledger_reports', 'financial', 'ledger_reports', 'Relatórios financeiros (agenda, fluxo, custos, DRE)', 1018),
  ('financial.billing',        'financial', 'billing',        'Emitir e cancelar cobranças (ASAAS)', 1019)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- Orgs que já existem: Gerente e Financeiro ganham tudo do módulo novo.
INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, p.key
  FROM whatsapp_hub.access_roles ar
  JOIN whatsapp_hub.permissions p ON p.key IN (
    'financial.ledger_view','financial.ledger_create','financial.ledger_edit','financial.ledger_settle',
    'financial.ledger_reverse','financial.transfer','financial.period_close','financial.setup',
    'financial.ledger_reports','financial.billing')
 WHERE ar.name IN ('Gerente', 'Financeiro') AND ar.is_system
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. Utilitários
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_today()
RETURNS date
LANGUAGE sql STABLE
AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date $$;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_today() TO authenticated, service_role;

-- Erro "de operador": mensagem em português, sem detalhe técnico.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_fail(p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_msg; END $$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_require(p_key text, p_what text)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF; -- serviço (webhook) não passa por perfil
  IF NOT whatsapp_hub.has_perm(p_key) THEN
    PERFORM whatsapp_hub.fin_fail(format('Seu perfil não permite %s. Peça ao administrador para liberar.', p_what));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_brl(p_cents bigint)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_cents < 0 THEN '-' ELSE '' END || 'R$ ' ||
         replace(to_char(abs(p_cents) / 100, 'FM999G999G999G990'), ',', '.') || ',' ||
         lpad((abs(p_cents) % 100)::text, 2, '0')
$$;

-- ----------------------------------------------------------------------------
-- 2. Auditoria
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL,
  table_name  text NOT NULL,
  record_id   text,
  action      text NOT NULL,            -- INSERT | UPDATE
  before      jsonb,
  after       jsonb,
  actor_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_audit_org_idx ON whatsapp_hub.fin_audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fin_audit_record_idx ON whatsapp_hub.fin_audit_log (table_name, record_id);
ALTER TABLE whatsapp_hub.fin_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_audit_select ON whatsapp_hub.fin_audit_log;
CREATE POLICY fin_audit_select ON whatsapp_hub.fin_audit_log FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('audit.view') OR whatsapp_hub.has_perm('financial.ledger_view')));
GRANT SELECT ON whatsapp_hub.fin_audit_log TO authenticated;
GRANT ALL ON whatsapp_hub.fin_audit_log TO service_role;
GRANT USAGE ON SEQUENCE whatsapp_hub.fin_audit_log_id_seq TO service_role;

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
BEGIN
  IF TG_OP = 'UPDATE' AND v_new = v_old THEN RETURN NEW; END IF;
  INSERT INTO whatsapp_hub.fin_audit_log (org_id, table_name, record_id, action, before, after, actor_id)
  VALUES (COALESCE(v_new->>'org_id', v_old->>'org_id')::uuid, TG_TABLE_NAME,
          COALESCE(v_new->>'id', v_old->>'id', v_new->>'company_id'), TG_OP, v_old, v_new, auth.uid());
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'Registros financeiros não podem ser apagados. Use cancelar (com motivo), estornar ou desativar.';
END
$$;

-- ----------------------------------------------------------------------------
-- 3. Cadastros base
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) >= 2),
  cnpj        text,
  is_active   boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_companies_one_default ON whatsapp_hub.fin_companies (org_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id             uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  name                   text NOT NULL CHECK (length(btrim(name)) >= 2),
  kind                   text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'cash')),
  bank_name              text,
  agency                 text,
  account_number         text,
  opening_balance_cents  bigint NOT NULL DEFAULT 0,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_accounts_company_idx ON whatsapp_hub.fin_accounts (company_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_chart_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE RESTRICT,
  code         text NOT NULL CHECK (code ~ '^[0-9]+(\.[0-9]+)*$'),
  name         text NOT NULL CHECK (length(btrim(name)) >= 2),
  type         text NOT NULL CHECK (type IN ('revenue', 'expense')),
  nature       text NOT NULL CHECK (nature IN ('operating_revenue', 'deduction', 'cost', 'operating_expense', 'investment', 'financial', 'tax')),
  is_synthetic boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES whatsapp_hub.fin_cost_centers(id) ON DELETE RESTRICT,
  code       text,
  name       text NOT NULL CHECK (length(btrim(name)) >= 2),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_parties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  kind               text NOT NULL DEFAULT 'supplier' CHECK (kind IN ('supplier', 'customer', 'both')),
  name               text NOT NULL CHECK (length(btrim(name)) >= 2),
  doc                text CHECK (doc IS NULL OR doc ~ '^([0-9]{11}|[0-9]{14})$'),
  email              text,
  phone              text,
  asaas_customer_id  text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_parties_org_name_idx ON whatsapp_hub.fin_parties (org_id, name);

-- ----------------------------------------------------------------------------
-- 4. Lançamentos, parcelas, baixas, transferências, fechamento, anexos, cobranças
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('payable', 'receivable')),
  description        text NOT NULL CHECK (length(btrim(description)) >= 2),
  party_id           uuid REFERENCES whatsapp_hub.fin_parties(id) ON DELETE RESTRICT,
  chart_account_id   uuid NOT NULL REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE RESTRICT,
  cost_center_id     uuid REFERENCES whatsapp_hub.fin_cost_centers(id) ON DELETE RESTRICT,
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  issue_date         date NOT NULL,
  competence_date    date NOT NULL,
  installments_count int NOT NULL CHECK (installments_count BETWEEN 1 AND 36),
  notes              text CHECK (notes IS NULL OR length(notes) <= 500),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  cancel_reason      text,
  canceled_at        timestamptz,
  canceled_by        uuid,
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'purchase', 'hr', 'associates')),
  source_ref         text,
  created_by         uuid DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_entries_org_idx ON whatsapp_hub.fin_entries (org_id, company_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS fin_entries_source_ref ON whatsapp_hub.fin_entries (org_id, source, source_ref)
  WHERE source_ref IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_installments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL REFERENCES whatsapp_hub.fin_entries(id) ON DELETE RESTRICT,
  number       int NOT NULL CHECK (number >= 1),
  due_date     date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, number)
);
CREATE INDEX IF NOT EXISTS fin_installments_due_idx ON whatsapp_hub.fin_installments (org_id, due_date);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  installment_id  uuid NOT NULL REFERENCES whatsapp_hub.fin_installments(id) ON DELETE RESTRICT,
  entry_id        uuid NOT NULL REFERENCES whatsapp_hub.fin_entries(id) ON DELETE RESTRICT,
  account_id      uuid NOT NULL REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE RESTRICT,
  settle_date     date NOT NULL,
  amount_cents    bigint NOT NULL,          -- principal abatido da parcela (negativo no estorno)
  interest_cents  bigint NOT NULL DEFAULT 0,
  fine_cents      bigint NOT NULL DEFAULT 0,
  discount_cents  bigint NOT NULL DEFAULT 0,
  net_cents       bigint GENERATED ALWAYS AS (amount_cents + interest_cents + fine_cents - discount_cents) STORED,
  notes           text CHECK (notes IS NULL OR length(notes) <= 500),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'asaas')),
  charge_id       uuid,
  reversal_of     uuid REFERENCES whatsapp_hub.fin_settlements(id) ON DELETE RESTRICT,
  reversed_at     timestamptz,
  reversed_by     uuid,
  reverse_reason  text,
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_settlements_inst_idx ON whatsapp_hub.fin_settlements (installment_id);
CREATE INDEX IF NOT EXISTS fin_settlements_acc_idx ON whatsapp_hub.fin_settlements (account_id, settle_date);
CREATE UNIQUE INDEX IF NOT EXISTS fin_settlements_one_reversal ON whatsapp_hub.fin_settlements (reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  from_account_id  uuid NOT NULL REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE RESTRICT,
  to_account_id    uuid NOT NULL REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE RESTRICT,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  transfer_date    date NOT NULL,
  description      text,
  reversal_of      uuid REFERENCES whatsapp_hub.fin_transfers(id) ON DELETE RESTRICT,
  reversed_at      timestamptz,
  reversed_by      uuid,
  reverse_reason   text,
  created_by       uuid DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_transfers_one_reversal ON whatsapp_hub.fin_transfers (reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_period_locks (
  company_id    uuid PRIMARY KEY REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  org_id        uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  closed_until  date,
  last_reason   text,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_entry_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  entry_id    uuid NOT NULL REFERENCES whatsapp_hub.fin_entries(id) ON DELETE RESTRICT,
  file_path   text NOT NULL,
  file_name   text NOT NULL,
  size_bytes  bigint,
  uploaded_by uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.fin_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  installment_id   uuid NOT NULL REFERENCES whatsapp_hub.fin_installments(id) ON DELETE RESTRICT,
  entry_id         uuid NOT NULL REFERENCES whatsapp_hub.fin_entries(id) ON DELETE RESTRICT,
  account_id       uuid NOT NULL REFERENCES whatsapp_hub.fin_accounts(id) ON DELETE RESTRICT,
  provider         text NOT NULL DEFAULT 'asaas',
  provider_id      text,
  billing_type     text NOT NULL CHECK (billing_type IN ('BOLETO', 'PIX', 'UNDEFINED')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'paid', 'canceled', 'refund_requested', 'refunded', 'failed')),
  value_cents      bigint NOT NULL CHECK (value_cents > 0),
  due_date         date NOT NULL,
  invoice_url      text,
  bank_slip_url    text,
  pix_payload      text,
  settlement_id    uuid REFERENCES whatsapp_hub.fin_settlements(id) ON DELETE RESTRICT,
  last_event       text,
  error_message    text,
  created_by       uuid DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_charges_provider_id ON whatsapp_hub.fin_charges (provider, provider_id) WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_charges_one_open ON whatsapp_hub.fin_charges (installment_id)
  WHERE status IN ('pending', 'open');

-- updated_at
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_touch()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_companies','fin_accounts','fin_chart_accounts','fin_cost_centers','fin_parties','fin_entries','fin_charges'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_touch ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_touch()', t);
  END LOOP;
  -- auditoria em tudo
  FOREACH t IN ARRAY ARRAY['fin_companies','fin_accounts','fin_chart_accounts','fin_cost_centers','fin_parties','fin_entries',
                           'fin_installments','fin_settlements','fin_transfers','fin_period_locks','fin_entry_attachments','fin_charges'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_audit ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_audit AFTER INSERT OR UPDATE OR DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_audit()', t);
  END LOOP;
  -- nada financeiro se apaga
  FOREACH t IN ARRAY ARRAY['fin_companies','fin_entries','fin_installments','fin_settlements','fin_transfers',
                           'fin_period_locks','fin_entry_attachments','fin_charges','fin_audit_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_nodelete ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_nodelete BEFORE DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_no_delete()', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Regras dos cadastros (triggers)
-- ----------------------------------------------------------------------------
-- Empresa: sempre existe UMA padrão; a padrão não se desativa.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_companies_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  NEW.cnpj := NULLIF(regexp_replace(COALESCE(NEW.cnpj, ''), '\D', '', 'g'), '');
  IF NEW.cnpj IS NOT NULL AND length(NEW.cnpj) <> 14 THEN
    PERFORM whatsapp_hub.fin_fail('CNPJ deve ter 14 números.');
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.org_id := OLD.org_id; END IF;
  IF NEW.is_default AND NOT NEW.is_active THEN
    PERFORM whatsapp_hub.fin_fail('A empresa padrão não pode ser desativada. Marque outra como padrão antes.');
  END IF;
  IF current_setting('whatsapp_hub.fin_switch_default', true) = 'on' THEN
    RETURN NEW;  -- troca de padrão em andamento (a outra empresa está virando a padrão)
  END IF;
  IF NEW.is_default THEN
    PERFORM set_config('whatsapp_hub.fin_switch_default', 'on', true);
    UPDATE whatsapp_hub.fin_companies SET is_default = false WHERE org_id = NEW.org_id AND id <> NEW.id AND is_default;
    PERFORM set_config('whatsapp_hub.fin_switch_default', 'off', true);
  ELSIF TG_OP = 'UPDATE' AND OLD.is_default THEN
    PERFORM whatsapp_hub.fin_fail('Sempre precisa existir uma empresa padrão. Marque outra como padrão em vez de desmarcar esta.');
  ELSIF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE org_id = NEW.org_id AND is_default AND id <> NEW.id) THEN
    NEW.is_default := true;  -- a primeira vira a padrão
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_companies_guard ON whatsapp_hub.fin_companies;
CREATE TRIGGER trg_fin_companies_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.fin_companies
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_companies_guard();

-- Conta bancária/caixa: empresa da mesma org; com movimento não troca de empresa.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_accounts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.org_id := OLD.org_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = NEW.company_id AND org_id = NEW.org_id) THEN
    PERFORM whatsapp_hub.fin_fail('Escolha uma empresa do grupo para esta conta.');
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.opening_balance_cents <> OLD.opening_balance_cents)
     AND (EXISTS (SELECT 1 FROM whatsapp_hub.fin_settlements WHERE account_id = OLD.id)
       OR EXISTS (SELECT 1 FROM whatsapp_hub.fin_transfers WHERE from_account_id = OLD.id OR to_account_id = OLD.id)) THEN
    PERFORM whatsapp_hub.fin_fail('Esta conta já tem movimentação: não dá para trocar a empresa nem o saldo inicial. Crie uma conta nova se precisar.');
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_accounts_guard ON whatsapp_hub.fin_accounts;
CREATE TRIGGER trg_fin_accounts_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.fin_accounts
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_accounts_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_accounts_nodelete_used()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_settlements WHERE account_id = OLD.id)
     OR EXISTS (SELECT 1 FROM whatsapp_hub.fin_transfers WHERE from_account_id = OLD.id OR to_account_id = OLD.id)
     OR EXISTS (SELECT 1 FROM whatsapp_hub.fin_charges WHERE account_id = OLD.id) THEN
    PERFORM whatsapp_hub.fin_fail('Esta conta já tem movimentação e não pode ser excluída. Desative-a.');
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_accounts_nodelete ON whatsapp_hub.fin_accounts;
CREATE TRIGGER trg_fin_accounts_nodelete BEFORE DELETE ON whatsapp_hub.fin_accounts
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_accounts_nodelete_used();

-- Plano de contas: pai sintético do mesmo tipo e da mesma org; analítica com
-- lançamento não vira sintética.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_chart_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE p record;
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.org_id := OLD.org_id; END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM whatsapp_hub.fin_chart_accounts WHERE id = NEW.parent_id;
    IF NOT FOUND OR p.org_id <> NEW.org_id THEN PERFORM whatsapp_hub.fin_fail('Conta-pai inválida.'); END IF;
    IF NOT p.is_synthetic THEN PERFORM whatsapp_hub.fin_fail('A conta-pai precisa ser sintética (agrupadora).'); END IF;
    IF p.type <> NEW.type THEN PERFORM whatsapp_hub.fin_fail('A conta precisa ser do mesmo tipo (receita/despesa) da conta-pai.'); END IF;
    IF NEW.parent_id = NEW.id THEN PERFORM whatsapp_hub.fin_fail('Uma conta não pode ser pai dela mesma.'); END IF;
  END IF;
  IF NEW.is_synthetic AND EXISTS (SELECT 1 FROM whatsapp_hub.fin_entries WHERE chart_account_id = NEW.id) THEN
    PERFORM whatsapp_hub.fin_fail('Esta conta já tem lançamentos e precisa continuar analítica.');
  END IF;
  IF TG_OP = 'UPDATE' AND NOT NEW.is_synthetic AND OLD.is_synthetic
     AND EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE parent_id = NEW.id) THEN
    PERFORM whatsapp_hub.fin_fail('Esta conta agrupa outras contas e precisa continuar sintética.');
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_chart_guard ON whatsapp_hub.fin_chart_accounts;
CREATE TRIGGER trg_fin_chart_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.fin_chart_accounts
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_chart_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_cc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.org_id := OLD.org_id; END IF;
  IF NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR NOT EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_cost_centers WHERE id = NEW.parent_id AND org_id = NEW.org_id)) THEN
    PERFORM whatsapp_hub.fin_fail('Centro de custo-pai inválido.');
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_cc_guard ON whatsapp_hub.fin_cost_centers;
CREATE TRIGGER trg_fin_cc_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.fin_cost_centers
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_cc_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_parties_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.org_id := OLD.org_id; END IF;
  NEW.doc := NULLIF(regexp_replace(COALESCE(NEW.doc, ''), '\D', '', 'g'), '');
  IF NEW.doc IS NOT NULL AND length(NEW.doc) NOT IN (11, 14) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CPF deve ter 11 números e CNPJ 14 números.';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_fin_parties_guard ON whatsapp_hub.fin_parties;
CREATE TRIGGER trg_fin_parties_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.fin_parties
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_parties_guard();

-- ----------------------------------------------------------------------------
-- 6. RLS
--    Leitura: ledger_view. Cadastros: escrita com financial.setup.
--    Lançamentos/parcelas/baixas/transferências/fechamento/cobranças: SÓ por RPC.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_companies','fin_accounts','fin_chart_accounts','fin_cost_centers','fin_parties',
                           'fin_entries','fin_installments','fin_settlements','fin_transfers','fin_period_locks',
                           'fin_entry_attachments','fin_charges'] LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE POLICY %1$s_select ON whatsapp_hub.%1$s FOR SELECT TO authenticated
                    USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''financial.ledger_view''))', t);
    EXECUTE format('GRANT SELECT ON whatsapp_hub.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON whatsapp_hub.%I TO service_role', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['fin_companies','fin_accounts','fin_chart_accounts','fin_cost_centers','fin_parties'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON whatsapp_hub.%1$s FOR INSERT TO authenticated
                    WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''financial.setup''))', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE POLICY %1$s_update ON whatsapp_hub.%1$s FOR UPDATE TO authenticated
                    USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''financial.setup''))
                    WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''financial.setup''))', t);
    EXECUTE format('GRANT INSERT, UPDATE ON whatsapp_hub.%I TO authenticated', t);
  END LOOP;
  -- Exclusão só de cadastro nunca usado (FK RESTRICT + triggers barram o resto).
  FOREACH t IN ARRAY ARRAY['fin_accounts','fin_chart_accounts','fin_cost_centers','fin_parties'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON whatsapp_hub.%1$s FOR DELETE TO authenticated
                    USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''financial.setup''))', t);
    EXECUTE format('GRANT DELETE ON whatsapp_hub.%I TO authenticated', t);
  END LOOP;
  -- Pessoas: quem lança pode cadastrar fornecedor/cliente na hora.
  DROP POLICY IF EXISTS fin_parties_insert ON whatsapp_hub.fin_parties;
  CREATE POLICY fin_parties_insert ON whatsapp_hub.fin_parties FOR INSERT TO authenticated
    WITH CHECK (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('financial.setup') OR whatsapp_hub.has_perm('financial.ledger_create')));
END $$;

-- Anexos: quem lança/edita pode anexar (só acrescenta, não apaga).
DROP POLICY IF EXISTS fin_entry_attachments_insert ON whatsapp_hub.fin_entry_attachments;
CREATE POLICY fin_entry_attachments_insert ON whatsapp_hub.fin_entry_attachments FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id)
    AND (whatsapp_hub.has_perm('financial.ledger_create') OR whatsapp_hub.has_perm('financial.ledger_edit'))
    AND EXISTS (SELECT 1 FROM whatsapp_hub.fin_entries e WHERE e.id = entry_id AND e.org_id = org_id));
GRANT INSERT ON whatsapp_hub.fin_entry_attachments TO authenticated;

-- Bucket privado dos anexos: <org_id>/<entry_id>/<arquivo>.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-hub-finance', 'whatsapp-hub-finance', false, 20971520)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS fin_files_select ON storage.objects;
CREATE POLICY fin_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'whatsapp-hub-finance'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.has_perm('financial.ledger_view'));
DROP POLICY IF EXISTS fin_files_insert ON storage.objects;
CREATE POLICY fin_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'whatsapp-hub-finance'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND (whatsapp_hub.has_perm('financial.ledger_create') OR whatsapp_hub.has_perm('financial.ledger_edit')));

-- ----------------------------------------------------------------------------
-- 7. Visões (security_invoker: respeitam a RLS de quem consulta)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW whatsapp_hub.fin_installments_v
WITH (security_invoker = true) AS
SELECT
  i.id, i.org_id, i.entry_id, i.number, i.due_date, i.amount_cents,
  e.kind, e.company_id, c.name AS company_name, e.description, e.party_id, p.name AS party_name,
  e.chart_account_id, ca.code AS chart_code, ca.name AS chart_name, e.cost_center_id, cc.name AS cost_center_name,
  e.installments_count, e.competence_date, e.issue_date, e.status AS entry_status, e.total_cents,
  COALESCE(s.paid, 0)::bigint AS paid_cents,
  CASE WHEN e.status = 'canceled' THEN 0 ELSE GREATEST(i.amount_cents - COALESCE(s.paid, 0), 0) END::bigint AS remaining_cents,
  s.last_settle_date,
  CASE
    WHEN e.status = 'canceled' THEN 'canceled'
    WHEN COALESCE(s.paid, 0) >= i.amount_cents THEN 'paid'
    WHEN i.due_date < whatsapp_hub.fin_today() THEN 'overdue'
    WHEN COALESCE(s.paid, 0) > 0 THEN 'partial'
    ELSE 'open'
  END AS status,
  (COALESCE(s.paid, 0) > 0 AND COALESCE(s.paid, 0) < i.amount_cents) AS is_partial,
  ch.id AS charge_id, ch.status AS charge_status, ch.billing_type AS charge_type, ch.invoice_url AS charge_url
FROM whatsapp_hub.fin_installments i
JOIN whatsapp_hub.fin_entries e ON e.id = i.entry_id
JOIN whatsapp_hub.fin_companies c ON c.id = e.company_id
JOIN whatsapp_hub.fin_chart_accounts ca ON ca.id = e.chart_account_id
LEFT JOIN whatsapp_hub.fin_parties p ON p.id = e.party_id
LEFT JOIN whatsapp_hub.fin_cost_centers cc ON cc.id = e.cost_center_id
LEFT JOIN LATERAL (
  SELECT sum(st.amount_cents) AS paid, max(st.settle_date) FILTER (WHERE st.reversal_of IS NULL AND st.reversed_at IS NULL) AS last_settle_date
    FROM whatsapp_hub.fin_settlements st WHERE st.installment_id = i.id
) s ON true
LEFT JOIN LATERAL (
  SELECT x.id, x.status, x.billing_type, x.invoice_url FROM whatsapp_hub.fin_charges x
   WHERE x.installment_id = i.id ORDER BY x.created_at DESC LIMIT 1
) ch ON true;
GRANT SELECT ON whatsapp_hub.fin_installments_v TO authenticated, service_role;

-- Movimentos de caixa (baixas e transferências), com sinal: + entra, − sai.
CREATE OR REPLACE VIEW whatsapp_hub.fin_movements_v
WITH (security_invoker = true) AS
SELECT s.org_id, s.account_id, a.company_id, s.settle_date AS move_date,
       CASE WHEN e.kind = 'receivable' THEN s.net_cents ELSE -s.net_cents END AS signed_cents,
       CASE WHEN s.reversal_of IS NOT NULL THEN 'settlement_reversal' ELSE 'settlement' END AS origin,
       s.id AS ref_id, e.id AS entry_id, e.description, e.kind, s.created_at
  FROM whatsapp_hub.fin_settlements s
  JOIN whatsapp_hub.fin_entries e ON e.id = s.entry_id
  JOIN whatsapp_hub.fin_accounts a ON a.id = s.account_id
UNION ALL
SELECT t.org_id, t.from_account_id, a.company_id, t.transfer_date, -t.amount_cents,
       CASE WHEN t.reversal_of IS NOT NULL THEN 'transfer_reversal_out' ELSE 'transfer_out' END,
       t.id, NULL, COALESCE(t.description, 'Transferência'), NULL, t.created_at
  FROM whatsapp_hub.fin_transfers t JOIN whatsapp_hub.fin_accounts a ON a.id = t.from_account_id
UNION ALL
SELECT t.org_id, t.to_account_id, a.company_id, t.transfer_date, t.amount_cents,
       CASE WHEN t.reversal_of IS NOT NULL THEN 'transfer_reversal_in' ELSE 'transfer_in' END,
       t.id, NULL, COALESCE(t.description, 'Transferência'), NULL, t.created_at
  FROM whatsapp_hub.fin_transfers t JOIN whatsapp_hub.fin_accounts a ON a.id = t.to_account_id;
GRANT SELECT ON whatsapp_hub.fin_movements_v TO authenticated, service_role;

CREATE OR REPLACE VIEW whatsapp_hub.fin_account_balances_v
WITH (security_invoker = true) AS
SELECT a.id, a.org_id, a.company_id, c.name AS company_name, a.name, a.kind, a.bank_name, a.agency, a.account_number,
       a.opening_balance_cents, a.is_active,
       (a.opening_balance_cents + COALESCE(m.total, 0))::bigint AS balance_cents,
       COALESCE(m.cnt, 0) AS movements_count
  FROM whatsapp_hub.fin_accounts a
  JOIN whatsapp_hub.fin_companies c ON c.id = a.company_id
  LEFT JOIN LATERAL (
    SELECT sum(mv.signed_cents) AS total, count(*) AS cnt FROM whatsapp_hub.fin_movements_v mv WHERE mv.account_id = a.id
  ) m ON true;
GRANT SELECT ON whatsapp_hub.fin_account_balances_v TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Período fechado
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_assert_open(p_company uuid, p_date date, p_what text)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_until date;
BEGIN
  SELECT closed_until INTO v_until FROM whatsapp_hub.fin_period_locks WHERE company_id = p_company;
  IF v_until IS NOT NULL AND p_date <= v_until THEN
    PERFORM whatsapp_hub.fin_fail(format(
      'O financeiro desta empresa está fechado até %s. Não dá para %s com data %s. Use uma data posterior ou peça para reabrir o período.',
      to_char(v_until, 'DD/MM/YYYY'), p_what, to_char(p_date, 'DD/MM/YYYY')));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_close_period(p_company uuid, p_until date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); v_cur date;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.period_close', 'fechar o período');
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = p_company AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Escolha uma empresa do grupo.');
  END IF;
  IF p_until IS NULL OR p_until >= whatsapp_hub.fin_today() THEN
    PERFORM whatsapp_hub.fin_fail('Só dá para fechar até ontem ou antes.');
  END IF;
  SELECT closed_until INTO v_cur FROM whatsapp_hub.fin_period_locks WHERE company_id = p_company;
  IF v_cur IS NOT NULL AND p_until <= v_cur THEN
    PERFORM whatsapp_hub.fin_fail(format('O período já está fechado até %s. Para voltar a data, use "Reabrir período".', to_char(v_cur, 'DD/MM/YYYY')));
  END IF;
  INSERT INTO whatsapp_hub.fin_period_locks (company_id, org_id, closed_until, last_reason, updated_by, updated_at)
  VALUES (p_company, v_org, p_until, 'Fechamento', auth.uid(), now())
  ON CONFLICT (company_id) DO UPDATE SET closed_until = EXCLUDED.closed_until, last_reason = 'Fechamento',
    updated_by = EXCLUDED.updated_by, updated_at = now();
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_reopen_period(p_company uuid, p_until date, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_cur date;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.period_close', 'reabrir o período');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    PERFORM whatsapp_hub.fin_fail('Informe o motivo da reabertura (pelo menos 5 letras).');
  END IF;
  SELECT closed_until INTO v_cur FROM whatsapp_hub.fin_period_locks
   WHERE company_id = p_company AND org_id = whatsapp_hub.current_org_id();
  IF v_cur IS NULL THEN PERFORM whatsapp_hub.fin_fail('O período desta empresa não está fechado.'); END IF;
  IF p_until IS NOT NULL AND p_until >= v_cur THEN
    PERFORM whatsapp_hub.fin_fail('Para reabrir, escolha uma data ANTERIOR ao fechamento atual (ou deixe em branco para reabrir tudo).');
  END IF;
  UPDATE whatsapp_hub.fin_period_locks
     SET closed_until = p_until, last_reason = 'Reabertura: ' || btrim(p_reason), updated_by = auth.uid(), updated_at = now()
   WHERE company_id = p_company;
END
$$;

-- ----------------------------------------------------------------------------
-- 9. Lançamentos
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_default_company(p_org uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT id FROM whatsapp_hub.fin_companies
   WHERE org_id = COALESCE(p_org, whatsapp_hub.current_org_id()) AND is_default LIMIT 1
$$;

-- Confere conta do plano × tipo do lançamento.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_check_chart(p_org uuid, p_chart uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE ca record;
BEGIN
  SELECT * INTO ca FROM whatsapp_hub.fin_chart_accounts WHERE id = p_chart AND org_id = p_org;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Escolha uma conta do plano de contas.'); END IF;
  IF NOT ca.is_active THEN PERFORM whatsapp_hub.fin_fail(format('A conta %s está desativada. Escolha outra.', ca.code)); END IF;
  IF ca.is_synthetic THEN PERFORM whatsapp_hub.fin_fail(format('A conta %s é agrupadora. Escolha uma conta analítica (de último nível).', ca.code)); END IF;
  IF p_kind = 'payable' AND NOT (ca.type = 'expense' OR ca.nature = 'deduction') THEN
    PERFORM whatsapp_hub.fin_fail('Conta a pagar só aceita contas de despesa ou de dedução.');
  END IF;
  IF p_kind = 'receivable' AND NOT (ca.type = 'revenue' AND ca.nature <> 'deduction') THEN
    PERFORM whatsapp_hub.fin_fail('Conta a receber só aceita contas de receita.');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub._fin_check_refs(p_org uuid, p_party uuid, p_cc uuid)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_parties WHERE id = p_party AND org_id = p_org) THEN
    PERFORM whatsapp_hub.fin_fail('Fornecedor/cliente não encontrado.');
  END IF;
  IF p_cc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_cost_centers WHERE id = p_cc AND org_id = p_org AND is_active) THEN
    PERFORM whatsapp_hub.fin_fail('Centro de custo não encontrado ou desativado.');
  END IF;
END
$$;

-- p: {kind, company_id?, description, party_id?, chart_account_id, cost_center_id?,
--     total_cents, issue_date, competence_date, due_date, installments (1..36),
--     notes?, source?, source_ref?}
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_create_entry(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org      uuid := COALESCE(whatsapp_hub.current_org_id(), NULLIF(p->>'org_id', '')::uuid);
  v_kind     text := p->>'kind';
  v_source   text := COALESCE(NULLIF(p->>'source', ''), 'manual');
  v_company  uuid := NULLIF(p->>'company_id', '')::uuid;
  v_total    bigint;
  v_n        int := COALESCE(NULLIF(p->>'installments', '')::int, 1);
  v_due      date := NULLIF(p->>'due_date', '')::date;
  v_issue    date := COALESCE(NULLIF(p->>'issue_date', '')::date, whatsapp_hub.fin_today());
  v_comp     date := COALESCE(NULLIF(p->>'competence_date', '')::date, v_issue);
  v_id       uuid;
  v_base     bigint;
  v_rest     bigint;
  k          int;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_create', 'lançar contas a pagar/receber');
  IF v_org IS NULL THEN PERFORM whatsapp_hub.fin_fail('Organização não identificada.'); END IF;
  IF v_kind NOT IN ('payable', 'receivable') THEN PERFORM whatsapp_hub.fin_fail('Informe se é conta a pagar ou a receber.'); END IF;
  IF v_source NOT IN ('manual', 'purchase', 'hr', 'associates') THEN PERFORM whatsapp_hub.fin_fail('Origem do lançamento inválida.'); END IF;
  -- RH e associados lançam na empresa padrão.
  IF v_source IN ('hr', 'associates') OR v_company IS NULL THEN
    v_company := whatsapp_hub.fin_default_company(v_org);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = v_company AND org_id = v_org AND is_active) THEN
    PERFORM whatsapp_hub.fin_fail('Escolha uma empresa ativa do grupo.');
  END IF;
  IF length(btrim(COALESCE(p->>'description', ''))) < 2 THEN PERFORM whatsapp_hub.fin_fail('Informe a descrição.'); END IF;
  IF COALESCE(p->>'total_cents', '') !~ '^[0-9]+$' THEN
    PERFORM whatsapp_hub.fin_fail('Informe o valor total (maior que zero).');
  END IF;
  v_total := (p->>'total_cents')::bigint;
  IF v_total <= 0 THEN PERFORM whatsapp_hub.fin_fail('O valor total precisa ser maior que zero.'); END IF;
  IF v_n < 1 OR v_n > 36 THEN PERFORM whatsapp_hub.fin_fail('As parcelas vão de 1 (única) a 36.'); END IF;
  IF v_total < v_n THEN PERFORM whatsapp_hub.fin_fail('O valor é pequeno demais para tantas parcelas.'); END IF;
  IF v_due IS NULL THEN PERFORM whatsapp_hub.fin_fail('Informe o vencimento.'); END IF;
  IF length(COALESCE(p->>'notes', '')) > 500 THEN PERFORM whatsapp_hub.fin_fail('As observações têm no máximo 500 caracteres.'); END IF;
  PERFORM whatsapp_hub._fin_check_chart(v_org, NULLIF(p->>'chart_account_id', '')::uuid, v_kind);
  PERFORM whatsapp_hub._fin_check_refs(v_org, NULLIF(p->>'party_id', '')::uuid, NULLIF(p->>'cost_center_id', '')::uuid);
  PERFORM whatsapp_hub.fin_assert_open(v_company, v_comp, 'lançar');
  IF NULLIF(p->>'source_ref', '') IS NOT NULL AND EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_entries WHERE org_id = v_org AND source = v_source AND source_ref = p->>'source_ref' AND status = 'active') THEN
    PERFORM whatsapp_hub.fin_fail('Este documento já gerou um lançamento financeiro.');
  END IF;

  INSERT INTO whatsapp_hub.fin_entries (org_id, company_id, kind, description, party_id, chart_account_id, cost_center_id,
    total_cents, issue_date, competence_date, installments_count, notes, source, source_ref, created_by)
  VALUES (v_org, v_company, v_kind, btrim(p->>'description'), NULLIF(p->>'party_id', '')::uuid,
    NULLIF(p->>'chart_account_id', '')::uuid, NULLIF(p->>'cost_center_id', '')::uuid,
    v_total, v_issue, v_comp, v_n, NULLIF(btrim(COALESCE(p->>'notes', '')), ''), v_source, NULLIF(p->>'source_ref', ''), auth.uid())
  RETURNING id INTO v_id;

  -- Divide em centavos: o resto vai na 1ª parcela (soma bate exato).
  v_base := v_total / v_n;
  v_rest := v_total - v_base * v_n;
  FOR k IN 1..v_n LOOP
    INSERT INTO whatsapp_hub.fin_installments (org_id, entry_id, number, due_date, amount_cents)
    VALUES (v_org, v_id, k, (v_due + make_interval(months => k - 1))::date, v_base + CASE WHEN k = 1 THEN v_rest ELSE 0 END);
  END LOOP;
  RETURN v_id;
END
$$;

-- Altera só o cabeçalho (valor e parcelas não mudam).
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_update_entry(p_id uuid, p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  e        record;
  v_company uuid;
  v_comp   date;
  v_chart  uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_edit', 'editar lançamentos');
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Lançamento não encontrado.'); END IF;
  IF e.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('Lançamento cancelado não pode ser alterado.'); END IF;
  IF p ? 'total_cents' OR p ? 'installments' THEN
    PERFORM whatsapp_hub.fin_fail('Valor e parcelas não mudam na edição. Cancele e lance de novo se precisar.');
  END IF;
  v_company := COALESCE(NULLIF(p->>'company_id', '')::uuid, e.company_id);
  v_comp := COALESCE(NULLIF(p->>'competence_date', '')::date, e.competence_date);
  v_chart := COALESCE(NULLIF(p->>'chart_account_id', '')::uuid, e.chart_account_id);
  IF v_company <> e.company_id THEN
    IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_settlements WHERE entry_id = e.id) THEN
      PERFORM whatsapp_hub.fin_fail('Este lançamento já teve baixa: não dá para trocar a empresa.');
    END IF;
    IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_charges WHERE entry_id = e.id AND status IN ('pending', 'open', 'paid')) THEN
      PERFORM whatsapp_hub.fin_fail('Este lançamento tem cobrança emitida: cancele a cobrança antes de trocar a empresa.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = v_company AND org_id = e.org_id AND is_active) THEN
      PERFORM whatsapp_hub.fin_fail('Escolha uma empresa ativa do grupo.');
    END IF;
    PERFORM whatsapp_hub.fin_assert_open(v_company, v_comp, 'lançar');
  END IF;
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, e.competence_date, 'alterar lançamentos');
  IF v_comp <> e.competence_date THEN PERFORM whatsapp_hub.fin_assert_open(v_company, v_comp, 'alterar lançamentos'); END IF;
  IF v_chart <> e.chart_account_id THEN PERFORM whatsapp_hub._fin_check_chart(e.org_id, v_chart, e.kind); END IF;
  IF p ? 'description' AND length(btrim(COALESCE(p->>'description', ''))) < 2 THEN PERFORM whatsapp_hub.fin_fail('Informe a descrição.'); END IF;
  IF length(COALESCE(p->>'notes', '')) > 500 THEN PERFORM whatsapp_hub.fin_fail('As observações têm no máximo 500 caracteres.'); END IF;
  PERFORM whatsapp_hub._fin_check_refs(e.org_id,
    CASE WHEN p ? 'party_id' THEN NULLIF(p->>'party_id', '')::uuid ELSE e.party_id END,
    CASE WHEN p ? 'cost_center_id' THEN NULLIF(p->>'cost_center_id', '')::uuid ELSE e.cost_center_id END);

  UPDATE whatsapp_hub.fin_entries SET
    company_id       = v_company,
    description      = CASE WHEN p ? 'description' THEN btrim(p->>'description') ELSE description END,
    party_id         = CASE WHEN p ? 'party_id' THEN NULLIF(p->>'party_id', '')::uuid ELSE party_id END,
    chart_account_id = v_chart,
    cost_center_id   = CASE WHEN p ? 'cost_center_id' THEN NULLIF(p->>'cost_center_id', '')::uuid ELSE cost_center_id END,
    issue_date       = COALESCE(NULLIF(p->>'issue_date', '')::date, issue_date),
    competence_date  = v_comp,
    notes            = CASE WHEN p ? 'notes' THEN NULLIF(btrim(COALESCE(p->>'notes', '')), '') ELSE notes END
  WHERE id = e.id;

  -- Vencimentos das parcelas ainda em aberto podem ser ajustados: {due_dates: {"<id>": "AAAA-MM-DD"}}
  IF jsonb_typeof(p->'due_dates') = 'object' THEN
    UPDATE whatsapp_hub.fin_installments i SET due_date = (d.value #>> '{}')::date
      FROM jsonb_each(p->'due_dates') d
     WHERE i.entry_id = e.id AND i.id::text = d.key
       AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_settlements s WHERE s.installment_id = i.id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_cancel_entry(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE e record; v_paid bigint;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reverse', 'cancelar lançamentos');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do cancelamento (pelo menos 5 letras).'); END IF;
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Lançamento não encontrado.'); END IF;
  IF e.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('Este lançamento já está cancelado.'); END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid FROM whatsapp_hub.fin_settlements WHERE entry_id = e.id;
  IF v_paid <> 0 THEN PERFORM whatsapp_hub.fin_fail('Este lançamento tem baixa. Estorne as baixas antes de cancelar.'); END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_charges WHERE entry_id = e.id AND status IN ('pending', 'open')) THEN
    PERFORM whatsapp_hub.fin_fail('Este lançamento tem cobrança em aberto. Cancele a cobrança antes.');
  END IF;
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, e.competence_date, 'cancelar lançamentos');
  UPDATE whatsapp_hub.fin_entries
     SET status = 'canceled', cancel_reason = btrim(p_reason), canceled_at = now(), canceled_by = auth.uid()
   WHERE id = e.id;
END
$$;

-- ----------------------------------------------------------------------------
-- 10. Baixa e estorno
-- ----------------------------------------------------------------------------
-- Núcleo (sem checar perfil): usado pela tela (fin_settle) e pela cobrança (webhook).
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_settle_core(
  p_installment uuid, p_account uuid, p_date date, p_amount bigint,
  p_interest bigint, p_fine bigint, p_discount bigint, p_notes text, p_source text, p_charge uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE i record; e record; a record; v_paid bigint; v_id uuid;
BEGIN
  SELECT * INTO i FROM whatsapp_hub.fin_installments WHERE id = p_installment FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Parcela não encontrada.'); END IF;
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = i.entry_id;
  IF auth.uid() IS NOT NULL AND e.org_id <> whatsapp_hub.current_org_id() THEN PERFORM whatsapp_hub.fin_fail('Parcela não encontrada.'); END IF;
  IF e.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('Este lançamento está cancelado.'); END IF;
  SELECT * INTO a FROM whatsapp_hub.fin_accounts WHERE id = p_account AND org_id = e.org_id;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Escolha o banco/caixa da baixa.'); END IF;
  IF a.company_id <> e.company_id THEN
    PERFORM whatsapp_hub.fin_fail('O banco/caixa precisa ser da MESMA empresa do lançamento. Escolha uma conta dessa empresa.');
  END IF;
  IF NOT a.is_active THEN PERFORM whatsapp_hub.fin_fail('Este banco/caixa está desativado. Escolha outro.'); END IF;
  IF p_date IS NULL THEN PERFORM whatsapp_hub.fin_fail('Informe a data da baixa.'); END IF;
  IF p_date > whatsapp_hub.fin_today() THEN PERFORM whatsapp_hub.fin_fail('A data da baixa não pode ser no futuro.'); END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN PERFORM whatsapp_hub.fin_fail('Informe o valor da baixa (maior que zero).'); END IF;
  IF COALESCE(p_interest, 0) < 0 OR COALESCE(p_fine, 0) < 0 OR COALESCE(p_discount, 0) < 0 THEN
    PERFORM whatsapp_hub.fin_fail('Juros, multa e desconto não podem ser negativos.');
  END IF;
  IF COALESCE(p_discount, 0) > p_amount + COALESCE(p_interest, 0) + COALESCE(p_fine, 0) THEN
    PERFORM whatsapp_hub.fin_fail('O desconto não pode ser maior que o valor pago.');
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid FROM whatsapp_hub.fin_settlements WHERE installment_id = i.id;
  IF p_amount > i.amount_cents - v_paid THEN
    PERFORM whatsapp_hub.fin_fail(format('O valor passa do que falta na parcela (%s).', whatsapp_hub.fin_brl(i.amount_cents - v_paid)));
  END IF;
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, p_date, 'dar baixa');

  INSERT INTO whatsapp_hub.fin_settlements (org_id, installment_id, entry_id, account_id, settle_date, amount_cents,
    interest_cents, fine_cents, discount_cents, notes, source, charge_id, created_by)
  VALUES (e.org_id, i.id, e.id, a.id, p_date, p_amount, COALESCE(p_interest, 0), COALESCE(p_fine, 0), COALESCE(p_discount, 0),
    NULLIF(btrim(COALESCE(p_notes, '')), ''), COALESCE(p_source, 'manual'), p_charge, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._fin_settle_core(uuid, uuid, date, bigint, bigint, bigint, bigint, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._fin_settle_core(uuid, uuid, date, bigint, bigint, bigint, bigint, text, text, uuid) TO service_role;

-- p: {installment_id, account_id, settle_date, amount_cents, interest_cents?, fine_cents?, discount_cents?, notes?}
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_settle(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_settle', 'dar baixa');
  IF COALESCE(p->>'amount_cents', '') !~ '^[0-9]+$'
     OR COALESCE(p->>'interest_cents', '0') !~ '^[0-9]+$'
     OR COALESCE(p->>'fine_cents', '0') !~ '^[0-9]+$'
     OR COALESCE(p->>'discount_cents', '0') !~ '^[0-9]+$' THEN
    PERFORM whatsapp_hub.fin_fail('Valores da baixa inválidos. Use só números (centavos).');
  END IF;
  RETURN whatsapp_hub._fin_settle_core(
    NULLIF(p->>'installment_id', '')::uuid, NULLIF(p->>'account_id', '')::uuid,
    COALESCE(NULLIF(p->>'settle_date', '')::date, whatsapp_hub.fin_today()),
    (p->>'amount_cents')::bigint, COALESCE(p->>'interest_cents', '0')::bigint,
    COALESCE(p->>'fine_cents', '0')::bigint, COALESCE(p->>'discount_cents', '0')::bigint,
    p->>'notes', 'manual', NULL);
END
$$;

-- Estorno: contra-lançamento (linha nova com valores negativos). A parcela volta a ficar aberta.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_reverse_settlement_core(p_id uuid, p_reason text, p_date date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE s record; e record; v_id uuid; v_date date := COALESCE(p_date, whatsapp_hub.fin_today());
BEGIN
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do estorno (pelo menos 5 letras).'); END IF;
  SELECT * INTO s FROM whatsapp_hub.fin_settlements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR (auth.uid() IS NOT NULL AND s.org_id <> whatsapp_hub.current_org_id()) THEN
    PERFORM whatsapp_hub.fin_fail('Baixa não encontrada.');
  END IF;
  IF s.reversal_of IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Isto já é um estorno — não dá para estornar de novo.'); END IF;
  IF s.reversed_at IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Esta baixa já foi estornada.'); END IF;
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = s.entry_id;
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, s.settle_date, 'estornar uma baixa');
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, v_date, 'estornar uma baixa');
  INSERT INTO whatsapp_hub.fin_settlements (org_id, installment_id, entry_id, account_id, settle_date, amount_cents,
    interest_cents, fine_cents, discount_cents, notes, source, charge_id, reversal_of, reverse_reason, created_by)
  VALUES (s.org_id, s.installment_id, s.entry_id, s.account_id, v_date, -s.amount_cents, -s.interest_cents, -s.fine_cents,
    -s.discount_cents, 'Estorno: ' || btrim(p_reason), s.source, s.charge_id, s.id, btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;
  UPDATE whatsapp_hub.fin_settlements SET reversed_at = now(), reversed_by = auth.uid(), reverse_reason = btrim(p_reason) WHERE id = s.id;
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._fin_reverse_settlement_core(uuid, text, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION whatsapp_hub._fin_reverse_settlement_core(uuid, text, date) TO service_role;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_reverse_settlement(p_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reverse', 'estornar baixas');
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_charges c JOIN whatsapp_hub.fin_settlements s ON s.id = c.settlement_id
              WHERE s.id = p_id AND c.status = 'paid') THEN
    PERFORM whatsapp_hub.fin_fail('Esta baixa veio de uma cobrança paga no ASAAS. Use "Pedir devolução" na cobrança — o estorno acontece sozinho quando o ASAAS confirmar.');
  END IF;
  RETURN whatsapp_hub._fin_reverse_settlement_core(p_id, p_reason, NULL);
END
$$;

-- ----------------------------------------------------------------------------
-- 11. Transferências
-- ----------------------------------------------------------------------------
-- p: {from_account_id, to_account_id, amount_cents, transfer_date, description?}
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_create_transfer(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  f record; t record; v_amount bigint; v_date date; v_id uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.transfer', 'transferir entre contas');
  SELECT * INTO f FROM whatsapp_hub.fin_accounts WHERE id = NULLIF(p->>'from_account_id', '')::uuid AND org_id = v_org;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Escolha a conta de saída.'); END IF;
  SELECT * INTO t FROM whatsapp_hub.fin_accounts WHERE id = NULLIF(p->>'to_account_id', '')::uuid AND org_id = v_org;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Escolha a conta de entrada.'); END IF;
  IF f.id = t.id THEN PERFORM whatsapp_hub.fin_fail('A conta de saída e a de entrada precisam ser diferentes.'); END IF;
  IF NOT f.is_active OR NOT t.is_active THEN PERFORM whatsapp_hub.fin_fail('Uma das contas está desativada.'); END IF;
  IF COALESCE(p->>'amount_cents', '') !~ '^[0-9]+$' OR (p->>'amount_cents')::bigint <= 0 THEN
    PERFORM whatsapp_hub.fin_fail('Informe o valor da transferência (maior que zero).');
  END IF;
  v_amount := (p->>'amount_cents')::bigint;
  v_date := COALESCE(NULLIF(p->>'transfer_date', '')::date, whatsapp_hub.fin_today());
  IF v_date > whatsapp_hub.fin_today() THEN PERFORM whatsapp_hub.fin_fail('A data da transferência não pode ser no futuro.'); END IF;
  PERFORM whatsapp_hub.fin_assert_open(f.company_id, v_date, 'transferir');
  PERFORM whatsapp_hub.fin_assert_open(t.company_id, v_date, 'transferir');
  INSERT INTO whatsapp_hub.fin_transfers (org_id, from_account_id, to_account_id, amount_cents, transfer_date, description, created_by)
  VALUES (v_org, f.id, t.id, v_amount, v_date, NULLIF(btrim(COALESCE(p->>'description', '')), ''), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_reverse_transfer(p_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE x record; v_id uuid; v_today date := whatsapp_hub.fin_today(); cf uuid; ct uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reverse', 'estornar transferências');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do estorno (pelo menos 5 letras).'); END IF;
  SELECT * INTO x FROM whatsapp_hub.fin_transfers WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Transferência não encontrada.'); END IF;
  IF x.reversal_of IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Isto já é um estorno — não dá para estornar de novo.'); END IF;
  IF x.reversed_at IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Esta transferência já foi estornada.'); END IF;
  SELECT company_id INTO cf FROM whatsapp_hub.fin_accounts WHERE id = x.from_account_id;
  SELECT company_id INTO ct FROM whatsapp_hub.fin_accounts WHERE id = x.to_account_id;
  PERFORM whatsapp_hub.fin_assert_open(cf, x.transfer_date, 'estornar uma transferência');
  PERFORM whatsapp_hub.fin_assert_open(ct, x.transfer_date, 'estornar uma transferência');
  PERFORM whatsapp_hub.fin_assert_open(cf, v_today, 'estornar uma transferência');
  PERFORM whatsapp_hub.fin_assert_open(ct, v_today, 'estornar uma transferência');
  INSERT INTO whatsapp_hub.fin_transfers (org_id, from_account_id, to_account_id, amount_cents, transfer_date, description,
    reversal_of, reverse_reason, created_by)
  VALUES (x.org_id, x.to_account_id, x.from_account_id, x.amount_cents, v_today,
    'Estorno: ' || COALESCE(x.description, 'transferência') || ' — ' || btrim(p_reason), x.id, btrim(p_reason), auth.uid())
  RETURNING id INTO v_id;
  UPDATE whatsapp_hub.fin_transfers SET reversed_at = now(), reversed_by = auth.uid(), reverse_reason = btrim(p_reason) WHERE id = x.id;
  RETURN v_id;
END
$$;

-- ----------------------------------------------------------------------------
-- 12. Integrações internas (Compras / RH / Associados)
-- ----------------------------------------------------------------------------
-- Nota de entrada → nova conta a pagar: fin_create_entry com source='purchase' e source_ref=<id da nota>.
-- Nota de entrada → conciliar com conta a pagar que já existe:
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_link_purchase(p_entry uuid, p_source_ref text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE e record;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_edit', 'conciliar notas de compra');
  IF length(btrim(COALESCE(p_source_ref, ''))) = 0 THEN PERFORM whatsapp_hub.fin_fail('Informe a nota de entrada.'); END IF;
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = p_entry AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Lançamento não encontrado.'); END IF;
  IF e.kind <> 'payable' THEN PERFORM whatsapp_hub.fin_fail('Nota de compra só se concilia com conta a pagar.'); END IF;
  IF e.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('Lançamento cancelado não pode ser conciliado.'); END IF;
  IF e.source_ref IS NOT NULL AND e.source_ref <> p_source_ref THEN
    PERFORM whatsapp_hub.fin_fail('Esta conta a pagar já está ligada a outra nota.');
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_entries WHERE org_id = e.org_id AND source = 'purchase'
               AND source_ref = p_source_ref AND status = 'active' AND id <> e.id) THEN
    PERFORM whatsapp_hub.fin_fail('Esta nota já está ligada a outra conta a pagar.');
  END IF;
  UPDATE whatsapp_hub.fin_entries SET source = 'purchase', source_ref = p_source_ref WHERE id = e.id;
END
$$;

-- ----------------------------------------------------------------------------
-- 13. Relatórios (todos com filtro opcional de empresa)
-- ----------------------------------------------------------------------------
-- Cartões da lista: aberto (a vencer), vencido e pago no período.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_entries_summary(p_kind text, p_company uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); r jsonb;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_view', 'ver o financeiro');
  SELECT jsonb_build_object(
    'open_cents', COALESCE(sum(v.remaining_cents) FILTER (WHERE v.status IN ('open', 'partial')), 0),
    'overdue_cents', COALESCE(sum(v.remaining_cents) FILTER (WHERE v.status = 'overdue'), 0),
    'open_count', count(*) FILTER (WHERE v.status IN ('open', 'partial')),
    'overdue_count', count(*) FILTER (WHERE v.status = 'overdue'))
  INTO r
  FROM whatsapp_hub.fin_installments_v v
  WHERE v.org_id = v_org AND v.kind = p_kind
    AND (p_company IS NULL OR v.company_id = p_company)
    AND (p_from IS NULL OR v.due_date >= p_from) AND (p_to IS NULL OR v.due_date <= p_to);
  RETURN r || jsonb_build_object('paid_cents', (
    SELECT COALESCE(sum(s.amount_cents), 0) FROM whatsapp_hub.fin_settlements s
      JOIN whatsapp_hub.fin_entries e ON e.id = s.entry_id
     WHERE s.org_id = v_org AND e.kind = p_kind AND (p_company IS NULL OR e.company_id = p_company)
       AND (p_from IS NULL OR s.settle_date >= p_from) AND (p_to IS NULL OR s.settle_date <= p_to)));
END
$$;

-- Agenda de vencimentos: parcelas com saldo, por dia.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_report_agenda(p_company uuid, p_from date, p_to date)
RETURNS TABLE (due_date date, kind text, installment_id uuid, entry_id uuid, description text, party_name text,
               company_name text, number int, installments_count int, remaining_cents bigint, status text)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reports', 'ver relatórios financeiros');
  RETURN QUERY
  SELECT v.due_date, v.kind, v.id, v.entry_id, v.description, v.party_name, v.company_name, v.number,
         v.installments_count, v.remaining_cents, v.status
    FROM whatsapp_hub.fin_installments_v v
   WHERE v.org_id = whatsapp_hub.current_org_id() AND v.remaining_cents > 0
     AND (p_company IS NULL OR v.company_id = p_company)
     AND v.due_date BETWEEN p_from AND p_to
   ORDER BY v.due_date, v.kind DESC, v.description;
END
$$;

-- Fluxo de caixa: realizado (movimentos) e projetado (saldo de parcelas), por dia ou mês.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_report_cashflow(p_company uuid, p_from date, p_to date, p_group text DEFAULT 'day')
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_today date := whatsapp_hub.fin_today();
  v_open bigint;
  v_rows jsonb;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reports', 'ver relatórios financeiros');
  SELECT COALESCE(sum(a.opening_balance_cents), 0) + COALESCE((
           SELECT sum(m.signed_cents) FROM whatsapp_hub.fin_movements_v m
            WHERE m.org_id = v_org AND (p_company IS NULL OR m.company_id = p_company) AND m.move_date < p_from), 0)
    INTO v_open
    FROM whatsapp_hub.fin_accounts a WHERE a.org_id = v_org AND (p_company IS NULL OR a.company_id = p_company);

  WITH buckets AS (
    SELECT CASE WHEN p_group = 'month' THEN date_trunc('month', d)::date ELSE d::date END AS b
      FROM generate_series(p_from, p_to, interval '1 day') d GROUP BY 1
  ),
  realized AS (
    SELECT CASE WHEN p_group = 'month' THEN date_trunc('month', m.move_date)::date ELSE m.move_date END AS b,
           -- estorno abate do próprio lado (estorno de pagamento reduz as saídas)
           sum(m.signed_cents) FILTER (WHERE m.kind = 'receivable') AS r_in,
           -sum(m.signed_cents) FILTER (WHERE m.kind = 'payable') AS r_out,
           sum(m.signed_cents) AS r_net
      FROM whatsapp_hub.fin_movements_v m
     WHERE m.org_id = v_org AND (p_company IS NULL OR m.company_id = p_company) AND m.move_date BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  projected AS (
    SELECT CASE WHEN p_group = 'month' THEN date_trunc('month', GREATEST(v.due_date, v_today))::date ELSE GREATEST(v.due_date, v_today) END AS b,
           sum(v.remaining_cents) FILTER (WHERE v.kind = 'receivable') AS p_in,
           sum(v.remaining_cents) FILTER (WHERE v.kind = 'payable') AS p_out
      FROM whatsapp_hub.fin_installments_v v
     WHERE v.org_id = v_org AND v.remaining_cents > 0 AND (p_company IS NULL OR v.company_id = p_company)
       AND GREATEST(v.due_date, v_today) BETWEEN p_from AND p_to
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'date', bk.b,
           'realized_in', COALESCE(r.r_in, 0), 'realized_out', COALESCE(r.r_out, 0), 'realized_net', COALESCE(r.r_net, 0),
           'projected_in', COALESCE(pj.p_in, 0), 'projected_out', COALESCE(pj.p_out, 0)) ORDER BY bk.b), '[]'::jsonb)
    INTO v_rows
    FROM buckets bk LEFT JOIN realized r ON r.b = bk.b LEFT JOIN projected pj ON pj.b = bk.b;

  RETURN jsonb_build_object('opening_cents', v_open, 'today', v_today, 'rows', v_rows);
END
$$;

-- Custos (contas a pagar ativas, por competência) agrupados.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_report_costs(p_company uuid, p_from date, p_to date, p_group text)
RETURNS TABLE (group_key text, group_label text, total_cents bigint, entries_count bigint)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reports', 'ver relatórios financeiros');
  IF p_group NOT IN ('cost_center', 'account', 'party', 'company') THEN
    PERFORM whatsapp_hub.fin_fail('Agrupamento inválido.');
  END IF;
  RETURN QUERY
  SELECT
    CASE p_group WHEN 'cost_center' THEN COALESCE(e.cost_center_id::text, '-')
                 WHEN 'account' THEN e.chart_account_id::text
                 WHEN 'party' THEN COALESCE(e.party_id::text, '-')
                 ELSE e.company_id::text END,
    CASE p_group WHEN 'cost_center' THEN COALESCE(cc.name, 'Sem centro de custo')
                 WHEN 'account' THEN ca.code || ' ' || ca.name
                 WHEN 'party' THEN COALESCE(pt.name, 'Sem fornecedor')
                 ELSE c.name END,
    sum(e.total_cents)::bigint, count(*)
  FROM whatsapp_hub.fin_entries e
  JOIN whatsapp_hub.fin_companies c ON c.id = e.company_id
  JOIN whatsapp_hub.fin_chart_accounts ca ON ca.id = e.chart_account_id
  LEFT JOIN whatsapp_hub.fin_cost_centers cc ON cc.id = e.cost_center_id
  LEFT JOIN whatsapp_hub.fin_parties pt ON pt.id = e.party_id
  WHERE e.org_id = whatsapp_hub.current_org_id() AND e.kind = 'payable' AND e.status = 'active'
    AND (p_company IS NULL OR e.company_id = p_company)
    AND e.competence_date BETWEEN p_from AND p_to
  GROUP BY 1, 2
  ORDER BY 3 DESC;
END
$$;

-- DRE do período (competência). Juros/multa/descontos das baixas entram no resultado financeiro.
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_report_dre(p_company uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  gross bigint; ded bigint; cost bigint; opex bigint; fin_rev bigint; fin_exp bigint; tax bigint; inv bigint; adj bigint;
  v_lines jsonb;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_reports', 'ver relatórios financeiros');
  WITH base AS (
    SELECT e.kind, ca.nature, ca.code, ca.name, e.total_cents
      FROM whatsapp_hub.fin_entries e JOIN whatsapp_hub.fin_chart_accounts ca ON ca.id = e.chart_account_id
     WHERE e.org_id = v_org AND e.status = 'active' AND (p_company IS NULL OR e.company_id = p_company)
       AND e.competence_date BETWEEN p_from AND p_to
  )
  SELECT
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'receivable' AND nature = 'operating_revenue'), 0),
    COALESCE(sum(CASE WHEN kind = 'payable' THEN total_cents ELSE -total_cents END) FILTER (WHERE nature = 'deduction'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'payable' AND nature = 'cost'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'payable' AND nature = 'operating_expense'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'receivable' AND nature = 'financial'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'payable' AND nature = 'financial'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE kind = 'payable' AND nature = 'tax'), 0),
    COALESCE(sum(total_cents) FILTER (WHERE nature = 'investment'), 0),
    COALESCE(jsonb_agg(jsonb_build_object('nature', nature, 'code', code, 'name', name, 'kind', kind, 'total_cents', total_cents)), '[]'::jsonb)
  INTO gross, ded, cost, opex, fin_rev, fin_exp, tax, inv, v_lines
  FROM base;

  -- Juros e multa recebidos (+) / pagos (−); descontos concedidos (−) / obtidos (+).
  SELECT COALESCE(sum(CASE WHEN e.kind = 'receivable' THEN s.interest_cents + s.fine_cents - s.discount_cents
                           ELSE -(s.interest_cents + s.fine_cents - s.discount_cents) END), 0)
    INTO adj
    FROM whatsapp_hub.fin_settlements s JOIN whatsapp_hub.fin_entries e ON e.id = s.entry_id
   WHERE s.org_id = v_org AND (p_company IS NULL OR e.company_id = p_company) AND s.settle_date BETWEEN p_from AND p_to;

  RETURN jsonb_build_object(
    'gross_revenue', gross,
    'deductions', ded,
    'net_revenue', gross - ded,
    'costs', cost,
    'operating_expenses', opex,
    'financial_result', fin_rev - fin_exp + adj,
    'taxes', tax,
    'result', gross - ded - cost - opex + (fin_rev - fin_exp + adj) - tax,
    'investments', inv,
    'settlement_adjustments', adj,
    'accounts', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'code'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('nature', l->>'nature', 'code', l->>'code', 'name', l->>'name', 'kind', l->>'kind',
               'total_cents', sum((l->>'total_cents')::bigint)) AS x
          FROM jsonb_array_elements(v_lines) l GROUP BY l->>'nature', l->>'code', l->>'name', l->>'kind') q));
END
$$;

-- ----------------------------------------------------------------------------
-- 14. Cobrança ASAAS (chamado só pelas Edge Functions, com service role)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_charge_paid(p_charge uuid, p_paid_date date, p_value_cents bigint, p_event text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE c record; i record; v_paid bigint; v_principal bigint; v_extra bigint; v_disc bigint; v_settle uuid; v_date date;
BEGIN
  SELECT * INTO c FROM whatsapp_hub.fin_charges WHERE id = p_charge FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.settlement_id IS NOT NULL THEN RETURN c.settlement_id; END IF;   -- idempotente
  SELECT * INTO i FROM whatsapp_hub.fin_installments WHERE id = c.installment_id;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid FROM whatsapp_hub.fin_settlements WHERE installment_id = i.id;
  v_principal := LEAST(i.amount_cents - v_paid, p_value_cents);
  IF v_principal <= 0 THEN
    UPDATE whatsapp_hub.fin_charges SET status = 'paid', last_event = p_event,
      error_message = 'Pagamento recebido, mas a parcela já estava quitada no CRM. Confira e devolva se for o caso.' WHERE id = c.id;
    RETURN NULL;
  END IF;
  v_extra := GREATEST(p_value_cents - v_principal, 0);       -- pago a mais = juros/multa
  v_disc := GREATEST(v_principal - p_value_cents, 0);
  v_date := LEAST(COALESCE(p_paid_date, whatsapp_hub.fin_today()), whatsapp_hub.fin_today());
  BEGIN
    v_settle := whatsapp_hub._fin_settle_core(i.id, c.account_id, v_date, v_principal, v_extra, 0, v_disc,
                  'Recebido pelo ASAAS', 'asaas', c.id);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    -- Ex.: período fechado. Fica registrado na cobrança para o financeiro resolver.
    UPDATE whatsapp_hub.fin_charges SET status = 'paid', last_event = p_event, error_message = SQLERRM WHERE id = c.id;
    RETURN NULL;
  END;
  UPDATE whatsapp_hub.fin_charges SET status = 'paid', settlement_id = v_settle, last_event = p_event, error_message = NULL WHERE id = c.id;
  RETURN v_settle;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.fin_charge_refunded(p_charge uuid, p_event text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM whatsapp_hub.fin_charges WHERE id = p_charge FOR UPDATE;
  IF NOT FOUND OR c.status = 'refunded' THEN RETURN; END IF;
  IF c.settlement_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_settlements WHERE id = c.settlement_id AND reversed_at IS NULL) THEN
    BEGIN
      PERFORM whatsapp_hub._fin_reverse_settlement_core(c.settlement_id, 'Devolução confirmada pelo ASAAS', NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      UPDATE whatsapp_hub.fin_charges SET status = 'refunded', last_event = p_event, error_message = SQLERRM WHERE id = c.id;
      RETURN;
    END;
  END IF;
  UPDATE whatsapp_hub.fin_charges SET status = 'refunded', last_event = p_event, error_message = NULL WHERE id = c.id;
END
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_charge_paid(uuid, date, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_charge_refunded(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_charge_paid(uuid, date, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_charge_refunded(uuid, text) TO service_role;

-- Funções públicas: só usuários logados (cada uma confere a permissão).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'fin_close_period(uuid, date)', 'fin_reopen_period(uuid, date, text)', 'fin_create_entry(jsonb)',
    'fin_update_entry(uuid, jsonb)', 'fin_cancel_entry(uuid, text)', 'fin_settle(jsonb)',
    'fin_reverse_settlement(uuid, text)', 'fin_create_transfer(jsonb)', 'fin_reverse_transfer(uuid, text)',
    'fin_link_purchase(uuid, text)', 'fin_entries_summary(text, uuid, date, date)',
    'fin_report_agenda(uuid, date, date)', 'fin_report_cashflow(uuid, date, date, text)',
    'fin_report_costs(uuid, date, date, text)', 'fin_report_dre(uuid, date, date)', 'fin_default_company(uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION whatsapp_hub.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION whatsapp_hub.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 15. Dados iniciais por organização: empresa padrão + plano de contas básico
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_seed_org(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record; v_parent uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE org_id = p_org) THEN
    INSERT INTO whatsapp_hub.fin_companies (org_id, name, is_default)
    SELECT p_org, name, true FROM whatsapp_hub.organizations WHERE id = p_org;
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org) THEN RETURN; END IF;
  FOR r IN SELECT * FROM (VALUES
    ('1',      NULL,  'RECEITAS',                         'revenue', 'operating_revenue', true),
    ('1.1',    '1',   'Receita operacional',              'revenue', 'operating_revenue', true),
    ('1.1.01', '1.1', 'Ingressos e passaportes',          'revenue', 'operating_revenue', false),
    ('1.1.02', '1.1', 'Eventos',                          'revenue', 'operating_revenue', false),
    ('1.1.03', '1.1', 'Excursões',                        'revenue', 'operating_revenue', false),
    ('1.1.04', '1.1', 'Área VIP',                         'revenue', 'operating_revenue', false),
    ('1.1.05', '1.1', 'Patrocínios',                      'revenue', 'operating_revenue', false),
    ('1.1.06', '1.1', 'Alimentos e bebidas',              'revenue', 'operating_revenue', false),
    ('1.2',    '1',   'Receitas financeiras',             'revenue', 'financial', true),
    ('1.2.01', '1.2', 'Rendimentos de aplicações',        'revenue', 'financial', false),
    ('2',      NULL,  'DEDUÇÕES DA RECEITA',              'expense', 'deduction', true),
    ('2.01',   '2',   'Impostos sobre vendas',            'expense', 'deduction', false),
    ('2.02',   '2',   'Taxas de cartão e gateway',        'expense', 'deduction', false),
    ('2.03',   '2',   'Devoluções e cancelamentos',       'expense', 'deduction', false),
    ('3',      NULL,  'CUSTOS',                           'expense', 'cost', true),
    ('3.01',   '3',   'Manutenção do parque',             'expense', 'cost', false),
    ('3.02',   '3',   'Insumos e produtos químicos',      'expense', 'cost', false),
    ('3.03',   '3',   'Mercadorias para revenda',         'expense', 'cost', false),
    ('4',      NULL,  'DESPESAS OPERACIONAIS',            'expense', 'operating_expense', true),
    ('4.01',   '4',   'Energia elétrica',                 'expense', 'operating_expense', false),
    ('4.02',   '4',   'Água e esgoto',                    'expense', 'operating_expense', false),
    ('4.03',   '4',   'Internet e telefonia',             'expense', 'operating_expense', false),
    ('4.04',   '4',   'Salários e encargos',              'expense', 'operating_expense', false),
    ('4.05',   '4',   'Marketing e publicidade',          'expense', 'operating_expense', false),
    ('4.06',   '4',   'Despesas administrativas',         'expense', 'operating_expense', false),
    ('5',      NULL,  'DESPESAS FINANCEIRAS',             'expense', 'financial', true),
    ('5.01',   '5',   'Juros e tarifas bancárias',        'expense', 'financial', false),
    ('6',      NULL,  'IMPOSTOS SOBRE O LUCRO',           'expense', 'tax', true),
    ('6.01',   '6',   'IRPJ e CSLL',                      'expense', 'tax', false),
    ('7',      NULL,  'INVESTIMENTOS',                    'expense', 'investment', true),
    ('7.01',   '7',   'Obras e equipamentos',             'expense', 'investment', false)
  ) AS t(code, parent, name, type, nature, synthetic) LOOP
    SELECT id INTO v_parent FROM whatsapp_hub.fin_chart_accounts WHERE org_id = p_org AND code = r.parent;
    INSERT INTO whatsapp_hub.fin_chart_accounts (org_id, parent_id, code, name, type, nature, is_synthetic)
    VALUES (p_org, CASE WHEN r.parent IS NULL THEN NULL ELSE v_parent END, r.code, r.name, r.type, r.nature, r.synthetic);
  END LOOP;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_seed_org(uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT id FROM whatsapp_hub.organizations LOOP
    PERFORM whatsapp_hub.fin_seed_org(o.id);
  END LOOP;
END $$;

-- Org criada depois também ganha os dados iniciais.
CREATE OR REPLACE FUNCTION whatsapp_hub._fin_seed_new_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$ BEGIN PERFORM whatsapp_hub.fin_seed_org(NEW.id); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_fin_seed_new_org ON whatsapp_hub.organizations;
CREATE TRIGGER trg_fin_seed_new_org AFTER INSERT ON whatsapp_hub.organizations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_seed_new_org();
