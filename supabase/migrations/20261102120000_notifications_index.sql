-- ============================================================================
-- Sino de notificações mais leve (02/11/2026)
-- A tela busca as 50 últimas notificações da pessoa (lidas e não lidas). O único índice era só das NÃO lidas
-- (idx_notifications_user_unread, parcial) — o banco ordenava todas as notificações da pessoa a cada abertura
-- (média 409 ms, picos de 5 s no pg_stat_statements). Este índice cobre a busca inteira. Só cria índice.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON whatsapp_hub.notifications (user_id, created_at DESC);

ANALYZE whatsapp_hub.notifications;
