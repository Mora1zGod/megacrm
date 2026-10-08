-- ============================================================================
-- Fornecedores: cadastro completo + painel (notas, pedidos, contas a pagar)
--
-- O fornecedor continua sendo a "pessoa" do Financeiro (fin_parties): o mesmo
-- cadastro serve para Compras, Notas de entrada e Contas a pagar — sem duplicar.
-- ============================================================================
SET search_path TO whatsapp_hub, public, extensions;

-- 1) Permissão para cadastrar/editar fornecedores (Compras)
INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('purchases.suppliers', 'purchases', 'suppliers', 'Cadastrar e editar fornecedores', 1310)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;
INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
SELECT ar.id, 'purchases.suppliers' FROM whatsapp_hub.access_roles ar
 WHERE ar.name IN ('Gerente', 'Financeiro') AND ar.is_system
ON CONFLICT DO NOTHING;

-- 2) Campos do cadastro completo
ALTER TABLE whatsapp_hub.fin_parties
  ADD COLUMN IF NOT EXISTS trade_name        text,
  ADD COLUMN IF NOT EXISTS state_registration text,
  ADD COLUMN IF NOT EXISTS municipal_registration text,
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS contact_name      text,
  ADD COLUMN IF NOT EXISTS whatsapp          text,
  ADD COLUMN IF NOT EXISTS website           text,
  ADD COLUMN IF NOT EXISTS zip_code          text,
  ADD COLUMN IF NOT EXISTS street            text,
  ADD COLUMN IF NOT EXISTS street_number     text,
  ADD COLUMN IF NOT EXISTS complement        text,
  ADD COLUMN IF NOT EXISTS district          text,
  ADD COLUMN IF NOT EXISTS city              text,
  ADD COLUMN IF NOT EXISTS state             text,
  ADD COLUMN IF NOT EXISTS bank_name         text,
  ADD COLUMN IF NOT EXISTS bank_agency       text,
  ADD COLUMN IF NOT EXISTS bank_account      text,
  ADD COLUMN IF NOT EXISTS pix_key           text,
  ADD COLUMN IF NOT EXISTS payment_terms     text,
  ADD COLUMN IF NOT EXISTS default_chart_account_id uuid REFERENCES whatsapp_hub.fin_chart_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes             text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_parties_state_chk') THEN
    ALTER TABLE whatsapp_hub.fin_parties ADD CONSTRAINT fin_parties_state_chk CHECK (state IS NULL OR state ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_parties_notes_chk') THEN
    ALTER TABLE whatsapp_hub.fin_parties ADD CONSTRAINT fin_parties_notes_chk CHECK (notes IS NULL OR length(notes) <= 4000);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS fin_parties_org_doc_idx ON whatsapp_hub.fin_parties (org_id, doc) WHERE doc IS NOT NULL;

-- Mesmo CNPJ/CPF não entra duas vezes na mesma organização.
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
  IF NEW.doc IS NOT NULL AND EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_parties x WHERE x.org_id = NEW.org_id AND x.doc = NEW.doc AND x.id <> NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Já existe um cadastro com este CNPJ/CPF.';
  END IF;
  NEW.zip_code := NULLIF(regexp_replace(COALESCE(NEW.zip_code, ''), '\D', '', 'g'), '');
  NEW.state := NULLIF(upper(btrim(COALESCE(NEW.state, ''))), '');
  NEW.trade_name := NULLIF(btrim(COALESCE(NEW.trade_name, '')), '');
  NEW.category := NULLIF(btrim(COALESCE(NEW.category, '')), '');
  IF NEW.default_chart_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM whatsapp_hub.fin_chart_accounts c WHERE c.id = NEW.default_chart_account_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Conta do plano inválida.';
  END IF;
  RETURN NEW;
END
$$;

-- 3) RLS: quem usa Compras vê os cadastros de apoio; quem tem
--    purchases.suppliers cadastra/edita fornecedor.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_parties', 'fin_companies', 'fin_cost_centers', 'fin_chart_accounts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select_pur ON whatsapp_hub.%1$s', t);
    EXECUTE format('CREATE POLICY %1$s_select_pur ON whatsapp_hub.%1$s FOR SELECT TO authenticated
                    USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm(''purchases.view''))', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS fin_parties_insert ON whatsapp_hub.fin_parties;
CREATE POLICY fin_parties_insert ON whatsapp_hub.fin_parties FOR INSERT TO authenticated
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('financial.setup') OR whatsapp_hub.has_perm('financial.ledger_create')
                                               OR whatsapp_hub.has_perm('purchases.suppliers')));
DROP POLICY IF EXISTS fin_parties_update ON whatsapp_hub.fin_parties;
CREATE POLICY fin_parties_update ON whatsapp_hub.fin_parties FOR UPDATE TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('financial.setup') OR whatsapp_hub.has_perm('purchases.suppliers')))
  WITH CHECK (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('financial.setup') OR whatsapp_hub.has_perm('purchases.suppliers')));

-- Histórico do cadastro também para quem usa Compras.
DROP POLICY IF EXISTS fin_audit_select ON whatsapp_hub.fin_audit_log;
CREATE POLICY fin_audit_select ON whatsapp_hub.fin_audit_log FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (whatsapp_hub.has_perm('audit.view')
    OR (table_name LIKE 'fin\_%' AND whatsapp_hub.has_perm('financial.ledger_view'))
    OR (table_name = 'fin_parties' AND whatsapp_hub.has_perm('purchases.view'))
    OR ((table_name LIKE 'pur\_%' OR table_name LIKE 'inv\_%') AND whatsapp_hub.has_perm('purchases.view'))));

-- 4) Lista com números (respeita a RLS de quem consulta)
CREATE OR REPLACE VIEW whatsapp_hub.pur_suppliers_v
WITH (security_invoker = true) AS
SELECT p.*,
       inv.invoices_count, inv.invoices_12m_cents, inv.last_invoice_date,
       ord.open_orders_count, ord.open_orders_cents, ord.last_order_at,
       pay.open_payable_cents, pay.overdue_cents
  FROM whatsapp_hub.fin_parties p
  LEFT JOIN LATERAL (
    SELECT count(*) AS invoices_count,
           COALESCE(sum(n.total_cents) FILTER (WHERE COALESCE(n.entry_date, n.issue_date) >= whatsapp_hub.fin_today() - 365), 0)::bigint AS invoices_12m_cents,
           max(COALESCE(n.entry_date, n.issue_date)) AS last_invoice_date
      FROM whatsapp_hub.pur_invoices n WHERE n.party_id = p.id AND n.status NOT IN ('ignored', 'canceled_sefaz')
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE o.status IN ('issued', 'partial')) AS open_orders_count,
           COALESCE(sum(o.total_cents) FILTER (WHERE o.status IN ('issued', 'partial')), 0)::bigint AS open_orders_cents,
           max(o.issued_at) AS last_order_at
      FROM whatsapp_hub.pur_orders_v o WHERE o.party_id = p.id
  ) ord ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(i.remaining_cents), 0)::bigint AS open_payable_cents,
           COALESCE(sum(i.remaining_cents) FILTER (WHERE i.status = 'overdue'), 0)::bigint AS overdue_cents
      FROM whatsapp_hub.fin_installments_v i WHERE i.party_id = p.id AND i.kind = 'payable' AND i.status IN ('open', 'partial', 'overdue')
  ) pay ON true;
GRANT SELECT ON whatsapp_hub.pur_suppliers_v TO authenticated, service_role;

-- 5) Painel de um fornecedor
CREATE OR REPLACE FUNCTION whatsapp_hub.pur_supplier_dashboard(p_party uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_org uuid := whatsapp_hub.current_org_id();
  v_fin boolean := whatsapp_hub.has_perm('financial.ledger_view');
  v_pur boolean := whatsapp_hub.has_perm('purchases.view');
  v_today date := whatsapp_hub.fin_today();
  v_from date := (date_trunc('month', whatsapp_hub.fin_today()) - interval '11 months')::date;
  out jsonb := '{}'::jsonb;
BEGIN
  IF NOT (v_fin OR v_pur) THEN PERFORM whatsapp_hub.fin_fail('Você não tem permissão para ver fornecedores.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_parties WHERE id = p_party AND org_id = v_org) THEN
    PERFORM whatsapp_hub.fin_fail('Fornecedor não encontrado.');
  END IF;

  IF v_pur THEN
    out := out || jsonb_build_object(
      'invoices', (SELECT jsonb_build_object(
          'count', count(*),
          'total_cents', COALESCE(sum(total_cents), 0),
          'total_12m_cents', COALESCE(sum(total_cents) FILTER (WHERE d >= v_today - 365), 0),
          'count_12m', count(*) FILTER (WHERE d >= v_today - 365),
          'avg_cents', COALESCE(round(avg(total_cents)), 0),
          'first_date', min(d), 'last_date', max(d),
          'pending_fin', count(*) FILTER (WHERE NOT fin_reconciled AND status = 'pending'),
          'pending_stock', count(*) FILTER (WHERE NOT stock_reconciled AND status = 'pending'))
        FROM (SELECT n.*, COALESCE(n.entry_date, n.issue_date) AS d FROM whatsapp_hub.pur_invoices n
               WHERE n.org_id = v_org AND n.party_id = p_party AND n.status NOT IN ('ignored', 'canceled_sefaz')) x),
      'monthly', (SELECT COALESCE(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'total_cents', COALESCE(t.total, 0)) ORDER BY m), '[]'::jsonb)
        FROM generate_series(v_from, date_trunc('month', v_today)::date, interval '1 month') m
        LEFT JOIN (SELECT date_trunc('month', COALESCE(n.entry_date, n.issue_date))::date AS mm, sum(n.total_cents) AS total
                     FROM whatsapp_hub.pur_invoices n
                    WHERE n.org_id = v_org AND n.party_id = p_party AND n.status NOT IN ('ignored', 'canceled_sefaz')
                      AND COALESCE(n.entry_date, n.issue_date) >= v_from
                    GROUP BY 1) t ON t.mm = m::date),
      'orders', (SELECT jsonb_build_object(
          'count', count(*) FILTER (WHERE status <> 'draft'),
          'open_count', count(*) FILTER (WHERE status IN ('issued', 'partial')),
          'open_cents', COALESCE(sum(total_cents) FILTER (WHERE status IN ('issued', 'partial')), 0),
          'received_count', count(*) FILTER (WHERE status = 'received'),
          'canceled_count', count(*) FILTER (WHERE status = 'canceled'),
          'total_cents', COALESCE(sum(total_cents) FILTER (WHERE status NOT IN ('draft', 'canceled')), 0),
          'last_at', max(issued_at))
        FROM whatsapp_hub.pur_orders_v WHERE org_id = v_org AND party_id = p_party),
      'quotes', (SELECT jsonb_build_object(
          'invited', count(*),
          'responded', count(*) FILTER (WHERE s.status = 'responded'),
          'won', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_hub.pur_quotation_items qi WHERE qi.winner_supplier_id = s.id)))
        FROM whatsapp_hub.pur_quotation_suppliers s WHERE s.org_id = v_org AND s.party_id = p_party),
      'deliveries', (SELECT jsonb_build_object(
          'receipts', count(DISTINCT r.id),
          'with_divergence', count(DISTINCT r.id) FILTER (WHERE ri.divergence_type IS NOT NULL OR ri.rejected_qty > 0),
          'late', count(DISTINCT r.id) FILTER (WHERE o.expected_date IS NOT NULL AND (r.done_at AT TIME ZONE 'America/Sao_Paulo')::date > o.expected_date))
        FROM whatsapp_hub.pur_receipts r
        JOIN whatsapp_hub.pur_orders o ON o.id = r.order_id
        LEFT JOIN whatsapp_hub.pur_receipt_items ri ON ri.receipt_id = r.id
       WHERE r.org_id = v_org AND o.party_id = p_party AND r.status = 'done'),
      'top_items', (SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'total_cents')::bigint DESC), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('description', min(ii.description), 'unit', min(ii.unit), 'qty', sum(ii.qty),
                                    'total_cents', sum(ii.total_cents), 'last_unit_cents',
                                    (array_agg(ii.unit_cents ORDER BY COALESCE(n.entry_date, n.issue_date) DESC NULLS LAST))[1]) AS x
            FROM whatsapp_hub.pur_invoice_items ii JOIN whatsapp_hub.pur_invoices n ON n.id = ii.invoice_id
           WHERE n.org_id = v_org AND n.party_id = p_party AND n.status NOT IN ('ignored', 'canceled_sefaz')
           GROUP BY COALESCE(ii.item_id::text, ii.product_code, lower(ii.description))
           ORDER BY sum(ii.total_cents) DESC LIMIT 10) q));
  END IF;

  IF v_fin THEN
    out := out || jsonb_build_object('payables', (SELECT jsonb_build_object(
        'open_cents', COALESCE(sum(remaining_cents) FILTER (WHERE status IN ('open', 'partial', 'overdue')), 0),
        'open_count', count(*) FILTER (WHERE status IN ('open', 'partial', 'overdue')),
        'overdue_cents', COALESCE(sum(remaining_cents) FILTER (WHERE status = 'overdue'), 0),
        'overdue_count', count(*) FILTER (WHERE status = 'overdue'),
        'next_due', min(due_date) FILTER (WHERE status IN ('open', 'partial')),
        'paid_12m_cents', COALESCE((SELECT sum(st.amount_cents) FROM whatsapp_hub.fin_settlements st
                                      JOIN whatsapp_hub.fin_installments i2 ON i2.id = st.installment_id
                                      JOIN whatsapp_hub.fin_entries e2 ON e2.id = i2.entry_id
                                     WHERE e2.org_id = v_org AND e2.party_id = p_party AND e2.kind = 'payable'
                                       AND st.settle_date >= v_today - 365), 0))
      FROM whatsapp_hub.fin_installments_v WHERE org_id = v_org AND party_id = p_party AND kind = 'payable'));
  END IF;
  RETURN out || jsonb_build_object('can_finance', v_fin, 'can_purchases', v_pur);
END
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.pur_supplier_dashboard(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.pur_supplier_dashboard(uuid) TO authenticated, service_role;
