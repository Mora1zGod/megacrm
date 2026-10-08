-- ============================================================================
-- Editar mensagem enviada (08/10/2026)
-- messages.edited_at: quando a equipe corrigiu o texto (edit-operator-message).
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
