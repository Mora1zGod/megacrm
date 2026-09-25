-- ============================================================================
-- Grupos do WhatsApp (UAZAPI) + áudio enviado pelo celular — 25/09/2026
-- ----------------------------------------------------------------------------
-- 1) messages.sender_name: em grupo, cada mensagem tem um autor diferente.
--    O grupo é um contato cujo phone é o JID do grupo (…@g.us).
-- 2) import_history_messages passa a gravar sender_name. É também o caminho
--    usado pelo uazapi-webhook para mensagens de GRUPO: a flag de importação
--    impede IA, notificação, transcrição e reabertura em grupo.
-- 3) _on_media_inbound também arquiva a mídia que a equipe manda direto do
--    celular (sender_type 'owner'): antes só a do cliente era copiada para o
--    Storage e o arquivo da equipe ficava só no servidor da UAZAPI.
-- ============================================================================

ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS sender_name text;

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
    content, media_url, zernio_message_id, is_private_note, created_at, sender_name
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
    COALESCE((r->>'created_at')::timestamptz, now()),
    NULLIF(r->>'sender_name', '')
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

CREATE OR REPLACE FUNCTION whatsapp_hub._on_media_inbound()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'whatsapp_hub', 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.direction = 'inbound' OR NEW.sender_type = 'owner')
     AND NEW.media_url IS NOT NULL
     AND COALESCE(NEW.is_private_note, false) = false
     AND NEW.content_type IN ('image', 'audio', 'video', 'document')
     -- já é nosso: nada a fazer
     AND NEW.media_url NOT LIKE '%/whatsapp-hub-media/%'
  THEN
    PERFORM whatsapp_hub._invoke_edge_with_body(
      'archive-media',
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- Arquiva agora a mídia da equipe dos últimos 7 dias que ficou só na UAZAPI.
SELECT whatsapp_hub._invoke_edge_with_body('archive-media', jsonb_build_object('message_id', m.id))
  FROM whatsapp_hub.messages m
 WHERE m.sender_type = 'owner'
   AND m.media_url IS NOT NULL
   AND m.media_url NOT LIKE '%/whatsapp-hub-media/%'
   AND m.content_type IN ('image', 'audio', 'video', 'document')
   AND m.created_at > now() - interval '7 days';
