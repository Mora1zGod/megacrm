-- ============================================================================
-- automation_flows: garante multi-tenancy (org_id + RLS)
-- ----------------------------------------------------------------------------
-- A tabela `automation_flows` (editor visual de fluxos, aba Automações →
-- Fluxos) foi criada fora do histórico de migrations deste repo, ANTES da
-- passagem de multi-tenancy (20260810120001_mt_backfill.sql) — por isso não
-- entrou na lista `v_not_null_tables` daquela migration e nunca ganhou
-- `org_id DEFAULT current_org_id()`. Resultado: INSERT via frontend (que não
-- envia org_id, confia no DEFAULT) falha com
-- "null value in column org_id ... violates not-null constraint".
--
-- Esta migration é idempotente: cria a tabela do zero (schema já usado pelo
-- frontend em src/hooks/useAutomationFlows.ts) se ela não existir, e nos
-- ambientes onde ela já existe, só adiciona org_id/DEFAULT/RLS que faltam,
-- sem tocar em dados existentes.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.automation_flows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL DEFAULT whatsapp_hub.current_org_id(),
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  definition  JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  version     INT NOT NULL DEFAULT 1,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ambientes onde a tabela já existia (sem org_id, ou com org_id sem DEFAULT):
ALTER TABLE whatsapp_hub.automation_flows
  ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE whatsapp_hub.automation_flows
  ALTER COLUMN org_id SET DEFAULT whatsapp_hub.current_org_id();
UPDATE whatsapp_hub.automation_flows
   SET org_id = whatsapp_hub.default_org_id()
 WHERE org_id IS NULL;
ALTER TABLE whatsapp_hub.automation_flows
  ALTER COLUMN org_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'automation_flows_org_id_fkey'
       AND conrelid = 'whatsapp_hub.automation_flows'::regclass
  ) THEN
    ALTER TABLE whatsapp_hub.automation_flows
      ADD CONSTRAINT automation_flows_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automation_flows_org ON whatsapp_hub.automation_flows (org_id);

ALTER TABLE whatsapp_hub.automation_flows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_flows_select ON whatsapp_hub.automation_flows;
CREATE POLICY automation_flows_select ON whatsapp_hub.automation_flows
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

DROP POLICY IF EXISTS automation_flows_admin_write ON whatsapp_hub.automation_flows;
CREATE POLICY automation_flows_admin_write ON whatsapp_hub.automation_flows
  FOR ALL TO authenticated
  USING (
    org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
    AND whatsapp_hub.current_user_role() = 'admin'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.automation_flows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.automation_flows TO service_role;
