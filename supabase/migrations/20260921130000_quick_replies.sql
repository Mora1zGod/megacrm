-- Respostas rápidas: atalhos de texto pré-pronto usados no composer do Inbox
-- (digitar "/" abre a lista, igual Slack/Discord). Compartilhadas na org —
-- qualquer operador cria/edita as suas, sem gate de admin (mesmo nível de
-- escrita que `tags`).
SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  -- Atalho digitado após "/" no composer (sem a barra, ex.: "boasvindas").
  shortcut text NOT NULL,
  content text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, shortcut)
);
CREATE INDEX IF NOT EXISTS quick_replies_org_idx ON whatsapp_hub.quick_replies (org_id);

ALTER TABLE whatsapp_hub.quick_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY quick_replies_select ON whatsapp_hub.quick_replies
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
CREATE POLICY quick_replies_operator_write ON whatsapp_hub.quick_replies
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() IN ('admin', 'operator'))
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() IN ('admin', 'operator'));
