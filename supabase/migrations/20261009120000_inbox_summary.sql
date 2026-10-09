-- ============================================================================
-- Atendimento mais leve (09/10/2026)
-- ----------------------------------------------------------------------------
-- A lista de conversas baixava TODAS as mensagens de TODAS as conversas só para
-- montar a prévia (última mensagem), a janela de 24 h e o "esperando desde" —
-- e repetia isso a cada mensagem que chegava. Esta função devolve só 1 linha
-- por conversa. SECURITY INVOKER: a RLS de messages continua valendo.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE OR REPLACE FUNCTION whatsapp_hub.inbox_message_summary(p_ids uuid[])
RETURNS TABLE (
  conversation_id uuid,
  preview text,
  preview_type text,
  last_direction text,
  last_inbound_at timestamptz,
  waiting_since timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT c.id,
         lm.content,
         lm.content_type::text,
         lm.direction::text,
         li.created_at,
         -- Esperando resposta: 1ª mensagem do cliente depois da última resposta da equipe (notas não contam).
         CASE WHEN lm.direction::text = 'inbound' THEN (
           SELECT min(m.created_at) FROM whatsapp_hub.messages m
           WHERE m.conversation_id = c.id AND m.direction::text = 'inbound' AND NOT COALESCE(m.is_private_note, false)
             AND m.created_at > COALESCE((
               SELECT max(o.created_at) FROM whatsapp_hub.messages o
               WHERE o.conversation_id = c.id AND o.direction::text = 'outbound' AND NOT COALESCE(o.is_private_note, false)
             ), '-infinity'::timestamptz)
         ) END
  FROM unnest(p_ids) AS c(id)
  LEFT JOIN LATERAL (
    SELECT m.content, m.content_type, m.direction FROM whatsapp_hub.messages m
    WHERE m.conversation_id = c.id AND NOT COALESCE(m.is_private_note, false)
    ORDER BY m.created_at DESC LIMIT 1
  ) lm ON true
  LEFT JOIN LATERAL (
    SELECT m.created_at FROM whatsapp_hub.messages m
    WHERE m.conversation_id = c.id AND m.direction::text = 'inbound'
    ORDER BY m.created_at DESC LIMIT 1
  ) li ON true;
$$;

REVOKE ALL ON FUNCTION whatsapp_hub.inbox_message_summary(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_message_summary(uuid[]) TO authenticated, service_role;

-- Índice para "última mensagem da conversa" (varredura de trás para frente).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_desc
  ON whatsapp_hub.messages (conversation_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
