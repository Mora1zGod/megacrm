-- Traz para o histórico o cadastro multi-conta Zernio já usado em produção.
-- A API migra a chave legada da org para esta tabela na primeira leitura.
SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.zernio_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE
    DEFAULT whatsapp_hub.current_org_id(),
  label text NOT NULL DEFAULT 'Conta Zernio',
  api_key_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zernio_credentials_org_idx
  ON whatsapp_hub.zernio_credentials (org_id);

ALTER TABLE whatsapp_hub.channels
  ADD COLUMN IF NOT EXISTS zernio_credential_id uuid
    REFERENCES whatsapp_hub.zernio_credentials(id) ON DELETE SET NULL;

ALTER TABLE whatsapp_hub.zernio_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zernio_credentials_select ON whatsapp_hub.zernio_credentials;
CREATE POLICY zernio_credentials_select ON whatsapp_hub.zernio_credentials
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());

DROP POLICY IF EXISTS zernio_credentials_admin_write ON whatsapp_hub.zernio_credentials;
CREATE POLICY zernio_credentials_admin_write ON whatsapp_hub.zernio_credentials
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() = 'admin');
