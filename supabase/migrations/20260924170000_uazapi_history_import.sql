-- ============================================================================
-- Importação do histórico do celular (UAZAPI) — 24/09/2026
-- ----------------------------------------------------------------------------
-- A UAZAPI guarda as mensagens antigas que o WhatsApp sincroniza no pareamento
-- (POST /message/find). A função uazapi-import-history traz essas mensagens
-- para o CRM. Problema: todo INSERT em messages dispara triggers pensados para
-- mensagem NOVA — IA responde (process-ai-message), notificação para a equipe,
-- transcrição de áudio, reabertura de conversa concluída. Importar 3 meses de
-- histórico faria a IA responder mensagens de agosto.
--
-- Solução: a importação grava via RPC import_history_messages, que liga a
-- flag de transação whatsapp_hub.importing = 'on'. Os 4 triggers abaixo
-- saem cedo quando a flag está ligada. Fora da importação nada muda: a flag
-- não existe na sessão e current_setting(..., true) devolve NULL.
-- ============================================================================

CREATE OR REPLACE FUNCTION whatsapp_hub._is_history_import()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('whatsapp_hub.importing', true), '') = 'on';
$$;

-- 1) IA ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_inbound_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
BEGIN
  IF whatsapp_hub._is_history_import() THEN
    RETURN NEW;
  END IF;
  IF NEW.direction = 'inbound'
     AND NEW.sender_type = 'contact'
     AND COALESCE(NEW.is_private_note, false) = false
  THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'process-ai-message',
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- 2) Notificação "nova mensagem" -----------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_inbound_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  contact_name TEXT;
  contact_phone TEXT;
  title_txt TEXT;
  body_txt TEXT;
BEGIN
  IF whatsapp_hub._is_history_import() THEN
    RETURN NEW;
  END IF;
  IF NEW.direction <> 'inbound'
     OR NEW.sender_type <> 'contact'
     OR COALESCE(NEW.is_private_note, false) = true
  THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.phone
    INTO contact_name, contact_phone
    FROM whatsapp_hub.conversations conv
    JOIN whatsapp_hub.contacts c ON c.id = conv.contact_id
   WHERE conv.id = NEW.conversation_id;

  title_txt := 'Nova mensagem de ' || COALESCE(NULLIF(contact_name, ''), contact_phone, 'contato');
  body_txt  := LEFT(COALESCE(NEW.content, '[' || NEW.content_type::text || ']'), 140);

  PERFORM whatsapp_hub._fanout_notification(
    NEW.org_id,
    'new_message'::whatsapp_hub.notification_type,
    NEW.conversation_id,
    NEW.id,
    title_txt,
    body_txt
  );

  RETURN NEW;
END;
$function$;

-- 3) Reabrir conversa concluída -------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._reopen_closed_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
BEGIN
  IF whatsapp_hub._is_history_import() THEN
    RETURN NEW;
  END IF;
  IF NEW.direction = 'inbound'
     AND NEW.sender_type = 'contact'
     AND COALESCE(NEW.is_private_note, false) = false
  THEN
    UPDATE whatsapp_hub.conversations
    SET status = CASE WHEN COALESCE(ai_paused, false) THEN 'human_active'::whatsapp_hub.conversation_status
                      ELSE 'ai_active'::whatsapp_hub.conversation_status END,
        closed_at = NULL
    WHERE id = NEW.conversation_id
      AND status = 'closed';
  END IF;
  RETURN NEW;
END;
$function$;

-- 4) Transcrição automática de áudio ------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._on_audio_inbound()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
BEGIN
  IF whatsapp_hub._is_history_import() THEN
    RETURN NEW;
  END IF;
  IF NEW.direction = 'inbound'
     AND NEW.sender_type = 'contact'
     AND NEW.content_type = 'audio'
     AND COALESCE(NEW.is_private_note, false) = false
     AND NEW.media_url IS NOT NULL
  THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'transcribe-audio',
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- RPC de gravação em lote ------------------------------------------------------
-- p_rows: array de objetos com conversation_id, direction, sender_type,
-- content_type, content, media_url, external_id, created_at (ISO).
-- Deduplica pelo id externo (uq_messages_zernio_message_id). Só a conversa da
-- própria org é aceita. Devolve quantas linhas foram gravadas.
CREATE OR REPLACE FUNCTION whatsapp_hub.import_history_messages(p_org_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('whatsapp_hub.importing', 'on', true);

  INSERT INTO whatsapp_hub.messages (
    org_id, conversation_id, direction, sender_type, content_type,
    content, media_url, zernio_message_id, is_private_note, created_at
  )
  SELECT
    p_org_id,
    (r->>'conversation_id')::uuid,
    (r->>'direction')::whatsapp_hub.message_direction,
    (r->>'sender_type')::whatsapp_hub.sender_type,
    (r->>'content_type')::whatsapp_hub.content_type,
    r->>'content',
    NULLIF(r->>'media_url', ''),
    r->>'external_id',
    false,
    (r->>'created_at')::timestamptz
  FROM jsonb_array_elements(p_rows) AS r
  WHERE EXISTS (
    SELECT 1 FROM whatsapp_hub.conversations c
     WHERE c.id = (r->>'conversation_id')::uuid AND c.org_id = p_org_id
  )
  ON CONFLICT (zernio_message_id) WHERE zernio_message_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM set_config('whatsapp_hub.importing', 'off', true);
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION whatsapp_hub.import_history_messages(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.import_history_messages(uuid, jsonb) TO service_role;
