-- ============================================================================
-- Módulo COMPRAS (08/10/2026)
-- ----------------------------------------------------------------------------
-- Requisição → Cotação → Pedido → Recebimento → Nota de entrada, gerando conta
-- a pagar (Financeiro, fin_*) e entrada no estoque (base inv_*).
--
-- Regras (garantidas no banco):
--   * dinheiro em CENTAVOS (bigint); quantidade é numeric(14,3) (não é dinheiro);
--   * só RASCUNHO se exclui; o resto é cancelado com motivo;
--   * transições só por RPC SECURITY DEFINER com permissão (fin_require);
--   * auditoria em todas as tabelas (fin_audit_log, mesma trilha do Financeiro);
--   * quem pede não aprova a requisição; quem montou a cotação não aprova o estouro;
--   * erros em português (fin_fail).
--
-- Base de ESTOQUE (inv_items, inv_locations, inv_movements, inv_balances_v):
-- o mínimo para o recebimento e a nota darem entrada. O módulo de Estoque
-- completo vem depois e estende estas tabelas.
-- Requer: 20261008140000_finance_module.sql. Idempotente.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public, extensions;

-- ----------------------------------------------------------------------------
-- 0. Permissões
-- ----------------------------------------------------------------------------
INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('purchases.view',            'purchases', 'view',            'Acessar Compras', 1300),
  ('purchases.request',         'purchases', 'request',         'Criar e enviar requisição', 1301),
  ('purchases.approve',         'purchases', 'approve',         'Aprovar requisição / estouro de alçada', 1302),
  ('purchases.quote',           'purchases', 'quote',           'Montar cotações', 1303),
  ('purchases.order',           'purchases', 'order',           'Emitir e revisar pedidos', 1304),
  ('purchases.receive',         'purchases', 'receive',         'Conferir recebimento', 1305),
  ('purchases.receive_reverse', 'purchases', 'receive_reverse', 'Estornar recebimento concluído', 1306),
  ('purchases.invoice',         'purchases', 'invoice',         'Notas de entrada (importar, lançar, conciliar)', 1307),
  ('purchases.cancel',          'purchases', 'cancel',          'Cancelar documentos de compra', 1308),
  ('purchases.setup',           'purchases', 'setup',           'Configurar compras (alçadas, certificado SEFAZ)', 1309),
  ('inventory.view',            'inventory', 'view',            'Ver estoque', 1400),
  ('inventory.setup',           'inventory', 'setup',           'Cadastrar itens e locais de estoque', 1401)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- Gerente e Financeiro: tudo de Compras e Estoque (Administrador já tem tudo).
INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, p.key FROM whatsapp_hub.access_roles ar
  JOIN whatsapp_hub.permissions p ON p.module IN ('purchases', 'inventory')
 WHERE ar.name IN ('Gerente', 'Financeiro') AND ar.is_system
ON CONFLICT DO NOTHING;
-- Supervisor e Operacional pedem (requisição) e conferem recebimento.
INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, p.key FROM whatsapp_hub.access_roles ar
  JOIN whatsapp_hub.permissions p ON p.key IN ('purchases.view', 'purchases.request', 'purchases.receive', 'inventory.view')
 WHERE ar.name IN ('Supervisor', 'Operacional') AND ar.is_system
ON CONFLICT DO NOTHING;

-- A trilha (fin_audit_log) também é lida por quem usa Compras.
DROP POLICY IF EXISTS fin_audit_select ON whatsapp_hub.fin_audit_log;
CREATE POLICY fin_audit_select ON whatsapp_hub.fin_audit_log FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('audit.view')
    OR (table_name LIKE 'fin\_%' AND whatsapp_hub.has_perm('financial.ledger_view'))
    OR ((table_name LIKE 'pur\_%' OR table_name LIKE 'inv\_%') AND whatsapp_hub.has_perm('purchases.view'))));

-- ----------------------------------------------------------------------------
-- 1. Financeiro: lançamento com vencimentos da nota (parcelas com datas/valores próprios)
--    p.schedule = [{"due_date":"AAAA-MM-DD","amount_cents":123}, ...] (soma = total)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_create_entry_schedule(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_sched jsonb := p->'schedule';
  v_n int; v_sum bigint := 0; v_id uuid; r record; k int := 0;
BEGIN
  IF jsonb_typeof(v_sched) <> 'array' OR jsonb_array_length(v_sched) = 0 THEN
    RETURN whatsapp_hub.fin_create_entry(p);
  END IF;
  v_n := jsonb_array_length(v_sched);
  IF v_n > 36 THEN PERFORM whatsapp_hub.fin_fail('A nota tem mais de 36 vencimentos.'); END IF;
  FOR r IN SELECT value AS e FROM jsonb_array_elements(v_sched) LOOP
    IF COALESCE(r.e->>'amount_cents', '') !~ '^[0-9]+$' OR (r.e->>'amount_cents')::bigint <= 0 OR NULLIF(r.e->>'due_date', '') IS NULL THEN
      PERFORM whatsapp_hub.fin_fail('Vencimentos da nota inválidos: cada um precisa de data e valor.');
    END IF;
    v_sum := v_sum + (r.e->>'amount_cents')::bigint;
  END LOOP;
  IF v_sum <> (p->>'total_cents')::bigint THEN
    PERFORM whatsapp_hub.fin_fail(format('A soma dos vencimentos (%s) é diferente do total (%s).',
      whatsapp_hub.fin_brl(v_sum), whatsapp_hub.fin_brl((p->>'total_cents')::bigint)));
  END IF;
  -- Cria com N parcelas e depois acerta datas/valores conforme a nota.
  v_id := whatsapp_hub.fin_create_entry(p || jsonb_build_object('installments', v_n,
            'due_date', (SELECT min((e->>'due_date')::date) FROM jsonb_array_elements(v_sched) e)::text));
  FOR r IN SELECT (e->>'due_date')::date AS due, (e->>'amount_cents')::bigint AS amt
             FROM jsonb_array_elements(v_sched) e ORDER BY (e->>'due_date')::date LOOP
    k := k + 1;
    UPDATE whatsapp_hub.fin_installments SET due_date = r.due, amount_cents = r.amt WHERE entry_id = v_id AND number = k;
  END LOOP;
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.fin_create_entry_schedule(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_create_entry_schedule(jsonb) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Base de estoque
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.inv_locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  name       text NOT NULL CHECK (length(btrim(name)) >= 2),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.inv_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  code              text,
  name              text NOT NULL CHECK (length(btrim(name)) >= 2),
  unit              text NOT NULL DEFAULT 'UN',
  requires_lot      boolean NOT NULL DEFAULT false,
  ncm               text,
  gtin              text,
  chart_account_id  uuid REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE SET NULL,
  last_cost_cents   bigint,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inv_items_code ON whatsapp_hub.inv_items (org_id, code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS inv_items_name ON whatsapp_hub.inv_items (org_id, name);

CREATE TABLE IF NOT EXISTS whatsapp_hub.inv_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES whatsapp_hub.inv_items(id) ON DELETE RESTRICT,
  location_id     uuid NOT NULL REFERENCES whatsapp_hub.inv_locations(id) ON DELETE RESTRICT,
  qty             numeric(14,3) NOT NULL CHECK (qty <> 0),       -- + entra, − sai
  unit_cost_cents bigint,
  lot             text,
  expiry          date,
  source          text NOT NULL CHECK (source IN ('receipt', 'receipt_reversal', 'invoice', 'invoice_reversal', 'manual')),
  source_id       uuid,
  notes           text,
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_movements_item ON whatsapp_hub.inv_movements (item_id, location_id);
CREATE INDEX IF NOT EXISTS inv_movements_source ON whatsapp_hub.inv_movements (source, source_id);

CREATE OR REPLACE VIEW whatsapp_hub.inv_balances_v
WITH (security_invoker = true) AS
SELECT m.org_id, m.item_id, i.name AS item_name, i.unit, m.location_id, l.name AS location_name, m.lot,
       max(m.expiry) AS expiry, sum(m.qty) AS qty
  FROM whatsapp_hub.inv_movements m
  JOIN whatsapp_hub.inv_items i ON i.id = m.item_id
  JOIN whatsapp_hub.inv_locations l ON l.id = m.location_id
 GROUP BY m.org_id, m.item_id, i.name, i.unit, m.location_id, l.name, m.lot;
GRANT SELECT ON whatsapp_hub.inv_balances_v TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. Compras: tabelas
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_counters (
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  prefix text NOT NULL,
  last   int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, prefix)
);

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_next_number(p_org uuid, p_prefix text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v int;
BEGIN
  INSERT INTO whatsapp_hub.pur_counters (org_id, prefix, last) VALUES (p_org, p_prefix, 1)
  ON CONFLICT (org_id, prefix) DO UPDATE SET last = whatsapp_hub.pur_counters.last + 1
  RETURNING last INTO v;
  RETURN p_prefix || '-' || lpad(v::text, 5, '0');
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.pur_next_number(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_approval_bands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  min_cents      bigint NOT NULL DEFAULT 0 CHECK (min_cents >= 0),
  max_cents      bigint CHECK (max_cents IS NULL OR max_cents >= min_cents),
  access_role_id uuid NOT NULL REFERENCES whatsapp_hub.access_roles(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_requisitions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  number             text,
  company_id         uuid REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  team_id            uuid REFERENCES whatsapp_hub.teams(id) ON DELETE SET NULL,
  cost_center_id     uuid REFERENCES whatsapp_hub.fin_cost_centers(id) ON DELETE SET NULL,
  justification      text CHECK (justification IS NULL OR length(justification) <= 1000),
  urgency            text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'urgent')),
  needed_by          date,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'returned', 'quoting', 'ordered', 'done', 'canceled')),
  approved_limit_cents bigint,          -- teto da alçada em que foi aprovada (null = sem teto)
  submitted_at       timestamptz,
  decided_by         uuid,
  decided_at         timestamptz,
  decision_reason    text,
  cancel_reason      text,
  requested_by       uuid DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_requisition_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  requisition_id  uuid NOT NULL REFERENCES whatsapp_hub.pur_requisitions(id) ON DELETE CASCADE,
  item_id         uuid REFERENCES whatsapp_hub.inv_items(id) ON DELETE RESTRICT,
  description     text NOT NULL CHECK (length(btrim(description)) >= 2),
  qty             numeric(14,3) NOT NULL CHECK (qty > 0),
  unit            text NOT NULL DEFAULT 'UN',
  est_unit_cents  bigint CHECK (est_unit_cents IS NULL OR est_unit_cents >= 0),
  ordered_qty     numeric(14,3) NOT NULL DEFAULT 0,
  received_qty    numeric(14,3) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_quotations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  number            text NOT NULL,
  requisition_id    uuid NOT NULL REFERENCES whatsapp_hub.pur_requisitions(id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_approval', 'approved', 'ordered', 'canceled')),
  total_cents       bigint,
  approval_reason   text,
  approved_by       uuid,
  approved_at       timestamptz,
  cancel_reason     text,
  created_by        uuid DEFAULT auth.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_quotation_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  quotation_id         uuid NOT NULL REFERENCES whatsapp_hub.pur_quotations(id) ON DELETE RESTRICT,
  requisition_item_id  uuid NOT NULL REFERENCES whatsapp_hub.pur_requisition_items(id) ON DELETE RESTRICT,
  item_id              uuid REFERENCES whatsapp_hub.inv_items(id) ON DELETE RESTRICT,
  description          text NOT NULL,
  qty                  numeric(14,3) NOT NULL CHECK (qty > 0),
  unit                 text NOT NULL,
  winner_supplier_id   uuid,             -- pur_quotation_suppliers.id
  winner_justification text
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_quotation_suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  quotation_id   uuid NOT NULL REFERENCES whatsapp_hub.pur_quotations(id) ON DELETE RESTRICT,
  party_id       uuid NOT NULL REFERENCES whatsapp_hub.fin_parties(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'responded', 'no_response', 'declined')),
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  freight_cents  bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  payment_terms  text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quotation_id, party_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_quotation_prices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  quotation_supplier_id  uuid NOT NULL REFERENCES whatsapp_hub.pur_quotation_suppliers(id) ON DELETE CASCADE,
  quotation_item_id      uuid NOT NULL REFERENCES whatsapp_hub.pur_quotation_items(id) ON DELETE CASCADE,
  unit_cents             bigint NOT NULL CHECK (unit_cents >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quotation_supplier_id, quotation_item_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  number          text,
  company_id      uuid REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  party_id        uuid REFERENCES whatsapp_hub.fin_parties(id) ON DELETE RESTRICT,
  quotation_id    uuid REFERENCES whatsapp_hub.pur_quotations(id) ON DELETE RESTRICT,
  requisition_id  uuid REFERENCES whatsapp_hub.pur_requisitions(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'partial', 'received', 'canceled')),
  revision        int NOT NULL DEFAULT 0,
  freight_cents   bigint NOT NULL DEFAULT 0 CHECK (freight_cents >= 0),
  payment_terms   text,
  expected_date   date,
  notes           text CHECK (notes IS NULL OR length(notes) <= 1000),
  issued_at       timestamptz,
  cancel_reason   text,
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_order_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  order_id             uuid NOT NULL REFERENCES whatsapp_hub.pur_orders(id) ON DELETE CASCADE,
  item_id              uuid REFERENCES whatsapp_hub.inv_items(id) ON DELETE RESTRICT,
  description          text NOT NULL CHECK (length(btrim(description)) >= 2),
  qty                  numeric(14,3) NOT NULL CHECK (qty > 0),
  unit                 text NOT NULL DEFAULT 'UN',
  unit_cents           bigint NOT NULL CHECK (unit_cents >= 0),
  received_qty         numeric(14,3) NOT NULL DEFAULT 0,
  requisition_item_id  uuid REFERENCES whatsapp_hub.pur_requisition_items(id) ON DELETE RESTRICT,
  quotation_item_id    uuid REFERENCES whatsapp_hub.pur_quotation_items(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_order_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES whatsapp_hub.pur_orders(id) ON DELETE RESTRICT,
  revision    int NOT NULL,
  before      jsonb NOT NULL,
  reason      text NOT NULL,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  number         text NOT NULL,
  order_id       uuid NOT NULL REFERENCES whatsapp_hub.pur_orders(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'done', 'reversed', 'canceled')),
  received_date  date NOT NULL DEFAULT whatsapp_hub.fin_today(),
  location_id    uuid REFERENCES whatsapp_hub.inv_locations(id) ON DELETE RESTRICT,
  notes          text CHECK (notes IS NULL OR length(notes) <= 1000),
  done_by        uuid,
  done_at        timestamptz,
  reversed_by    uuid,
  reversed_at    timestamptz,
  reverse_reason text,
  created_by     uuid DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_receipt_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  receipt_id         uuid NOT NULL REFERENCES whatsapp_hub.pur_receipts(id) ON DELETE CASCADE,
  order_item_id      uuid NOT NULL REFERENCES whatsapp_hub.pur_order_items(id) ON DELETE RESTRICT,
  received_qty       numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  accepted_qty       numeric(14,3) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty       numeric(14,3) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  lot                text,
  expiry             date,
  divergence_type    text CHECK (divergence_type IS NULL OR divergence_type IN ('damage', 'wrong_item', 'shortage', 'excess', 'price')),
  divergence_status  text CHECK (divergence_status IS NULL OR divergence_status IN ('analysis', 'resolved', 'accepted', 'rejected')),
  divergence_notes   text CHECK (divergence_notes IS NULL OR length(divergence_notes) <= 500)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  source                text NOT NULL CHECK (source IN ('sefaz', 'xml', 'manual')),
  doc_type              text NOT NULL DEFAULT 'nfe' CHECK (doc_type IN ('nfe', 'recibo', 'boleto', 'contrato', 'outro')),
  number                text NOT NULL,
  series                text,
  access_key            text CHECK (access_key IS NULL OR access_key ~ '^[0-9]{44}$'),
  party_id              uuid REFERENCES whatsapp_hub.fin_parties(id) ON DELETE RESTRICT,
  supplier_doc          text,
  supplier_name         text,
  issue_date            date,
  entry_date            date,
  total_cents           bigint NOT NULL CHECK (total_cents >= 0),
  products_cents        bigint,
  freight_cents         bigint,
  discount_cents        bigint,
  other_cents           bigint,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('summary', 'pending', 'posted', 'ignored', 'canceled_sefaz')),
  manual_reason         text CHECK (manual_reason IS NULL OR length(manual_reason) <= 500),
  xml_path              text,
  has_full_xml          boolean NOT NULL DEFAULT false,
  sefaz_nsu             text,
  sefaz_situation       text,
  manifested_at         timestamptz,
  fin_entry_id          uuid REFERENCES whatsapp_hub.fin_entries(id) ON DELETE RESTRICT,
  fin_reconciled        boolean NOT NULL DEFAULT false,
  fin_diff_accepted     boolean NOT NULL DEFAULT false,
  stock_reconciled      boolean NOT NULL DEFAULT false,
  posted_at             timestamptz,
  ignored_reason        text,
  canceled_reason       text,
  created_by            uuid DEFAULT auth.uid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pur_invoices_key ON whatsapp_hub.pur_invoices (org_id, access_key) WHERE access_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pur_invoices_one_fin ON whatsapp_hub.pur_invoices (fin_entry_id) WHERE fin_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pur_invoices_dates ON whatsapp_hub.pur_invoices (org_id, entry_date, issue_date);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_invoice_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  invoice_id         uuid NOT NULL REFERENCES whatsapp_hub.pur_invoices(id) ON DELETE CASCADE,
  line               int NOT NULL,
  product_code       text,
  description        text NOT NULL,
  ncm                text,
  cfop               text,
  unit               text,
  qty                numeric(14,3) NOT NULL DEFAULT 0,
  unit_cents         bigint NOT NULL DEFAULT 0,
  total_cents        bigint NOT NULL DEFAULT 0,
  gtin               text,
  item_id            uuid REFERENCES whatsapp_hub.inv_items(id) ON DELETE RESTRICT,
  conversion_factor  numeric(14,6) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  lot                text,
  expiry             date,
  location_id        uuid REFERENCES whatsapp_hub.inv_locations(id) ON DELETE RESTRICT,
  stock_posted       boolean NOT NULL DEFAULT false,
  UNIQUE (invoice_id, line)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_invoice_dues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL REFERENCES whatsapp_hub.pur_invoices(id) ON DELETE CASCADE,
  number       text,
  due_date     date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_invoice_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES whatsapp_hub.pur_invoices(id) ON DELETE CASCADE,
  order_id    uuid REFERENCES whatsapp_hub.pur_orders(id) ON DELETE RESTRICT,
  receipt_id  uuid REFERENCES whatsapp_hub.pur_receipts(id) ON DELETE RESTRICT,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR receipt_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS pur_invoice_links_uniq ON whatsapp_hub.pur_invoice_links (invoice_id, COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(receipt_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Estado da busca na SEFAZ (por empresa). O certificado fica cifrado em
-- public.org_settings (sefaz_cert_pfx:<empresa> / sefaz_cert_pass:<empresa>).
CREATE TABLE IF NOT EXISTS whatsapp_hub.pur_sefaz_state (
  company_id     uuid PRIMARY KEY REFERENCES whatsapp_hub.fin_companies(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  uf_code        text NOT NULL DEFAULT '12' CHECK (uf_code ~ '^[0-9]{2}$'),
  cert_cnpj      text,
  cert_subject   text,
  cert_valid_until timestamptz,
  last_nsu       text NOT NULL DEFAULT '000000000000000',
  max_nsu        text,
  last_sync_at   timestamptz,
  next_sync_after timestamptz,
  last_status    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 4. Triggers: updated_at, auditoria, exclusão só de rascunho
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_locations','inv_items','pur_approval_bands','pur_requisitions','pur_quotations',
                           'pur_quotation_suppliers','pur_orders','pur_receipts','pur_invoices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_touch ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_touch()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inv_locations','inv_items','inv_movements','pur_approval_bands','pur_requisitions','pur_requisition_items',
                           'pur_quotations','pur_quotation_items','pur_quotation_suppliers','pur_quotation_prices','pur_orders',
                           'pur_order_items','pur_order_revisions','pur_receipts','pur_receipt_items','pur_invoices',
                           'pur_invoice_items','pur_invoice_dues','pur_invoice_links','pur_sefaz_state'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_audit ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_audit AFTER INSERT OR UPDATE OR DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_audit()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inv_movements','pur_order_revisions','pur_quotations','pur_quotation_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_nodelete ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_nodelete BEFORE DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._fin_no_delete()', t);
  END LOOP;
END $$;

-- Só rascunho se exclui (requisição, pedido, recebimento); nota só enquanto não lançada.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'pur_invoices' THEN
    IF OLD.status = 'posted' OR OLD.fin_entry_id IS NOT NULL OR OLD.stock_reconciled THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta nota já foi lançada e não pode ser excluída. Use "Ignorar" ou "Cancelada na SEFAZ".';
    END IF;
  ELSIF OLD.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Só rascunho pode ser excluído. Este documento já andou no processo: use Cancelar (com motivo).';
  END IF;
  RETURN OLD;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pur_requisitions','pur_orders','pur_receipts','pur_invoices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_delguard ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_delguard BEFORE DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_delete_guard()', t);
  END LOOP;
END $$;

-- Itens de requisição/pedido/recebimento só mudam enquanto o pai é rascunho
-- (ou devolvida, para a requisição). Depois, só pelas RPCs.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_child_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_status text; v_parent uuid;
BEGIN
  IF current_setting('whatsapp_hub.pur_rpc', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'pur_requisition_items' THEN
    v_parent := COALESCE(NEW.requisition_id, OLD.requisition_id);
    SELECT status INTO v_status FROM whatsapp_hub.pur_requisitions WHERE id = v_parent;
    IF v_status NOT IN ('draft', 'returned') THEN
      PERFORM whatsapp_hub.fin_fail('A requisição já foi enviada: os itens não mudam mais. Se precisar, peça para devolver para correção.');
    END IF;
  ELSIF TG_TABLE_NAME = 'pur_order_items' THEN
    v_parent := COALESCE(NEW.order_id, OLD.order_id);
    SELECT status INTO v_status FROM whatsapp_hub.pur_orders WHERE id = v_parent;
    IF v_status <> 'draft' THEN
      PERFORM whatsapp_hub.fin_fail('O pedido já foi emitido: para mudar, use "Revisar pedido" (fica guardado o antes e o motivo).');
    END IF;
  ELSIF TG_TABLE_NAME = 'pur_receipt_items' THEN
    v_parent := COALESCE(NEW.receipt_id, OLD.receipt_id);
    SELECT status INTO v_status FROM whatsapp_hub.pur_receipts WHERE id = v_parent;
    IF v_status <> 'draft' THEN
      PERFORM whatsapp_hub.fin_fail('O recebimento já foi concluído e não muda mais.');
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pur_requisition_items','pur_order_items','pur_receipt_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_guard ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_guard BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_child_guard()', t);
  END LOOP;
END $$;

-- Itens da nota: pela tela só a conciliação de estoque (item, fator, lote,
-- validade, local) — e só enquanto não entrou no estoque.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_invoice_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_status text; v_stock boolean;
BEGIN
  IF current_setting('whatsapp_hub.pur_rpc', true) = 'on' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT status, stock_reconciled INTO v_status, v_stock FROM whatsapp_hub.pur_invoices WHERE id = OLD.invoice_id;
  IF OLD.stock_posted OR v_stock OR v_status IN ('ignored', 'canceled_sefaz') THEN
    PERFORM whatsapp_hub.fin_fail('Este item já deu entrada no estoque (ou a nota foi ignorada/cancelada) e não muda mais.');
  END IF;
  IF (NEW.invoice_id, NEW.org_id, NEW.line, NEW.description, NEW.qty, NEW.unit_cents, NEW.total_cents, NEW.stock_posted)
     IS DISTINCT FROM (OLD.invoice_id, OLD.org_id, OLD.line, OLD.description, OLD.qty, OLD.unit_cents, OLD.total_cents, OLD.stock_posted) THEN
    PERFORM whatsapp_hub.fin_fail('Os dados da nota (descrição, quantidade, valores) vêm do XML e não podem ser alterados.');
  END IF;
  IF NEW.item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.inv_items WHERE id = NEW.item_id AND org_id = OLD.org_id) THEN
    PERFORM whatsapp_hub.fin_fail('Item de estoque inválido.');
  END IF;
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.inv_locations WHERE id = NEW.location_id AND org_id = OLD.org_id) THEN
    PERFORM whatsapp_hub.fin_fail('Local de estoque inválido.');
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_pur_invoice_items_guard ON whatsapp_hub.pur_invoice_items;
CREATE TRIGGER trg_pur_invoice_items_guard BEFORE UPDATE ON whatsapp_hub.pur_invoice_items
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_invoice_item_guard();

-- Integridade das edições pela tela (sem a flag de RPC): pai e vínculos não
-- mudam, contadores só pelas RPCs, e toda referência é da mesma organização.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_ref_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE j jsonb := to_jsonb(NEW); o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  k text; v_ref text; v_ok boolean;
BEGIN
  IF current_setting('whatsapp_hub.pur_rpc', true) = 'on' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- campos que a tela nunca muda depois de criados
  FOREACH k IN ARRAY CASE TG_TABLE_NAME
      WHEN 'pur_requisition_items' THEN ARRAY['requisition_id']
      WHEN 'pur_order_items' THEN ARRAY['order_id', 'requisition_item_id', 'quotation_item_id']
      WHEN 'pur_receipt_items' THEN ARRAY['receipt_id', 'order_item_id']
      WHEN 'pur_receipts' THEN ARRAY['order_id']
      WHEN 'pur_orders' THEN ARRAY['quotation_id', 'requisition_id']
      ELSE ARRAY[]::text[] END LOOP
    IF TG_OP = 'UPDATE' AND (j->>k) IS DISTINCT FROM (o->>k) THEN
      PERFORM whatsapp_hub.fin_fail('Este vínculo do documento não pode ser alterado.');
    END IF;
    IF TG_OP = 'INSERT' AND k IN ('requisition_item_id', 'quotation_item_id', 'quotation_id', 'requisition_id')
       AND TG_TABLE_NAME IN ('pur_order_items', 'pur_orders') AND (j->>k) IS NOT NULL THEN
      PERFORM whatsapp_hub.fin_fail('Pedido ligado a cotação só pode ser criado pela cotação.');
    END IF;
  END LOOP;
  -- contadores: só pelas RPCs
  FOREACH k IN ARRAY CASE TG_TABLE_NAME
      WHEN 'pur_requisition_items' THEN ARRAY['ordered_qty', 'received_qty']
      WHEN 'pur_order_items' THEN ARRAY['received_qty']
      ELSE ARRAY[]::text[] END LOOP
    IF COALESCE((j->>k)::numeric, 0) <> COALESCE((o->>k)::numeric, 0) THEN
      PERFORM whatsapp_hub.fin_fail('Quantidades pedidas/recebidas são controladas pelo sistema.');
    END IF;
  END LOOP;
  -- referências da mesma organização
  FOREACH k IN ARRAY ARRAY['item_id', 'location_id', 'company_id', 'party_id', 'team_id', 'cost_center_id'] LOOP
    v_ref := j->>k;
    CONTINUE WHEN v_ref IS NULL OR NOT (j ? k);
    v_ok := CASE k
        WHEN 'item_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.inv_items WHERE id = v_ref::uuid AND org_id = NEW.org_id)
        WHEN 'location_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.inv_locations WHERE id = v_ref::uuid AND org_id = NEW.org_id)
        WHEN 'company_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = v_ref::uuid AND org_id = NEW.org_id)
        WHEN 'party_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.fin_parties WHERE id = v_ref::uuid AND org_id = NEW.org_id)
        WHEN 'team_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.teams WHERE id = v_ref::uuid AND org_id = NEW.org_id)
        WHEN 'cost_center_id' THEN EXISTS (SELECT 1 FROM whatsapp_hub.fin_cost_centers WHERE id = v_ref::uuid AND org_id = NEW.org_id)
      END;
    IF NOT v_ok THEN
      PERFORM whatsapp_hub.fin_fail('Cadastro inválido para esta organização.');
    END IF;
  END LOOP;
  -- item do recebimento tem de ser do pedido do recebimento
  IF TG_TABLE_NAME = 'pur_receipt_items' AND NOT EXISTS (
       SELECT 1 FROM whatsapp_hub.pur_receipts r JOIN whatsapp_hub.pur_order_items oi ON oi.order_id = r.order_id
        WHERE r.id = (j->>'receipt_id')::uuid AND oi.id = (j->>'order_item_id')::uuid) THEN
    PERFORM whatsapp_hub.fin_fail('Item não pertence ao pedido deste recebimento.');
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pur_requisitions','pur_requisition_items','pur_orders','pur_order_items','pur_receipts','pur_receipt_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_%1$s_refs ON whatsapp_hub.%1$s', t);
    -- "zz": roda depois do trigger que herda o org_id do pai
    EXECUTE format('CREATE TRIGGER zz_%1$s_refs BEFORE INSERT OR UPDATE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_ref_guard()', t);
  END LOOP;
END $$;

-- Cabeçalhos: campos de controle (status, número, aprovação) só mudam pela RPC.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_header_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('whatsapp_hub.pur_rpc', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Documento novo começa como rascunho.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.number IS DISTINCT FROM OLD.number OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Use os botões do documento (enviar, aprovar, emitir, concluir, cancelar) para mudar a situação.';
  END IF;
  IF OLD.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este documento já andou no processo e não pode ser editado diretamente.';
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pur_requisitions','pur_orders','pur_receipts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_hguard ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_hguard BEFORE INSERT OR UPDATE ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_header_guard()', t);
  END LOOP;
END $$;

-- org_id dos filhos herdado do pai (inserts pela tela).
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_child_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'pur_requisition_items' THEN SELECT org_id INTO NEW.org_id FROM whatsapp_hub.pur_requisitions WHERE id = NEW.requisition_id;
  ELSIF TG_TABLE_NAME = 'pur_order_items' THEN SELECT org_id INTO NEW.org_id FROM whatsapp_hub.pur_orders WHERE id = NEW.order_id;
  ELSIF TG_TABLE_NAME = 'pur_receipt_items' THEN SELECT org_id INTO NEW.org_id FROM whatsapp_hub.pur_receipts WHERE id = NEW.receipt_id;
  ELSIF TG_TABLE_NAME = 'pur_quotation_suppliers' THEN SELECT org_id INTO NEW.org_id FROM whatsapp_hub.pur_quotations WHERE id = NEW.quotation_id;
  ELSIF TG_TABLE_NAME = 'pur_quotation_prices' THEN SELECT org_id INTO NEW.org_id FROM whatsapp_hub.pur_quotation_suppliers WHERE id = NEW.quotation_supplier_id;
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pur_requisition_items','pur_order_items','pur_receipt_items','pur_quotation_suppliers','pur_quotation_prices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_org ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_org BEFORE INSERT ON whatsapp_hub.%1$s FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_child_org()', t);
  END LOOP;
END $$;

-- Cotação: fornecedores/preços só mudam com a cotação aberta.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_quote_open_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_status text; v_q uuid;
BEGIN
  IF current_setting('whatsapp_hub.pur_rpc', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'pur_quotation_suppliers' THEN v_q := COALESCE(NEW.quotation_id, OLD.quotation_id);
  ELSE SELECT quotation_id INTO v_q FROM whatsapp_hub.pur_quotation_suppliers WHERE id = COALESCE(NEW.quotation_supplier_id, OLD.quotation_supplier_id);
  END IF;
  SELECT status INTO v_status FROM whatsapp_hub.pur_quotations WHERE id = v_q;
  IF v_status <> 'open' THEN PERFORM whatsapp_hub.fin_fail('A cotação já foi fechada: propostas não mudam mais.'); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_pur_qs_open ON whatsapp_hub.pur_quotation_suppliers;
CREATE TRIGGER trg_pur_qs_open BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_hub.pur_quotation_suppliers FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_quote_open_guard();
DROP TRIGGER IF EXISTS trg_pur_qp_open ON whatsapp_hub.pur_quotation_prices;
CREATE TRIGGER trg_pur_qp_open BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_hub.pur_quotation_prices FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_quote_open_guard();

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_locations','inv_items','inv_movements','pur_counters','pur_approval_bands','pur_requisitions',
                           'pur_requisition_items','pur_quotations','pur_quotation_items','pur_quotation_suppliers',
                           'pur_quotation_prices','pur_orders','pur_order_items','pur_order_revisions','pur_receipts',
                           'pur_receipt_items','pur_invoices','pur_invoice_items','pur_invoice_dues','pur_invoice_links','pur_sefaz_state'] LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON whatsapp_hub.%I TO service_role', t);
    IF t <> 'pur_counters' THEN
      EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON whatsapp_hub.%1$s', t);
      EXECUTE format('CREATE POLICY %1$s_select ON whatsapp_hub.%1$s FOR SELECT TO authenticated
                      USING (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm(''purchases.view'') OR whatsapp_hub.has_perm(''inventory.view'')))', t);
      EXECUTE format('GRANT SELECT ON whatsapp_hub.%I TO authenticated', t);
    END IF;
  END LOOP;
END $$;

-- Escrita direta (o resto é RPC):
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_write_policy(p_table text, p_perm text, p_ops text[] DEFAULT ARRAY['INSERT','UPDATE','DELETE'])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE op text;
BEGIN
  FOREACH op IN ARRAY p_ops LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_%2$s ON whatsapp_hub.%1$s', p_table, lower(op));
    IF op = 'INSERT' THEN
      EXECUTE format('CREATE POLICY %1$s_insert ON whatsapp_hub.%1$s FOR INSERT TO authenticated
                      WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(%2$L))', p_table, p_perm);
    ELSIF op = 'UPDATE' THEN
      EXECUTE format('CREATE POLICY %1$s_update ON whatsapp_hub.%1$s FOR UPDATE TO authenticated
                      USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(%2$L))
                      WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(%2$L))', p_table, p_perm);
    ELSE
      EXECUTE format('CREATE POLICY %1$s_delete ON whatsapp_hub.%1$s FOR DELETE TO authenticated
                      USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(%2$L))', p_table, p_perm);
    END IF;
    EXECUTE format('GRANT %s ON whatsapp_hub.%I TO authenticated', op, p_table);
  END LOOP;
END
$$;
SELECT whatsapp_hub._pur_write_policy('inv_locations', 'inventory.setup');
SELECT whatsapp_hub._pur_write_policy('inv_items', 'inventory.setup');
SELECT whatsapp_hub._pur_write_policy('pur_approval_bands', 'purchases.setup');
SELECT whatsapp_hub._pur_write_policy('pur_requisitions', 'purchases.request');
SELECT whatsapp_hub._pur_write_policy('pur_requisition_items', 'purchases.request');
SELECT whatsapp_hub._pur_write_policy('pur_quotation_suppliers', 'purchases.quote');
SELECT whatsapp_hub._pur_write_policy('pur_quotation_prices', 'purchases.quote');
SELECT whatsapp_hub._pur_write_policy('pur_orders', 'purchases.order');
SELECT whatsapp_hub._pur_write_policy('pur_order_items', 'purchases.order');
SELECT whatsapp_hub._pur_write_policy('pur_receipt_items', 'purchases.receive', ARRAY['UPDATE']);
SELECT whatsapp_hub._pur_write_policy('pur_receipts', 'purchases.receive', ARRAY['UPDATE', 'DELETE']);
SELECT whatsapp_hub._pur_write_policy('pur_invoice_items', 'purchases.invoice', ARRAY['UPDATE']);
SELECT whatsapp_hub._pur_write_policy('pur_invoices', 'purchases.invoice', ARRAY['DELETE']);
-- pur_sefaz_state: só o servidor (api/sefaz) grava.
DROP POLICY IF EXISTS pur_sefaz_state_insert ON whatsapp_hub.pur_sefaz_state;
DROP POLICY IF EXISTS pur_sefaz_state_update ON whatsapp_hub.pur_sefaz_state;
REVOKE INSERT, UPDATE, DELETE ON whatsapp_hub.pur_sefaz_state FROM authenticated;
-- Item novo cadastrado a partir da nota: quem trabalha com notas também cria.
DROP POLICY IF EXISTS inv_items_insert ON whatsapp_hub.inv_items;
CREATE POLICY inv_items_insert ON whatsapp_hub.inv_items FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('inventory.setup') OR whatsapp_hub.has_perm('purchases.invoice')));
-- Requisição: só o autor (ou quem aprova) mexe no rascunho.
DROP POLICY IF EXISTS pur_requisitions_update ON whatsapp_hub.pur_requisitions;
CREATE POLICY pur_requisitions_update ON whatsapp_hub.pur_requisitions FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('purchases.request') AND (requested_by = auth.uid() OR whatsapp_hub.is_full_admin()))
  WITH CHECK (whatsapp_hub.in_org(org_id));
DROP POLICY IF EXISTS pur_requisitions_delete ON whatsapp_hub.pur_requisitions;
CREATE POLICY pur_requisitions_delete ON whatsapp_hub.pur_requisitions FOR DELETE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('purchases.request') AND (requested_by = auth.uid() OR whatsapp_hub.is_full_admin()));

-- Bucket privado: XML das notas e anexos de compra (<org>/<...>).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-hub-purchases', 'whatsapp-hub-purchases', false, 10485760)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS pur_files_select ON storage.objects;
CREATE POLICY pur_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'whatsapp-hub-purchases' AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.has_perm('purchases.view'));

-- ----------------------------------------------------------------------------
-- 6. Visões
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW whatsapp_hub.pur_requisitions_v
WITH (security_invoker = true) AS
SELECT r.*, t.name AS team_name, cc.name AS cost_center_name, c.name AS company_name,
       COALESCE(x.items, 0) AS items_count, COALESCE(x.est, 0)::bigint AS estimated_cents
  FROM whatsapp_hub.pur_requisitions r
  LEFT JOIN whatsapp_hub.teams t ON t.id = r.team_id
  LEFT JOIN whatsapp_hub.fin_cost_centers cc ON cc.id = r.cost_center_id
  LEFT JOIN whatsapp_hub.fin_companies c ON c.id = r.company_id
  LEFT JOIN LATERAL (SELECT count(*) AS items, sum(round(i.qty * COALESCE(i.est_unit_cents, 0))) AS est
                       FROM whatsapp_hub.pur_requisition_items i WHERE i.requisition_id = r.id) x ON true;
GRANT SELECT ON whatsapp_hub.pur_requisitions_v TO authenticated, service_role;

CREATE OR REPLACE VIEW whatsapp_hub.pur_orders_v
WITH (security_invoker = true) AS
SELECT o.*, p.name AS party_name, p.doc AS party_doc, c.name AS company_name,
       COALESCE(x.goods, 0)::bigint AS goods_cents, (COALESCE(x.goods, 0) + o.freight_cents)::bigint AS total_cents,
       COALESCE(x.pending_lines, 0) AS pending_lines, COALESCE(x.lines, 0) AS lines
  FROM whatsapp_hub.pur_orders o
  LEFT JOIN whatsapp_hub.fin_parties p ON p.id = o.party_id
  LEFT JOIN whatsapp_hub.fin_companies c ON c.id = o.company_id
  LEFT JOIN LATERAL (SELECT sum(round(i.qty * i.unit_cents)) AS goods, count(*) AS lines,
                            count(*) FILTER (WHERE i.received_qty < i.qty) AS pending_lines
                       FROM whatsapp_hub.pur_order_items i WHERE i.order_id = o.id) x ON true;
GRANT SELECT ON whatsapp_hub.pur_orders_v TO authenticated, service_role;

CREATE OR REPLACE VIEW whatsapp_hub.pur_invoices_v
WITH (security_invoker = true) AS
SELECT n.*, COALESCE(n.entry_date, n.issue_date) AS effective_date, p.name AS party_name, c.name AS company_name,
       e.total_cents AS fin_total_cents,
       (SELECT count(*) FROM whatsapp_hub.pur_invoice_links l WHERE l.invoice_id = n.id) AS links_count
  FROM whatsapp_hub.pur_invoices n
  LEFT JOIN whatsapp_hub.fin_parties p ON p.id = n.party_id
  LEFT JOIN whatsapp_hub.fin_companies c ON c.id = n.company_id
  LEFT JOIN whatsapp_hub.fin_entries e ON e.id = n.fin_entry_id;
GRANT SELECT ON whatsapp_hub.pur_invoices_v TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Alçadas
-- ----------------------------------------------------------------------------
-- Faixa que cobre o valor (null = sem alçada configurada).
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_band_for(p_org uuid, p_cents bigint)
RETURNS whatsapp_hub.pur_approval_bands
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT b.* FROM whatsapp_hub.pur_approval_bands b
   WHERE b.org_id = p_org AND b.min_cents <= p_cents AND (b.max_cents IS NULL OR p_cents <= b.max_cents)
   ORDER BY b.min_cents DESC LIMIT 1
$$;

-- O usuário pode aprovar este valor? (admin sempre; senão, perfil da faixa)
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_can_approve(p_org uuid, p_cents bigint)
RETURNS boolean
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE b whatsapp_hub.pur_approval_bands; v_role uuid;
BEGIN
  IF whatsapp_hub.is_full_admin() THEN RETURN true; END IF;
  IF NOT whatsapp_hub.has_perm('purchases.approve') THEN RETURN false; END IF;
  b := whatsapp_hub._pur_band_for(p_org, p_cents);
  IF b.id IS NULL THEN RETURN true; END IF;   -- sem alçada configurada para o valor
  SELECT access_role_id INTO v_role FROM whatsapp_hub.app_users WHERE user_id = auth.uid();
  RETURN v_role = b.access_role_id;
END
$$;

-- ----------------------------------------------------------------------------
-- 8. Requisição
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_rpc_on() RETURNS void LANGUAGE sql AS
$$ SELECT set_config('whatsapp_hub.pur_rpc', 'on', true) $$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_req_submit(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.request', 'enviar requisições');
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Requisição não encontrada.'); END IF;
  IF r.status NOT IN ('draft', 'returned') THEN PERFORM whatsapp_hub.fin_fail('Só rascunho ou requisição devolvida pode ser enviada.'); END IF;
  IF r.requested_by <> auth.uid() AND NOT whatsapp_hub.is_full_admin() THEN PERFORM whatsapp_hub.fin_fail('Só quem criou a requisição pode enviá-la.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_requisition_items WHERE requisition_id = r.id) THEN
    PERFORM whatsapp_hub.fin_fail('Adicione pelo menos um item antes de enviar.');
  END IF;
  IF length(btrim(COALESCE(r.justification, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Escreva a justificativa da compra antes de enviar.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_requisitions
     SET status = 'submitted', submitted_at = now(),
         number = COALESCE(number, whatsapp_hub.pur_next_number(org_id, 'REQ')),
         company_id = COALESCE(company_id, whatsapp_hub.fin_default_company(org_id))
   WHERE id = r.id;
END
$$;

-- p_decision: approve | reject | return
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_req_decide(p_id uuid, p_decision text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record; v_est bigint; b whatsapp_hub.pur_approval_bands;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.approve', 'aprovar requisições');
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Requisição não encontrada.'); END IF;
  IF r.status <> 'submitted' THEN PERFORM whatsapp_hub.fin_fail('Esta requisição não está aguardando aprovação.'); END IF;
  IF r.requested_by = auth.uid() THEN PERFORM whatsapp_hub.fin_fail('Quem fez a requisição não pode aprová-la. Peça para outra pessoa com alçada.'); END IF;
  IF p_decision NOT IN ('approve', 'reject', 'return') THEN PERFORM whatsapp_hub.fin_fail('Decisão inválida.'); END IF;
  IF p_decision <> 'approve' AND length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    PERFORM whatsapp_hub.fin_fail('Informe o motivo (pelo menos 5 letras).');
  END IF;
  SELECT COALESCE(sum(round(qty * COALESCE(est_unit_cents, 0))), 0) INTO v_est FROM whatsapp_hub.pur_requisition_items WHERE requisition_id = r.id;
  IF p_decision = 'approve' AND NOT whatsapp_hub._pur_can_approve(r.org_id, v_est) THEN
    PERFORM whatsapp_hub.fin_fail(format('O valor estimado (%s) está numa alçada que o seu perfil não aprova.', whatsapp_hub.fin_brl(v_est)));
  END IF;
  b := whatsapp_hub._pur_band_for(r.org_id, v_est);
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_requisitions
     SET status = CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'returned' END,
         decided_by = auth.uid(), decided_at = now(), decision_reason = NULLIF(btrim(COALESCE(p_reason, '')), ''),
         approved_limit_cents = CASE WHEN p_decision = 'approve' THEN b.max_cents ELSE approved_limit_cents END
   WHERE id = r.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_req_reopen(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.request', 'reabrir requisições');
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Requisição não encontrada.'); END IF;
  IF r.status <> 'rejected' THEN PERFORM whatsapp_hub.fin_fail('Só requisição reprovada pode ser reaberta como rascunho.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_requisitions SET status = 'draft', submitted_at = NULL WHERE id = r.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_req_cancel(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record;
BEGIN
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do cancelamento (pelo menos 5 letras).'); END IF;
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Requisição não encontrada.'); END IF;
  IF r.requested_by <> auth.uid() THEN PERFORM whatsapp_hub.fin_require('purchases.cancel', 'cancelar requisições de outras pessoas'); END IF;
  IF r.status IN ('canceled', 'done') THEN PERFORM whatsapp_hub.fin_fail('Esta requisição já está encerrada.'); END IF;
  IF r.status = 'draft' THEN PERFORM whatsapp_hub.fin_fail('Rascunho não precisa cancelar: é só excluir.'); END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.pur_quotations WHERE requisition_id = r.id AND status IN ('open', 'pending_approval', 'approved')) THEN
    PERFORM whatsapp_hub.fin_fail('Esta requisição tem cotação em andamento. Cancele a cotação antes.');
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.pur_orders WHERE requisition_id = r.id AND status IN ('issued', 'partial', 'received')) THEN
    PERFORM whatsapp_hub.fin_fail('Esta requisição já virou pedido. Cancele o pedido antes.');
  END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_requisitions SET status = 'canceled', cancel_reason = btrim(p_reason) WHERE id = r.id;
END
$$;

-- ----------------------------------------------------------------------------
-- 9. Cotação
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_create(p_requisition uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE r record; v_id uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.quote', 'abrir cotações');
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = p_requisition AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Requisição não encontrada.'); END IF;
  IF r.status <> 'approved' THEN PERFORM whatsapp_hub.fin_fail('Só requisição aprovada (e sem cotação em andamento) pode ser cotada.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  INSERT INTO whatsapp_hub.pur_quotations (org_id, number, requisition_id, created_by)
  VALUES (r.org_id, whatsapp_hub.pur_next_number(r.org_id, 'COT'), r.id, auth.uid()) RETURNING id INTO v_id;
  INSERT INTO whatsapp_hub.pur_quotation_items (org_id, quotation_id, requisition_item_id, item_id, description, qty, unit)
  SELECT r.org_id, v_id, i.id, i.item_id, i.description, i.qty - i.ordered_qty, i.unit
    FROM whatsapp_hub.pur_requisition_items i WHERE i.requisition_id = r.id AND i.qty > i.ordered_qty;
  UPDATE whatsapp_hub.pur_requisitions SET status = 'quoting' WHERE id = r.id;
  RETURN v_id;
END
$$;

-- Vencedor de um item. Fora do menor preço exige justificativa.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_set_winner(p_item uuid, p_supplier uuid, p_justification text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE qi record; q record; v_price bigint; v_min bigint; s record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.quote', 'escolher vencedores da cotação');
  SELECT * INTO qi FROM whatsapp_hub.pur_quotation_items WHERE id = p_item AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Item da cotação não encontrado.'); END IF;
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = qi.quotation_id;
  IF q.status <> 'open' THEN PERFORM whatsapp_hub.fin_fail('A cotação já foi fechada.'); END IF;
  IF p_supplier IS NULL THEN
    PERFORM whatsapp_hub._pur_rpc_on();
    UPDATE whatsapp_hub.pur_quotation_items SET winner_supplier_id = NULL, winner_justification = NULL WHERE id = qi.id;
    RETURN;
  END IF;
  SELECT * INTO s FROM whatsapp_hub.pur_quotation_suppliers WHERE id = p_supplier AND quotation_id = q.id;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Fornecedor não faz parte desta cotação.'); END IF;
  IF s.status IN ('no_response', 'declined') THEN PERFORM whatsapp_hub.fin_fail('Este fornecedor está marcado como sem resposta/recusou.'); END IF;
  SELECT unit_cents INTO v_price FROM whatsapp_hub.pur_quotation_prices WHERE quotation_supplier_id = s.id AND quotation_item_id = qi.id;
  IF v_price IS NULL THEN PERFORM whatsapp_hub.fin_fail('Este fornecedor não deu preço para o item.'); END IF;
  SELECT min(pp.unit_cents) INTO v_min FROM whatsapp_hub.pur_quotation_prices pp
    JOIN whatsapp_hub.pur_quotation_suppliers ss ON ss.id = pp.quotation_supplier_id
   WHERE pp.quotation_item_id = qi.id AND ss.status NOT IN ('no_response', 'declined');
  IF v_price > v_min AND length(btrim(COALESCE(p_justification, ''))) < 5 THEN
    PERFORM whatsapp_hub.fin_fail(format('Este não é o menor preço (menor: %s). Escreva a justificativa da escolha.', whatsapp_hub.fin_brl(v_min)));
  END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_quotation_items
     SET winner_supplier_id = s.id, winner_justification = CASE WHEN v_price > v_min THEN btrim(p_justification) END
   WHERE id = qi.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub._pur_quote_total(p_q uuid)
RETURNS bigint
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT COALESCE((SELECT sum(round(qi.qty * pp.unit_cents))
                     FROM whatsapp_hub.pur_quotation_items qi
                     JOIN whatsapp_hub.pur_quotation_prices pp ON pp.quotation_item_id = qi.id AND pp.quotation_supplier_id = qi.winner_supplier_id
                    WHERE qi.quotation_id = p_q), 0)
       + COALESCE((SELECT sum(s.freight_cents) FROM whatsapp_hub.pur_quotation_suppliers s
                    WHERE s.quotation_id = p_q AND s.id IN (SELECT winner_supplier_id FROM whatsapp_hub.pur_quotation_items WHERE quotation_id = p_q)), 0)
$$;

-- Fechar: todos os itens com vencedor. Estourou a alçada da requisição → aprovação.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_close(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE q record; r record; v_total bigint; v_status text;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.quote', 'fechar cotações');
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Cotação não encontrada.'); END IF;
  IF q.status <> 'open' THEN PERFORM whatsapp_hub.fin_fail('Esta cotação já foi fechada.'); END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.pur_quotation_items WHERE quotation_id = q.id AND winner_supplier_id IS NULL) THEN
    PERFORM whatsapp_hub.fin_fail('Escolha o vencedor de todos os itens no mapa comparativo antes de fechar.');
  END IF;
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = q.requisition_id;
  v_total := whatsapp_hub._pur_quote_total(q.id);
  v_status := CASE WHEN r.approved_limit_cents IS NOT NULL AND v_total > r.approved_limit_cents THEN 'pending_approval' ELSE 'approved' END;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_quotations SET status = v_status, total_cents = v_total WHERE id = q.id;
  RETURN v_status;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_approve(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE q record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.approve', 'aprovar estouro de alçada');
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Cotação não encontrada.'); END IF;
  IF q.status <> 'pending_approval' THEN PERFORM whatsapp_hub.fin_fail('Esta cotação não está aguardando aprovação.'); END IF;
  IF q.created_by = auth.uid() THEN PERFORM whatsapp_hub.fin_fail('Quem montou a cotação não pode aprovar o estouro de alçada.'); END IF;
  IF NOT whatsapp_hub._pur_can_approve(q.org_id, q.total_cents) THEN
    PERFORM whatsapp_hub.fin_fail(format('O total (%s) está numa alçada que o seu perfil não aprova.', whatsapp_hub.fin_brl(q.total_cents)));
  END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_quotations SET status = 'approved', approved_by = auth.uid(), approved_at = now(),
         approval_reason = NULLIF(btrim(COALESCE(p_reason, '')), '') WHERE id = q.id;
END
$$;

-- Reabrir uma cotação em aprovação (estouro recusado) para ajustar.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_reopen(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE q record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.quote', 'reabrir cotações');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo (pelo menos 5 letras).'); END IF;
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Cotação não encontrada.'); END IF;
  IF q.status NOT IN ('pending_approval', 'approved') THEN PERFORM whatsapp_hub.fin_fail('Só cotação fechada (sem pedido) pode ser reaberta.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_quotations SET status = 'open', approval_reason = 'Reaberta: ' || btrim(p_reason), approved_by = NULL, approved_at = NULL WHERE id = q.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_quote_cancel(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE q record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.cancel', 'cancelar cotações');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do cancelamento (pelo menos 5 letras).'); END IF;
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Cotação não encontrada.'); END IF;
  IF q.status IN ('ordered', 'canceled') THEN PERFORM whatsapp_hub.fin_fail('Esta cotação já virou pedido ou já está cancelada.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_quotations SET status = 'canceled', cancel_reason = btrim(p_reason) WHERE id = q.id;
  -- Devolve o saldo para Compras: a requisição volta a "aprovada" para nova cotação.
  UPDATE whatsapp_hub.pur_requisitions SET status = 'approved' WHERE id = q.requisition_id AND status = 'quoting';
END
$$;

-- ----------------------------------------------------------------------------
-- 10. Pedido
-- ----------------------------------------------------------------------------
-- Um pedido por fornecedor vencedor, sem redigitar.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_order_from_quote(p_quote uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE q record; r record; s record; v_order uuid; v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.order', 'emitir pedidos');
  SELECT * INTO q FROM whatsapp_hub.pur_quotations WHERE id = p_quote AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Cotação não encontrada.'); END IF;
  IF q.status <> 'approved' THEN
    PERFORM whatsapp_hub.fin_fail(CASE WHEN q.status = 'pending_approval' THEN 'A cotação está aguardando aprovação do estouro de alçada.'
                                       ELSE 'Feche a cotação (com os vencedores) antes de emitir os pedidos.' END);
  END IF;
  SELECT * INTO r FROM whatsapp_hub.pur_requisitions WHERE id = q.requisition_id;
  PERFORM whatsapp_hub._pur_rpc_on();
  FOR s IN SELECT DISTINCT qs.* FROM whatsapp_hub.pur_quotation_suppliers qs
             JOIN whatsapp_hub.pur_quotation_items qi ON qi.winner_supplier_id = qs.id WHERE qi.quotation_id = q.id LOOP
    INSERT INTO whatsapp_hub.pur_orders (org_id, number, company_id, party_id, quotation_id, requisition_id, status,
      freight_cents, payment_terms, expected_date, issued_at, created_by)
    VALUES (q.org_id, whatsapp_hub.pur_next_number(q.org_id, 'PED'), COALESCE(r.company_id, whatsapp_hub.fin_default_company(q.org_id)),
      s.party_id, q.id, r.id, 'issued', s.freight_cents, s.payment_terms,
      CASE WHEN s.lead_time_days IS NOT NULL THEN whatsapp_hub.fin_today() + s.lead_time_days END, now(), auth.uid())
    RETURNING id INTO v_order;
    INSERT INTO whatsapp_hub.pur_order_items (org_id, order_id, item_id, description, qty, unit, unit_cents, requisition_item_id, quotation_item_id)
    SELECT q.org_id, v_order, qi.item_id, qi.description, qi.qty, qi.unit, pp.unit_cents, qi.requisition_item_id, qi.id
      FROM whatsapp_hub.pur_quotation_items qi
      JOIN whatsapp_hub.pur_quotation_prices pp ON pp.quotation_item_id = qi.id AND pp.quotation_supplier_id = s.id
     WHERE qi.quotation_id = q.id AND qi.winner_supplier_id = s.id;
    UPDATE whatsapp_hub.pur_requisition_items ri SET ordered_qty = ri.ordered_qty + qi.qty
      FROM whatsapp_hub.pur_quotation_items qi WHERE qi.quotation_id = q.id AND qi.winner_supplier_id = s.id AND ri.id = qi.requisition_item_id;
    v_ids := v_ids || v_order;
  END LOOP;
  UPDATE whatsapp_hub.pur_quotations SET status = 'ordered' WHERE id = q.id;
  UPDATE whatsapp_hub.pur_requisitions SET status = 'ordered' WHERE id = r.id;
  RETURN v_ids;
END
$$;

-- Pedido avulso (criado como rascunho pela tela) → emitir.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_order_issue(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE o record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.order', 'emitir pedidos');
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Pedido não encontrado.'); END IF;
  IF o.status <> 'draft' THEN PERFORM whatsapp_hub.fin_fail('Este pedido já foi emitido.'); END IF;
  IF o.party_id IS NULL THEN PERFORM whatsapp_hub.fin_fail('Escolha o fornecedor antes de emitir.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id) THEN PERFORM whatsapp_hub.fin_fail('Adicione pelo menos um item.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_orders SET status = 'issued', issued_at = now(),
         number = COALESCE(number, whatsapp_hub.pur_next_number(org_id, 'PED')),
         company_id = COALESCE(company_id, whatsapp_hub.fin_default_company(org_id))
   WHERE id = o.id;
END
$$;

-- Revisão de pedido emitido: guarda o antes e o motivo.
-- p: {freight_cents?, payment_terms?, expected_date?, notes?, items: [{id?, description, qty, unit, unit_cents, item_id?, remove?}]}
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_order_revise(p_id uuid, p jsonb, p_reason text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE o record; v_before jsonb; it jsonb; cur record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.order', 'revisar pedidos');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo da revisão (pelo menos 5 letras).'); END IF;
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Pedido não encontrado.'); END IF;
  IF o.status NOT IN ('issued', 'partial') THEN PERFORM whatsapp_hub.fin_fail('Só pedido emitido (com saldo a receber) pode ser revisado.'); END IF;
  SELECT to_jsonb(o) || jsonb_build_object('items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at) FROM whatsapp_hub.pur_order_items i WHERE i.order_id = o.id), '[]'::jsonb))
    INTO v_before;
  PERFORM whatsapp_hub._pur_rpc_on();
  IF jsonb_typeof(p->'items') = 'array' THEN
    FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
      IF NULLIF(it->>'id', '') IS NOT NULL THEN
        SELECT * INTO cur FROM whatsapp_hub.pur_order_items WHERE id = (it->>'id')::uuid AND order_id = o.id;
        IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Item do pedido não encontrado.'); END IF;
        IF (it->>'remove')::boolean IS TRUE THEN
          IF cur.received_qty > 0 THEN PERFORM whatsapp_hub.fin_fail(format('O item "%s" já teve recebimento e não pode sair do pedido.', cur.description)); END IF;
          DELETE FROM whatsapp_hub.pur_order_items WHERE id = cur.id;
        ELSE
          IF COALESCE((it->>'qty')::numeric, cur.qty) < cur.received_qty THEN
            PERFORM whatsapp_hub.fin_fail(format('A quantidade de "%s" não pode ficar menor que o já recebido (%s).', cur.description, cur.received_qty));
          END IF;
          UPDATE whatsapp_hub.pur_order_items SET
            description = COALESCE(NULLIF(btrim(it->>'description'), ''), description),
            qty = COALESCE((it->>'qty')::numeric, qty), unit = COALESCE(NULLIF(it->>'unit', ''), unit),
            unit_cents = COALESCE((it->>'unit_cents')::bigint, unit_cents)
          WHERE id = cur.id;
        END IF;
      ELSE
        INSERT INTO whatsapp_hub.pur_order_items (org_id, order_id, item_id, description, qty, unit, unit_cents)
        VALUES (o.org_id, o.id, NULLIF(it->>'item_id', '')::uuid, btrim(it->>'description'), (it->>'qty')::numeric,
                COALESCE(NULLIF(it->>'unit', ''), 'UN'), (it->>'unit_cents')::bigint);
      END IF;
    END LOOP;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id) THEN PERFORM whatsapp_hub.fin_fail('O pedido precisa de pelo menos um item.'); END IF;
  UPDATE whatsapp_hub.pur_orders SET
    revision = revision + 1,
    freight_cents = COALESCE((p->>'freight_cents')::bigint, freight_cents),
    payment_terms = CASE WHEN p ? 'payment_terms' THEN NULLIF(p->>'payment_terms', '') ELSE payment_terms END,
    expected_date = CASE WHEN p ? 'expected_date' THEN NULLIF(p->>'expected_date', '')::date ELSE expected_date END,
    notes = CASE WHEN p ? 'notes' THEN NULLIF(p->>'notes', '') ELSE notes END,
    status = CASE WHEN NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id AND received_qty < qty) THEN 'received'
                  WHEN EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id AND received_qty > 0) THEN 'partial' ELSE 'issued' END
  WHERE id = o.id;
  INSERT INTO whatsapp_hub.pur_order_revisions (org_id, order_id, revision, before, reason, created_by)
  VALUES (o.org_id, o.id, o.revision + 1, v_before, btrim(p_reason), auth.uid());
  RETURN o.revision + 1;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_order_cancel(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE o record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.cancel', 'cancelar pedidos');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do cancelamento (pelo menos 5 letras).'); END IF;
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Pedido não encontrado.'); END IF;
  IF o.status = 'draft' THEN PERFORM whatsapp_hub.fin_fail('Rascunho não precisa cancelar: é só excluir.'); END IF;
  IF o.status IN ('canceled', 'received') THEN PERFORM whatsapp_hub.fin_fail('Este pedido já está encerrado.'); END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.pur_receipts WHERE order_id = o.id AND status = 'done') THEN
    PERFORM whatsapp_hub.fin_fail('Este pedido já tem recebimento concluído. Estorne o recebimento antes ou revise o pedido.');
  END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  UPDATE whatsapp_hub.pur_orders SET status = 'canceled', cancel_reason = btrim(p_reason) WHERE id = o.id;
  UPDATE whatsapp_hub.pur_receipts SET status = 'canceled' WHERE order_id = o.id AND status = 'draft';
  -- Devolve à requisição o que estava pedido.
  UPDATE whatsapp_hub.pur_requisition_items ri SET ordered_qty = GREATEST(ri.ordered_qty - oi.qty, 0)
    FROM whatsapp_hub.pur_order_items oi WHERE oi.order_id = o.id AND ri.id = oi.requisition_item_id;
  UPDATE whatsapp_hub.pur_requisitions SET status = 'approved'
   WHERE id = o.requisition_id AND status = 'ordered'
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_orders WHERE requisition_id = o.requisition_id AND status IN ('issued', 'partial', 'received'));
END
$$;

-- ----------------------------------------------------------------------------
-- 11. Recebimento
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_receipt_create(p_order uuid, p_location uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE o record; v_id uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.receive', 'conferir recebimentos');
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = p_order AND org_id = whatsapp_hub.current_org_id();
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Pedido não encontrado.'); END IF;
  IF o.status NOT IN ('issued', 'partial') THEN PERFORM whatsapp_hub.fin_fail('Só pedido emitido com saldo pode ser recebido.'); END IF;
  IF p_location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.inv_locations WHERE id = p_location AND org_id = o.org_id AND is_active) THEN
    PERFORM whatsapp_hub.fin_fail('Local de estoque inválido.');
  END IF;
  SELECT id INTO v_id FROM whatsapp_hub.pur_receipts WHERE order_id = o.id AND status = 'draft' LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;   -- continua a conferência em aberto
  PERFORM whatsapp_hub._pur_rpc_on();
  INSERT INTO whatsapp_hub.pur_receipts (org_id, number, order_id, location_id, created_by)
  VALUES (o.org_id, whatsapp_hub.pur_next_number(o.org_id, 'REC'), o.id, p_location, auth.uid()) RETURNING id INTO v_id;
  INSERT INTO whatsapp_hub.pur_receipt_items (org_id, receipt_id, order_item_id, received_qty, accepted_qty)
  SELECT o.org_id, v_id, i.id, i.qty - i.received_qty, i.qty - i.received_qty
    FROM whatsapp_hub.pur_order_items i WHERE i.order_id = o.id AND i.received_qty < i.qty;
  RETURN v_id;
END
$$;

-- Concluir (numa transação só): estoque entra SÓ com a aceita; pedido e requisição atualizados.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_receipt_complete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE rc record; o record; li record; v_pending numeric;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.receive', 'concluir recebimentos');
  SELECT * INTO rc FROM whatsapp_hub.pur_receipts WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Recebimento não encontrado.'); END IF;
  IF rc.status <> 'draft' THEN PERFORM whatsapp_hub.fin_fail('Este recebimento já foi concluído.'); END IF;
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = rc.order_id AND org_id = rc.org_id FOR UPDATE;
  IF o.status NOT IN ('issued', 'partial') THEN PERFORM whatsapp_hub.fin_fail('O pedido não está mais aberto para recebimento.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_receipt_items WHERE receipt_id = rc.id AND received_qty > 0) THEN
    PERFORM whatsapp_hub.fin_fail('Informe a quantidade recebida de pelo menos um item.');
  END IF;
  FOR li IN SELECT ri.*, oi.qty AS ordered, oi.received_qty AS already, oi.description, oi.item_id, oi.unit_cents, it.requires_lot
              FROM whatsapp_hub.pur_receipt_items ri
              JOIN whatsapp_hub.pur_order_items oi ON oi.id = ri.order_item_id
              LEFT JOIN whatsapp_hub.inv_items it ON it.id = oi.item_id
             WHERE ri.receipt_id = rc.id LOOP
    IF li.accepted_qty + li.rejected_qty <> li.received_qty THEN
      PERFORM whatsapp_hub.fin_fail(format('Em "%s": aceita + recusada precisa ser igual à recebida.', li.description));
    END IF;
    v_pending := li.ordered - li.already;
    IF li.accepted_qty > v_pending AND COALESCE(li.divergence_type, '') <> 'excess' THEN
      PERFORM whatsapp_hub.fin_fail(format('Em "%s": aceitou mais que o pendente (%s). Registre a divergência "sobra" ou ajuste.', li.description, v_pending));
    END IF;
    IF li.divergence_type = 'excess' AND li.accepted_qty > v_pending AND COALESCE(li.divergence_status, '') <> 'accepted' THEN
      PERFORM whatsapp_hub.fin_fail(format('Em "%s": a sobra só entra se a divergência estiver como "aceita".', li.description));
    END IF;
    IF li.rejected_qty > 0 AND li.divergence_type IS NULL THEN
      PERFORM whatsapp_hub.fin_fail(format('Em "%s": houve recusa — informe o tipo de divergência.', li.description));
    END IF;
    IF li.accepted_qty > 0 AND li.item_id IS NOT NULL AND li.requires_lot AND (li.lot IS NULL OR btrim(li.lot) = '') THEN
      PERFORM whatsapp_hub.fin_fail(format('O item "%s" exige lote/validade.', li.description));
    END IF;
    IF li.accepted_qty > 0 AND li.item_id IS NOT NULL AND rc.location_id IS NULL THEN
      PERFORM whatsapp_hub.fin_fail('Escolha o local de estoque do recebimento.');
    END IF;
  END LOOP;

  PERFORM whatsapp_hub._pur_rpc_on();
  -- Estoque: só a quantidade ACEITA (itens do catálogo).
  INSERT INTO whatsapp_hub.inv_movements (org_id, item_id, location_id, qty, unit_cost_cents, lot, expiry, source, source_id, created_by)
  SELECT rc.org_id, oi.item_id, rc.location_id, ri.accepted_qty, oi.unit_cents, NULLIF(btrim(COALESCE(ri.lot, '')), ''), ri.expiry, 'receipt', rc.id, auth.uid()
    FROM whatsapp_hub.pur_receipt_items ri JOIN whatsapp_hub.pur_order_items oi ON oi.id = ri.order_item_id
   WHERE ri.receipt_id = rc.id AND ri.accepted_qty > 0 AND oi.item_id IS NOT NULL;
  UPDATE whatsapp_hub.inv_items it SET last_cost_cents = oi.unit_cents
    FROM whatsapp_hub.pur_receipt_items ri JOIN whatsapp_hub.pur_order_items oi ON oi.id = ri.order_item_id
   WHERE ri.receipt_id = rc.id AND ri.accepted_qty > 0 AND it.id = oi.item_id;
  -- Pedido e requisição.
  UPDATE whatsapp_hub.pur_order_items oi SET received_qty = oi.received_qty + ri.accepted_qty
    FROM whatsapp_hub.pur_receipt_items ri WHERE ri.receipt_id = rc.id AND oi.id = ri.order_item_id;
  UPDATE whatsapp_hub.pur_requisition_items rq SET received_qty = rq.received_qty + ri.accepted_qty
    FROM whatsapp_hub.pur_receipt_items ri JOIN whatsapp_hub.pur_order_items oi ON oi.id = ri.order_item_id
   WHERE ri.receipt_id = rc.id AND rq.id = oi.requisition_item_id;
  UPDATE whatsapp_hub.pur_orders SET status = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id AND received_qty < qty)
                                                   THEN 'partial' ELSE 'received' END WHERE id = o.id;
  IF o.requisition_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM whatsapp_hub.pur_requisition_items WHERE requisition_id = o.requisition_id AND received_qty < qty) THEN
    UPDATE whatsapp_hub.pur_requisitions SET status = 'done' WHERE id = o.requisition_id;
  END IF;
  UPDATE whatsapp_hub.pur_receipts SET status = 'done', done_by = auth.uid(), done_at = now() WHERE id = rc.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_receipt_reverse(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE rc record; o record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.receive_reverse', 'estornar recebimentos');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo do estorno (pelo menos 5 letras).'); END IF;
  SELECT * INTO rc FROM whatsapp_hub.pur_receipts WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Recebimento não encontrado.'); END IF;
  IF rc.status <> 'done' THEN PERFORM whatsapp_hub.fin_fail('Só recebimento concluído pode ser estornado.'); END IF;
  SELECT * INTO o FROM whatsapp_hub.pur_orders WHERE id = rc.order_id AND org_id = rc.org_id FOR UPDATE;
  IF o.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('O pedido deste recebimento está cancelado.'); END IF;
  PERFORM whatsapp_hub._pur_rpc_on();
  INSERT INTO whatsapp_hub.inv_movements (org_id, item_id, location_id, qty, unit_cost_cents, lot, expiry, source, source_id, notes, created_by)
  SELECT m.org_id, m.item_id, m.location_id, -m.qty, m.unit_cost_cents, m.lot, m.expiry, 'receipt_reversal', rc.id, btrim(p_reason), auth.uid()
    FROM whatsapp_hub.inv_movements m WHERE m.source = 'receipt' AND m.source_id = rc.id;
  UPDATE whatsapp_hub.pur_order_items oi SET received_qty = GREATEST(oi.received_qty - ri.accepted_qty, 0)
    FROM whatsapp_hub.pur_receipt_items ri WHERE ri.receipt_id = rc.id AND oi.id = ri.order_item_id;
  UPDATE whatsapp_hub.pur_requisition_items rq SET received_qty = GREATEST(rq.received_qty - ri.accepted_qty, 0)
    FROM whatsapp_hub.pur_receipt_items ri JOIN whatsapp_hub.pur_order_items oi ON oi.id = ri.order_item_id
   WHERE ri.receipt_id = rc.id AND rq.id = oi.requisition_item_id;
  UPDATE whatsapp_hub.pur_orders SET status = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_hub.pur_order_items WHERE order_id = o.id AND received_qty > 0)
                                                   THEN 'partial' ELSE 'issued' END WHERE id = o.id;
  UPDATE whatsapp_hub.pur_requisitions SET status = 'ordered' WHERE id = o.requisition_id AND status = 'done';
  UPDATE whatsapp_hub.pur_receipts SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reverse_reason = btrim(p_reason) WHERE id = rc.id;
END
$$;

-- ----------------------------------------------------------------------------
-- 12. Notas de entrada
-- ----------------------------------------------------------------------------
-- Fornecedor pelo CNPJ/CPF, sem duplicar.
CREATE OR REPLACE FUNCTION whatsapp_hub._pur_party_by_doc(p_org uuid, p_doc text, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_doc text := NULLIF(regexp_replace(COALESCE(p_doc, ''), '\D', '', 'g'), ''); v_id uuid;
BEGIN
  IF v_doc IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM whatsapp_hub.fin_parties WHERE org_id = p_org AND doc = v_doc ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE whatsapp_hub.fin_parties SET kind = 'both' WHERE id = v_id AND kind = 'customer';
    RETURN v_id;
  END IF;
  INSERT INTO whatsapp_hub.fin_parties (org_id, kind, name, doc)
  VALUES (p_org, 'supplier', COALESCE(NULLIF(btrim(p_name), ''), 'Fornecedor ' || v_doc), v_doc) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Importa uma nota já lida do XML (pela tela ou pela busca na SEFAZ).
-- p: {source, access_key, number, series, issue_date, entry_date?, supplier_doc, supplier_name, dest_doc?,
--     total_cents, products_cents, freight_cents, discount_cents, other_cents, xml_path?, has_full_xml, nsu?, situation?,
--     items: [{line, code, description, ncm, cfop, unit, qty, unit_cents, total_cents, gtin}], dues: [{number, due_date, amount_cents}],
--     org_id? (serviço)}
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_import(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := COALESCE(whatsapp_hub.current_org_id(), NULLIF(p->>'org_id', '')::uuid);
  v_key text := NULLIF(regexp_replace(COALESCE(p->>'access_key', ''), '\D', '', 'g'), '');
  v_existing record; v_company uuid; v_party uuid; v_id uuid; it jsonb; d jsonb;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'importar notas');
  IF v_org IS NULL THEN PERFORM whatsapp_hub.fin_fail('Organização não identificada.'); END IF;
  IF v_key IS NOT NULL AND length(v_key) <> 44 THEN PERFORM whatsapp_hub.fin_fail('Chave de acesso inválida (precisa de 44 números).'); END IF;
  -- Empresa: a do CNPJ destinatário, se for do grupo; senão, a padrão.
  SELECT id INTO v_company FROM whatsapp_hub.fin_companies
   WHERE org_id = v_org AND cnpj = NULLIF(regexp_replace(COALESCE(p->>'dest_doc', ''), '\D', '', 'g'), '') LIMIT 1;
  v_company := COALESCE(NULLIF(p->>'company_id', '')::uuid, v_company, whatsapp_hub.fin_default_company(v_org));
  IF v_company IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = v_company AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Empresa inválida.');
  END IF;
  IF v_company IS NULL THEN PERFORM whatsapp_hub.fin_fail('Cadastre a empresa do grupo no Financeiro antes de importar notas.'); END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM whatsapp_hub.pur_invoices WHERE org_id = v_org AND access_key = v_key;
    IF FOUND THEN
      -- Já existe: só completa o resumo da SEFAZ com o XML completo.
      IF v_existing.has_full_xml OR NOT COALESCE((p->>'has_full_xml')::boolean, false) THEN
        IF auth.uid() IS NOT NULL AND p->>'source' = 'xml' THEN
          PERFORM whatsapp_hub.fin_fail(format('Esta nota (%s) já está cadastrada.', COALESCE(v_existing.number, v_key)));
        END IF;
        RETURN v_existing.id;
      END IF;
      DELETE FROM whatsapp_hub.pur_invoice_items WHERE invoice_id = v_existing.id;
      DELETE FROM whatsapp_hub.pur_invoice_dues WHERE invoice_id = v_existing.id;
      v_id := v_existing.id;
    END IF;
  END IF;

  v_party := whatsapp_hub._pur_party_by_doc(v_org, p->>'supplier_doc', p->>'supplier_name');
  IF v_id IS NULL THEN
    INSERT INTO whatsapp_hub.pur_invoices (org_id, company_id, source, doc_type, number, series, access_key, party_id, supplier_doc,
      supplier_name, issue_date, entry_date, total_cents, products_cents, freight_cents, discount_cents, other_cents,
      status, xml_path, has_full_xml, sefaz_nsu, sefaz_situation, created_by)
    VALUES (v_org, v_company, COALESCE(p->>'source', 'xml'), 'nfe', COALESCE(NULLIF(p->>'number', ''), '?'), NULLIF(p->>'series', ''), v_key,
      v_party, NULLIF(regexp_replace(COALESCE(p->>'supplier_doc', ''), '\D', '', 'g'), ''), NULLIF(p->>'supplier_name', ''),
      NULLIF(p->>'issue_date', '')::date, NULLIF(p->>'entry_date', '')::date, COALESCE((p->>'total_cents')::bigint, 0),
      (p->>'products_cents')::bigint, (p->>'freight_cents')::bigint, (p->>'discount_cents')::bigint, (p->>'other_cents')::bigint,
      CASE WHEN COALESCE((p->>'has_full_xml')::boolean, false) THEN 'pending' ELSE 'summary' END,
      NULLIF(p->>'xml_path', ''), COALESCE((p->>'has_full_xml')::boolean, false), NULLIF(p->>'nsu', ''), NULLIF(p->>'situation', ''), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE whatsapp_hub.pur_invoices SET
      number = COALESCE(NULLIF(p->>'number', ''), number), series = COALESCE(NULLIF(p->>'series', ''), series), party_id = COALESCE(v_party, party_id),
      issue_date = COALESCE(NULLIF(p->>'issue_date', '')::date, issue_date), total_cents = COALESCE((p->>'total_cents')::bigint, total_cents),
      products_cents = (p->>'products_cents')::bigint, freight_cents = (p->>'freight_cents')::bigint,
      discount_cents = (p->>'discount_cents')::bigint, other_cents = (p->>'other_cents')::bigint,
      xml_path = COALESCE(NULLIF(p->>'xml_path', ''), xml_path), has_full_xml = true,
      status = CASE WHEN status = 'summary' THEN 'pending' ELSE status END
    WHERE id = v_id;
  END IF;

  IF jsonb_typeof(p->'items') = 'array' THEN
    FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
      INSERT INTO whatsapp_hub.pur_invoice_items (org_id, invoice_id, line, product_code, description, ncm, cfop, unit, qty, unit_cents, total_cents, gtin, item_id)
      VALUES (v_org, v_id, (it->>'line')::int, NULLIF(it->>'code', ''), COALESCE(NULLIF(it->>'description', ''), 'Item'), NULLIF(it->>'ncm', ''),
              NULLIF(it->>'cfop', ''), NULLIF(it->>'unit', ''), COALESCE((it->>'qty')::numeric, 0), COALESCE((it->>'unit_cents')::bigint, 0),
              COALESCE((it->>'total_cents')::bigint, 0), NULLIF(it->>'gtin', ''),
              -- sugestão: mesmo código de barras ou mesmo código já usado deste fornecedor
              (SELECT x.id FROM whatsapp_hub.inv_items x WHERE x.org_id = v_org AND x.is_active
                 AND ((NULLIF(it->>'gtin', '') IS NOT NULL AND x.gtin = it->>'gtin')) LIMIT 1));
    END LOOP;
  END IF;
  IF jsonb_typeof(p->'dues') = 'array' THEN
    FOR d IN SELECT * FROM jsonb_array_elements(p->'dues') LOOP
      IF NULLIF(d->>'due_date', '') IS NOT NULL AND COALESCE((d->>'amount_cents')::bigint, 0) > 0 THEN
        INSERT INTO whatsapp_hub.pur_invoice_dues (org_id, invoice_id, number, due_date, amount_cents)
        VALUES (v_org, v_id, NULLIF(d->>'number', ''), (d->>'due_date')::date, (d->>'amount_cents')::bigint);
      END IF;
    END LOOP;
  END IF;
  RETURN v_id;
END
$$;

-- Entrada manual: recibo, boleto, contrato… (motivo obrigatório).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_manual(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); v_id uuid; v_company uuid; v_party uuid := NULLIF(p->>'party_id', '')::uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'lançar notas manuais');
  IF COALESCE(p->>'doc_type', '') NOT IN ('recibo', 'boleto', 'contrato', 'outro', 'nfe') THEN PERFORM whatsapp_hub.fin_fail('Escolha o tipo do documento.'); END IF;
  IF length(btrim(COALESCE(p->>'number', ''))) = 0 THEN PERFORM whatsapp_hub.fin_fail('Informe o número do documento.'); END IF;
  IF NULLIF(p->>'issue_date', '') IS NULL THEN PERFORM whatsapp_hub.fin_fail('Informe a data de emissão.'); END IF;
  IF COALESCE(p->>'total_cents', '') !~ '^[0-9]+$' OR (p->>'total_cents')::bigint <= 0 THEN PERFORM whatsapp_hub.fin_fail('Informe o valor (maior que zero).'); END IF;
  IF length(btrim(COALESCE(p->>'manual_reason', ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo da entrada manual (pelo menos 5 letras).'); END IF;
  IF length(p->>'manual_reason') > 500 THEN PERFORM whatsapp_hub.fin_fail('O motivo tem no máximo 500 caracteres.'); END IF;
  IF v_party IS NULL THEN v_party := whatsapp_hub._pur_party_by_doc(v_org, p->>'supplier_doc', p->>'supplier_name'); END IF;
  IF v_party IS NULL OR NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_parties WHERE id = v_party AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Escolha o fornecedor (ou informe o CNPJ/CPF).');
  END IF;
  v_company := COALESCE(NULLIF(p->>'company_id', '')::uuid, whatsapp_hub.fin_default_company(v_org));
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = v_company AND org_id = v_org AND is_active) THEN
    PERFORM whatsapp_hub.fin_fail('Empresa inválida.');
  END IF;
  INSERT INTO whatsapp_hub.pur_invoices (org_id, company_id, source, doc_type, number, party_id, supplier_doc, supplier_name,
    issue_date, entry_date, total_cents, status, manual_reason, has_full_xml, created_by)
  SELECT v_org, v_company, 'manual', p->>'doc_type', btrim(p->>'number'), v_party, pt.doc, pt.name,
    (p->>'issue_date')::date, COALESCE(NULLIF(p->>'entry_date', '')::date, whatsapp_hub.fin_today()), (p->>'total_cents')::bigint,
    'pending', btrim(p->>'manual_reason'), false, auth.uid()
    FROM whatsapp_hub.fin_parties pt WHERE pt.id = v_party
  RETURNING id INTO v_id;
  IF NULLIF(p->>'due_date', '') IS NOT NULL THEN
    INSERT INTO whatsapp_hub.pur_invoice_dues (org_id, invoice_id, number, due_date, amount_cents)
    VALUES (v_org, v_id, '1', (p->>'due_date')::date, (p->>'total_cents')::bigint);
  END IF;
  RETURN v_id;
END
$$;

-- Datas da nota (entrada) e status simples.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_set(p_id uuid, p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'alterar notas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.status IN ('posted', 'canceled_sefaz') THEN PERFORM whatsapp_hub.fin_fail('Nota lançada ou cancelada não muda.'); END IF;
  IF p ? 'company_id' AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies WHERE id = NULLIF(p->>'company_id', '')::uuid AND org_id = n.org_id AND is_active) THEN
    PERFORM whatsapp_hub.fin_fail('Empresa inválida.');
  END IF;
  UPDATE whatsapp_hub.pur_invoices SET
    entry_date = CASE WHEN p ? 'entry_date' THEN NULLIF(p->>'entry_date', '')::date ELSE entry_date END,
    company_id = CASE WHEN p ? 'company_id' AND n.fin_entry_id IS NULL THEN (p->>'company_id')::uuid ELSE company_id END
  WHERE id = n.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_ignore(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'ignorar notas');
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN PERFORM whatsapp_hub.fin_fail('Informe o motivo (pelo menos 5 letras).'); END IF;
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.status = 'posted' THEN PERFORM whatsapp_hub.fin_fail('Nota já lançada não pode ser ignorada.'); END IF;
  UPDATE whatsapp_hub.pur_invoices SET status = 'ignored', ignored_reason = btrim(p_reason) WHERE id = n.id;
END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_unignore(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'reativar notas');
  UPDATE whatsapp_hub.pur_invoices SET status = CASE WHEN has_full_xml OR source = 'manual' THEN 'pending' ELSE 'summary' END, ignored_reason = NULL
   WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() AND status = 'ignored';
END
$$;

-- Cancelada na SEFAZ: preserva o registro.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_mark_canceled(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'marcar notas como canceladas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.fin_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM whatsapp_hub.fin_entries WHERE id = n.fin_entry_id AND status = 'active') THEN
    PERFORM whatsapp_hub.fin_fail('Esta nota tem conta a pagar ativa no Financeiro. Cancele a conta a pagar antes.');
  END IF;
  UPDATE whatsapp_hub.pur_invoices SET status = 'canceled_sefaz', canceled_reason = NULLIF(btrim(COALESCE(p_reason, '')), '') WHERE id = n.id;
END
$$;

-- Vínculos com pedido(s) e recebimento(s).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_link(p_id uuid, p_order uuid, p_receipt uuid, p_remove boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record; v_org uuid := whatsapp_hub.current_org_id();
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'vincular notas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.stock_reconciled THEN PERFORM whatsapp_hub.fin_fail('A nota já deu entrada no estoque: os vínculos não mudam mais.'); END IF;
  IF p_remove THEN
    DELETE FROM whatsapp_hub.pur_invoice_links WHERE invoice_id = n.id
      AND order_id IS NOT DISTINCT FROM p_order AND receipt_id IS NOT DISTINCT FROM p_receipt;
    RETURN;
  END IF;
  IF p_order IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_orders WHERE id = p_order AND org_id = v_org AND status <> 'canceled') THEN
    PERFORM whatsapp_hub.fin_fail('Pedido não encontrado ou cancelado.');
  END IF;
  IF p_receipt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_receipts WHERE id = p_receipt AND org_id = v_org AND status = 'done') THEN
    PERFORM whatsapp_hub.fin_fail('Só recebimento concluído pode ser vinculado.');
  END IF;
  INSERT INTO whatsapp_hub.pur_invoice_links (org_id, invoice_id, order_id, receipt_id, created_by)
  VALUES (v_org, n.id, p_order, p_receipt, auth.uid()) ON CONFLICT DO NOTHING;
  -- Pedido vinculado → seus recebimentos concluídos também.
  IF p_order IS NOT NULL THEN
    INSERT INTO whatsapp_hub.pur_invoice_links (org_id, invoice_id, order_id, receipt_id, created_by)
    SELECT v_org, n.id, NULL, r.id, auth.uid() FROM whatsapp_hub.pur_receipts r WHERE r.order_id = p_order AND r.status = 'done'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;

-- Pedidos prováveis: mesmo fornecedor, abertos/recebidos, valor parecido.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_suggest_orders(p_id uuid)
RETURNS TABLE (order_id uuid, number text, party_name text, total_cents bigint, status text, issued_at timestamptz, score int)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.view', 'ver compras');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id();
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT o.id, o.number, o.party_name, o.total_cents, o.status, o.issued_at,
         ((CASE WHEN o.party_id = n.party_id THEN 50 ELSE 0 END)
          + (CASE WHEN n.total_cents > 0 AND abs(o.total_cents - n.total_cents) <= n.total_cents / 20 THEN 40
                  WHEN n.total_cents > 0 AND abs(o.total_cents - n.total_cents) <= n.total_cents / 5 THEN 20 ELSE 0 END)
          + (CASE WHEN o.status IN ('issued', 'partial') THEN 10 ELSE 0 END))::int
    FROM whatsapp_hub.pur_orders_v o
   WHERE o.org_id = n.org_id AND o.status IN ('issued', 'partial', 'received')
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_invoice_links l WHERE l.invoice_id = n.id AND l.order_id = o.id)
     AND (o.party_id = n.party_id OR (n.total_cents > 0 AND abs(o.total_cents - n.total_cents) <= n.total_cents / 5))
   ORDER BY 7 DESC, o.issued_at DESC NULLS LAST
   LIMIT 10;
END
$$;

-- Contas a pagar parecidas com a nota (mesma empresa).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_fin_candidates(p_id uuid)
RETURNS TABLE (entry_id uuid, description text, party_name text, total_cents bigint, competence_date date, first_due date, score int)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record; v_ref date;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'conciliar notas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id();
  IF NOT FOUND THEN RETURN; END IF;
  v_ref := COALESCE(n.issue_date, n.entry_date, whatsapp_hub.fin_today());
  RETURN QUERY
  SELECT e.id, e.description, p.name, e.total_cents, e.competence_date,
         (SELECT min(i.due_date) FROM whatsapp_hub.fin_installments i WHERE i.entry_id = e.id),
         ((CASE WHEN e.party_id = n.party_id THEN 50 ELSE 0 END)
          + (CASE WHEN e.total_cents = n.total_cents THEN 40 WHEN abs(e.total_cents - n.total_cents) <= GREATEST(n.total_cents / 20, 100) THEN 25 ELSE 0 END)
          + (CASE WHEN abs(e.competence_date - v_ref) <= 7 THEN 15 WHEN abs(e.competence_date - v_ref) <= 30 THEN 5 ELSE 0 END))::int
    FROM whatsapp_hub.fin_entries e
    LEFT JOIN whatsapp_hub.fin_parties p ON p.id = e.party_id
   WHERE e.org_id = n.org_id AND e.company_id = n.company_id AND e.kind = 'payable' AND e.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.pur_invoices x WHERE x.fin_entry_id = e.id)
     AND (e.party_id = n.party_id OR abs(e.total_cents - n.total_cents) <= GREATEST(n.total_cents / 10, 100) OR abs(e.competence_date - v_ref) <= 15)
   ORDER BY 7 DESC, e.created_at DESC
   LIMIT 15;
END
$$;

-- Vincula uma conta a pagar existente (uma nota = uma conta). Diferença exige aceite.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_fin_link(p_id uuid, p_entry uuid, p_accept_diff boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record; e record;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'conciliar notas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.status IN ('ignored', 'canceled_sefaz', 'summary') THEN PERFORM whatsapp_hub.fin_fail('Esta nota não pode ser conciliada na situação atual.'); END IF;
  IF n.fin_entry_id IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Esta nota já está conciliada com uma conta a pagar (uma nota = uma conta).'); END IF;
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = p_entry AND org_id = n.org_id;
  IF NOT FOUND OR e.kind <> 'payable' OR e.status <> 'active' THEN PERFORM whatsapp_hub.fin_fail('Escolha uma conta a pagar ativa.'); END IF;
  IF e.company_id <> n.company_id THEN PERFORM whatsapp_hub.fin_fail('A conta a pagar precisa ser da MESMA empresa da nota.'); END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_hub.pur_invoices WHERE fin_entry_id = e.id) THEN PERFORM whatsapp_hub.fin_fail('Esta conta a pagar já está ligada a outra nota.'); END IF;
  IF e.total_cents <> n.total_cents AND NOT COALESCE(p_accept_diff, false) THEN
    PERFORM whatsapp_hub.fin_fail(format('O valor da nota (%s) é diferente da conta a pagar (%s). Marque o aceite da diferença para conciliar.',
      whatsapp_hub.fin_brl(n.total_cents), whatsapp_hub.fin_brl(e.total_cents)));
  END IF;
  PERFORM whatsapp_hub.fin_link_purchase(e.id, n.id::text);
  UPDATE whatsapp_hub.pur_invoices SET fin_entry_id = e.id, fin_reconciled = true,
         fin_diff_accepted = (e.total_cents <> n.total_cents) WHERE id = n.id;
END
$$;

-- Cria a conta a pagar a partir da nota (empresa da nota, fornecedor e vencimentos da nota).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_fin_create(p_id uuid, p_chart uuid, p_cost_center uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record; v_sched jsonb; v_entry uuid;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'conciliar notas');
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.status IN ('ignored', 'canceled_sefaz', 'summary') THEN PERFORM whatsapp_hub.fin_fail('Esta nota não pode gerar conta a pagar na situação atual.'); END IF;
  IF n.fin_entry_id IS NOT NULL THEN PERFORM whatsapp_hub.fin_fail('Esta nota já tem conta a pagar (uma nota = uma conta).'); END IF;
  IF n.total_cents <= 0 THEN PERFORM whatsapp_hub.fin_fail('A nota está sem valor.'); END IF;
  SELECT CASE WHEN sum(amount_cents) = n.total_cents
              THEN jsonb_agg(jsonb_build_object('due_date', due_date, 'amount_cents', amount_cents) ORDER BY due_date) END
    INTO v_sched FROM whatsapp_hub.pur_invoice_dues WHERE invoice_id = n.id;
  v_entry := whatsapp_hub.fin_create_entry_schedule(jsonb_build_object(
    'kind', 'payable', 'company_id', n.company_id, 'party_id', n.party_id,
    'description', CASE n.doc_type WHEN 'nfe' THEN 'NF-e ' ELSE initcap(n.doc_type) || ' ' END || n.number || COALESCE(' — ' || n.supplier_name, ''),
    'chart_account_id', p_chart, 'cost_center_id', p_cost_center, 'total_cents', n.total_cents,
    'issue_date', COALESCE(n.issue_date, whatsapp_hub.fin_today()), 'competence_date', COALESCE(n.issue_date, n.entry_date, whatsapp_hub.fin_today()),
    'due_date', COALESCE((SELECT min(due_date) FROM whatsapp_hub.pur_invoice_dues WHERE invoice_id = n.id), n.entry_date, n.issue_date, whatsapp_hub.fin_today()),
    'installments', 1, 'schedule', v_sched, 'source', 'purchase', 'source_ref', n.id::text,
    'notes', CASE WHEN n.access_key IS NOT NULL THEN 'Chave ' || n.access_key END));
  UPDATE whatsapp_hub.pur_invoices SET fin_entry_id = v_entry, fin_reconciled = true WHERE id = n.id;
  RETURN v_entry;
END
$$;

-- Lançar: Financeiro, Estoque ou os dois.
-- Estoque: nota com pedido/recebimento já entrou pelo recebimento (não em dobro).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_post(p_id uuid, p_finance boolean, p_stock boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE n record; li record; v_via_receipt boolean;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.invoice', 'lançar notas');
  PERFORM whatsapp_hub._pur_rpc_on();
  SELECT * INTO n FROM whatsapp_hub.pur_invoices WHERE id = p_id AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Nota não encontrada.'); END IF;
  IF n.status IN ('ignored', 'canceled_sefaz') THEN PERFORM whatsapp_hub.fin_fail('Nota ignorada ou cancelada não é lançada.'); END IF;
  IF n.status = 'summary' THEN PERFORM whatsapp_hub.fin_fail('Esta nota ainda é só o resumo da SEFAZ. Dê ciência e baixe o XML completo antes de lançar.'); END IF;
  IF NOT COALESCE(p_finance, false) AND NOT COALESCE(p_stock, false) THEN PERFORM whatsapp_hub.fin_fail('Escolha lançar no Financeiro, no Estoque ou nos dois.'); END IF;
  IF p_finance AND n.fin_entry_id IS NULL THEN
    PERFORM whatsapp_hub.fin_fail('Faça a conciliação financeira antes (vincule uma conta a pagar ou crie uma nova).');
  END IF;
  IF p_stock AND NOT n.stock_reconciled THEN
    v_via_receipt := EXISTS (SELECT 1 FROM whatsapp_hub.pur_invoice_links WHERE invoice_id = n.id);
    IF NOT v_via_receipt THEN
      FOR li IN SELECT ii.*, it.requires_lot FROM whatsapp_hub.pur_invoice_items ii LEFT JOIN whatsapp_hub.inv_items it ON it.id = ii.item_id
                 WHERE ii.invoice_id = n.id AND NOT ii.stock_posted LOOP
        IF li.item_id IS NULL THEN PERFORM whatsapp_hub.fin_fail(format('Linha %s ("%s"): ligue a um item do catálogo ou cadastre como item novo.', li.line, li.description)); END IF;
        IF li.location_id IS NULL THEN PERFORM whatsapp_hub.fin_fail(format('Linha %s: escolha o local de entrada.', li.line)); END IF;
        IF li.requires_lot AND (li.lot IS NULL OR btrim(li.lot) = '') THEN PERFORM whatsapp_hub.fin_fail(format('Linha %s: o item exige lote.', li.line)); END IF;
      END LOOP;
      INSERT INTO whatsapp_hub.inv_movements (org_id, item_id, location_id, qty, unit_cost_cents, lot, expiry, source, source_id, created_by)
      SELECT n.org_id, ii.item_id, ii.location_id, round(ii.qty * ii.conversion_factor, 3),
             CASE WHEN ii.qty * ii.conversion_factor > 0 THEN round(ii.total_cents / (ii.qty * ii.conversion_factor))::bigint END,
             NULLIF(btrim(COALESCE(ii.lot, '')), ''), ii.expiry, 'invoice', n.id, auth.uid()
        FROM whatsapp_hub.pur_invoice_items ii WHERE ii.invoice_id = n.id AND NOT ii.stock_posted AND ii.qty > 0;
      UPDATE whatsapp_hub.pur_invoice_items SET stock_posted = true WHERE invoice_id = n.id;
    END IF;
    UPDATE whatsapp_hub.pur_invoices SET stock_reconciled = true WHERE id = n.id;
  END IF;
  UPDATE whatsapp_hub.pur_invoices SET
    status = CASE WHEN (fin_reconciled OR p_finance) THEN 'posted' ELSE status END,
    posted_at = COALESCE(posted_at, now())
  WHERE id = n.id;
END
$$;

-- Cartões da lista de notas (período por entrada/emissão/cadastro).
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_invoice_summary(p_from date, p_to date, p_by text)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); v_days int := (p_to - p_from) + 1; cur jsonb; prev bigint;
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.view', 'ver compras');
  WITH base AS (
    SELECT n.*, CASE p_by WHEN 'issue' THEN n.issue_date WHEN 'created' THEN (n.created_at AT TIME ZONE 'America/Sao_Paulo')::date
                         ELSE COALESCE(n.entry_date, n.issue_date) END AS d
      FROM whatsapp_hub.pur_invoices n WHERE n.org_id = v_org AND n.status NOT IN ('ignored', 'canceled_sefaz')
  )
  SELECT jsonb_build_object(
    'count', count(*) FILTER (WHERE d BETWEEN p_from AND p_to),
    'total_cents', COALESCE(sum(total_cents) FILTER (WHERE d BETWEEN p_from AND p_to), 0),
    'fin_pending_count', count(*) FILTER (WHERE d BETWEEN p_from AND p_to AND NOT fin_reconciled AND status <> 'summary'),
    'fin_pending_cents', COALESCE(sum(total_cents) FILTER (WHERE d BETWEEN p_from AND p_to AND NOT fin_reconciled AND status <> 'summary'), 0),
    'stock_pending_count', count(*) FILTER (WHERE d BETWEEN p_from AND p_to AND NOT stock_reconciled AND status <> 'summary'),
    'stock_pending_cents', COALESCE(sum(total_cents) FILTER (WHERE d BETWEEN p_from AND p_to AND NOT stock_reconciled AND status <> 'summary'), 0),
    'summary_count', count(*) FILTER (WHERE d BETWEEN p_from AND p_to AND status = 'summary')),
    COALESCE(sum(total_cents) FILTER (WHERE d BETWEEN p_from - v_days AND p_from - 1), 0)
  INTO cur, prev FROM base;
  RETURN cur || jsonb_build_object('prev_total_cents', prev);
END
$$;

-- Rastro REQ → COT → PED → REC → NF.
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_trace(p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id(); v_req uuid; v_orders uuid[];
BEGIN
  PERFORM whatsapp_hub.fin_require('purchases.view', 'ver compras');
  IF p_kind = 'requisition' THEN SELECT id INTO v_req FROM whatsapp_hub.pur_requisitions WHERE id = p_id AND org_id = v_org;
  ELSIF p_kind = 'quotation' THEN SELECT requisition_id INTO v_req FROM whatsapp_hub.pur_quotations WHERE id = p_id AND org_id = v_org;
  ELSIF p_kind = 'order' THEN SELECT requisition_id INTO v_req FROM whatsapp_hub.pur_orders WHERE id = p_id AND org_id = v_org; v_orders := ARRAY[p_id];
  ELSIF p_kind = 'receipt' THEN SELECT o.requisition_id, ARRAY[o.id] INTO v_req, v_orders FROM whatsapp_hub.pur_receipts r JOIN whatsapp_hub.pur_orders o ON o.id = r.order_id WHERE r.id = p_id AND r.org_id = v_org;
  ELSIF p_kind = 'invoice' THEN
    SELECT array_agg(DISTINCT COALESCE(l.order_id, r.order_id)) INTO v_orders
      FROM whatsapp_hub.pur_invoice_links l LEFT JOIN whatsapp_hub.pur_receipts r ON r.id = l.receipt_id WHERE l.invoice_id = p_id AND l.org_id = v_org;
    SELECT requisition_id INTO v_req FROM whatsapp_hub.pur_orders WHERE id = ANY (v_orders) AND requisition_id IS NOT NULL LIMIT 1;
  END IF;
  IF v_req IS NOT NULL THEN
    SELECT array_agg(id) INTO v_orders FROM (SELECT id FROM whatsapp_hub.pur_orders WHERE requisition_id = v_req
                                             UNION SELECT unnest(COALESCE(v_orders, ARRAY[]::uuid[]))) x;
  END IF;
  RETURN jsonb_build_object(
    'requisitions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'number', number, 'status', status)) FROM whatsapp_hub.pur_requisitions WHERE id = v_req), '[]'::jsonb),
    'quotations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'number', number, 'status', status)) FROM whatsapp_hub.pur_quotations WHERE requisition_id = v_req), '[]'::jsonb),
    'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'number', number, 'status', status)) FROM whatsapp_hub.pur_orders WHERE id = ANY (COALESCE(v_orders, ARRAY[]::uuid[]))), '[]'::jsonb),
    'receipts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'number', number, 'status', status)) FROM whatsapp_hub.pur_receipts WHERE order_id = ANY (COALESCE(v_orders, ARRAY[]::uuid[]))), '[]'::jsonb),
    'invoices', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', n.id, 'number', n.number, 'status', n.status))
                            FROM whatsapp_hub.pur_invoices n JOIN whatsapp_hub.pur_invoice_links l ON l.invoice_id = n.id
                            LEFT JOIN whatsapp_hub.pur_receipts r ON r.id = l.receipt_id
                           WHERE COALESCE(l.order_id, r.order_id) = ANY (COALESCE(v_orders, ARRAY[]::uuid[]))), '[]'::jsonb));
END
$$;

-- Permissões de execução (cada função confere a permissão por dentro).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'pur_req_submit(uuid)', 'pur_req_decide(uuid, text, text)', 'pur_req_reopen(uuid)', 'pur_req_cancel(uuid, text)',
    'pur_quote_create(uuid)', 'pur_quote_set_winner(uuid, uuid, text)', 'pur_quote_close(uuid)', 'pur_quote_approve(uuid, text)',
    'pur_quote_reopen(uuid, text)', 'pur_quote_cancel(uuid, text)', 'pur_order_from_quote(uuid)', 'pur_order_issue(uuid)',
    'pur_order_revise(uuid, jsonb, text)', 'pur_order_cancel(uuid, text)', 'pur_receipt_create(uuid, uuid)',
    'pur_receipt_complete(uuid)', 'pur_receipt_reverse(uuid, text)', 'pur_invoice_import(jsonb)', 'pur_invoice_manual(jsonb)',
    'pur_invoice_set(uuid, jsonb)', 'pur_invoice_ignore(uuid, text)', 'pur_invoice_unignore(uuid)', 'pur_invoice_mark_canceled(uuid, text)',
    'pur_invoice_link(uuid, uuid, uuid, boolean)', 'pur_invoice_suggest_orders(uuid)', 'pur_invoice_fin_candidates(uuid)',
    'pur_invoice_fin_link(uuid, uuid, boolean)', 'pur_invoice_fin_create(uuid, uuid, uuid)', 'pur_invoice_post(uuid, boolean, boolean)',
    'pur_invoice_summary(date, date, text)', 'pur_trace(text, uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION whatsapp_hub.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION whatsapp_hub.%s TO authenticated, service_role', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._pur_party_by_doc(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._pur_rpc_on() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._pur_can_approve(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub._pur_can_approve(uuid, bigint) TO authenticated;
