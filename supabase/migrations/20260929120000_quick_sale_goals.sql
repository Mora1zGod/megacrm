-- ============================================================================
-- Nova Venda + Meta do mês + Painel TV — 29/09/2026
-- ----------------------------------------------------------------------------
-- A venda continua sendo um negócio GANHO (deals.status = 'won'): assim o
-- dashboard de vendas, o ranking de vendedores (owner_id) e o funil já
-- existentes enxergam a venda sem mudança. O que é novo:
--   1) deal_installments — como a venda vai ser paga (à vista, parcelado ou
--      recorrente): uma linha por vencimento, com status pendente/pago.
--      Dá o "recebido x pendente" do mês.
--   2) revenue_goals — meta de faturamento por mês (uma linha por org/mês).
--      Leitura para toda a equipe (a meta aparece no topo e no Painel TV);
--      escrita só admin.
--   3) deals.notes — observações da venda.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.deals ADD COLUMN IF NOT EXISTS notes text;

-- 1) Parcelas / vencimentos ---------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.deal_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  deal_id uuid NOT NULL REFERENCES whatsapp_hub.deals(id) ON DELETE CASCADE,
  -- avista | parcelado | recorrente (o mesmo para todas as parcelas da venda)
  payment_type text NOT NULL CHECK (payment_type IN ('avista', 'parcelado', 'recorrente')),
  number integer NOT NULL CHECK (number >= 1),
  total_count integer NOT NULL CHECK (total_count >= 1),
  due_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago')),
  paid_at timestamptz,
  payment_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, number)
);
CREATE INDEX IF NOT EXISTS deal_installments_org_due_idx
  ON whatsapp_hub.deal_installments (org_id, due_date);
CREATE INDEX IF NOT EXISTS deal_installments_deal_idx
  ON whatsapp_hub.deal_installments (deal_id);

-- A parcela só pode apontar para um negócio da mesma org.
CREATE OR REPLACE FUNCTION whatsapp_hub._installment_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM whatsapp_hub.deals WHERE id = NEW.deal_id;
  IF v_org IS NULL OR v_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Negócio de outra organização';
  END IF;
  IF NEW.status = 'pago' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  ELSIF NEW.status = 'pendente' THEN
    NEW.paid_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_installment_same_org ON whatsapp_hub.deal_installments;
CREATE TRIGGER trg_installment_same_org
  BEFORE INSERT OR UPDATE ON whatsapp_hub.deal_installments
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._installment_same_org();

ALTER TABLE whatsapp_hub.deal_installments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_installments_select ON whatsapp_hub.deal_installments;
CREATE POLICY deal_installments_select ON whatsapp_hub.deal_installments
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
DROP POLICY IF EXISTS deal_installments_operator_write ON whatsapp_hub.deal_installments;
CREATE POLICY deal_installments_operator_write ON whatsapp_hub.deal_installments
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() IN ('admin', 'operator'));

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.deal_installments TO authenticated;

-- 2) Meta de faturamento por mês ----------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.revenue_goals (
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  -- sempre o dia 1 do mês
  month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month)
);

ALTER TABLE whatsapp_hub.revenue_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS revenue_goals_select ON whatsapp_hub.revenue_goals;
CREATE POLICY revenue_goals_select ON whatsapp_hub.revenue_goals
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
DROP POLICY IF EXISTS revenue_goals_admin_write ON whatsapp_hub.revenue_goals;
CREATE POLICY revenue_goals_admin_write ON whatsapp_hub.revenue_goals
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.revenue_goals TO authenticated;

-- Realtime: meta e parcelas atualizam o topo e o Painel TV na hora.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.deal_installments;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.revenue_goals;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
