-- ============================================================================
-- Fornecedor: dados públicos da Receita (consulta pelo CNPJ)
-- A tela consulta a BrasilAPI e grava aqui; o JSON completo fica em cnpj_data.
-- ============================================================================
SET search_path TO whatsapp_hub, public, extensions;

ALTER TABLE whatsapp_hub.fin_parties
  ADD COLUMN IF NOT EXISTS legal_status         text,          -- ATIVA, BAIXADA, INAPTA…
  ADD COLUMN IF NOT EXISTS legal_status_date    date,
  ADD COLUMN IF NOT EXISTS founded_on           date,          -- início da atividade / nascimento
  ADD COLUMN IF NOT EXISTS main_activity        text,          -- CNAE principal (código + descrição)
  ADD COLUMN IF NOT EXISTS company_size         text,          -- porte
  ADD COLUMN IF NOT EXISTS legal_nature         text,          -- natureza jurídica
  ADD COLUMN IF NOT EXISTS simples_nacional     boolean,
  ADD COLUMN IF NOT EXISTS mei                  boolean,
  ADD COLUMN IF NOT EXISTS share_capital_cents  bigint,
  ADD COLUMN IF NOT EXISTS headquarters         text,          -- MATRIZ / FILIAL
  ADD COLUMN IF NOT EXISTS cnpj_data            jsonb,         -- resposta completa (sócios, CNAEs secundários…)
  ADD COLUMN IF NOT EXISTS cnpj_checked_at      timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_parties_cnpj_data_chk') THEN
    ALTER TABLE whatsapp_hub.fin_parties ADD CONSTRAINT fin_parties_cnpj_data_chk
      CHECK (cnpj_data IS NULL OR (jsonb_typeof(cnpj_data) = 'object' AND pg_column_size(cnpj_data) < 200000));
  END IF;
END $$;

-- A lista usa p.* — recria a visão para enxergar as colunas novas.
DROP VIEW IF EXISTS whatsapp_hub.pur_suppliers_v;
CREATE VIEW whatsapp_hub.pur_suppliers_v
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
