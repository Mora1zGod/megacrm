-- ============================================================================
-- Painel de atendimento — 07/10/2026
-- ----------------------------------------------------------------------------
-- * Responder citando: messages.reply_to_id (mensagem citada) +
--   messages.platform_message_id (id da Meta/WhatsApp, "wamid…", exigido pelo
--   Zernio no campo replyTo). UAZAPI usa o próprio zernio_message_id (id da
--   mensagem na instância) no campo replyid.
-- * Encaminhar: messages.forwarded.
-- * Assinatura do atendente: app_users.sign_messages (preferência pessoal).
-- * SLA de resposta: app_settings.sla_warn_minutes / sla_late_minutes (por org).
-- Tudo aditivo, com default: nada muda para quem não usar.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES whatsapp_hub.messages(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS platform_message_id text;
ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON whatsapp_hub.messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

ALTER TABLE whatsapp_hub.app_users ADD COLUMN IF NOT EXISTS sign_messages boolean NOT NULL DEFAULT false;

ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS sla_warn_minutes int NOT NULL DEFAULT 5;
ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS sla_late_minutes int NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_sla_check') THEN
    ALTER TABLE whatsapp_hub.app_settings
      ADD CONSTRAINT app_settings_sla_check
      CHECK (sla_warn_minutes BETWEEN 1 AND 1440 AND sla_late_minutes BETWEEN 1 AND 1440
             AND sla_late_minutes >= sla_warn_minutes);
  END IF;
END $$;
