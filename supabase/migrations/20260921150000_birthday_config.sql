-- Config. Aniversário: disparo automático de mensagem de aniversário pro
-- contato, no mesmo espírito do repurchase-dispatch (kill-switch + template +
-- horário comercial + auditoria), mas o "vencimento" aqui é mês/dia de
-- nascimento em vez de uma predição calculada.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. contacts: data de nascimento + idempotência por ano
-- ----------------------------------------------------------------------------
-- birthday_month/birthday_day são colunas geradas (STORED) só pra permitir
-- filtro direto via PostgREST (.eq) sem precisar de RPC — mesma ideia de
-- índice funcional, só que materializado como coluna.
ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS birthday_date date,
  ADD COLUMN IF NOT EXISTS last_birthday_sent_year int;

ALTER TABLE whatsapp_hub.contacts
  ADD COLUMN IF NOT EXISTS birthday_month smallint
    GENERATED ALWAYS AS (EXTRACT(MONTH FROM birthday_date)::smallint) STORED,
  ADD COLUMN IF NOT EXISTS birthday_day smallint
    GENERATED ALWAYS AS (EXTRACT(DAY FROM birthday_date)::smallint) STORED;

CREATE INDEX IF NOT EXISTS contacts_birthday_idx
  ON whatsapp_hub.contacts (org_id, birthday_month, birthday_day)
  WHERE birthday_date IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. birthday_config (1 linha por org — mesmo padrão de repurchase_config)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_hub.birthday_config (
  org_id uuid PRIMARY KEY REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  auto_send boolean NOT NULL DEFAULT false,      -- KILL-SWITCH (off até validar)
  -- 0 = dispara no próprio dia; >0 = dispara N dias antes (ex.: 1 = na véspera).
  send_days_before int NOT NULL DEFAULT 0,
  template_name text,
  template_language text NOT NULL DEFAULT 'pt_BR',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_birthday_config_updated_at
  BEFORE UPDATE ON whatsapp_hub.birthday_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

ALTER TABLE whatsapp_hub.birthday_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY birthday_config_select ON whatsapp_hub.birthday_config
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
CREATE POLICY birthday_config_admin_write ON whatsapp_hub.birthday_config
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.birthday_config TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. seed_org_defaults: passa a semear birthday_config também (org nova E
--    backfill das orgs já existentes, abaixo).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub.seed_org_defaults(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.app_settings (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_settings WHERE org_id = p_org);

  INSERT INTO whatsapp_hub.repurchase_config (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.repurchase_config WHERE org_id = p_org);

  INSERT INTO whatsapp_hub.birthday_config (org_id)
  SELECT p_org
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.birthday_config WHERE org_id = p_org);
END;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) FROM PUBLIC, authenticated, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.seed_org_defaults(UUID) TO service_role;

-- Backfill: orgs já existentes ainda não têm linha em birthday_config.
INSERT INTO whatsapp_hub.birthday_config (org_id)
SELECT o.id FROM whatsapp_hub.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_hub.birthday_config bc WHERE bc.org_id = o.id
);
