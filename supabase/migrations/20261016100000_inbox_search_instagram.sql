-- ============================================================================
-- Busca da inbox em TODAS as conversas + @usuário do Instagram (16/10/2026)
-- ----------------------------------------------------------------------------
-- Antes: a busca da inbox filtrava só a lista carregada na tela (conversas abertas, pelo nome e pela
-- última mensagem). Conversa concluída não aparecia nem pelo nome nem pelo texto.
-- Agora:
--   * inbox_search(): procura no banco, em qualquer status, por nome, @usuário do Instagram,
--     telefone (com ou sem máscara) e texto de qualquer mensagem. Roda com as permissões de quem
--     chama (SECURITY INVOKER): valem o RLS da organização e o de "conversas por responsável".
--   * contacts.instagram_username: o @ do Instagram (o "name" passa a ser o nome de exibição).
--   * contacts.instagram_profile_checked_at: quando o perfil foi consultado no Zernio (evita consultar
--     a cada mensagem).
--   * messages.external_url: link do post/story no Instagram, quando o Zernio mandar (botão
--     "Abrir no Instagram").
--   * webhook_events.payload: payload bruto das mensagens do Instagram (para conferir o formato real).
--     A tabela continua sem policy (só o servidor lê).
-- Tudo aditivo (ADD COLUMN NULL / índices / função nova). Idempotente.
-- Observação: os índices são criados sem CONCURRENTLY (o SQL Editor roda em transação). Em tabelas
-- do tamanho atual leva poucos segundos.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.contacts ADD COLUMN IF NOT EXISTS instagram_username text NULL;
ALTER TABLE whatsapp_hub.contacts ADD COLUMN IF NOT EXISTS instagram_profile_checked_at timestamptz NULL;
ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS external_url text NULL;
ALTER TABLE whatsapp_hub.webhook_events ADD COLUMN IF NOT EXISTS payload jsonb NULL;

-- pg_trgm: deixa o ILIKE '%texto%' usar índice. No Supabase as extensões ficam no schema "extensions".
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION pg_trgm;
    END IF;
  END IF;
END $$;

DO $$
DECLARE s text;
BEGIN
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE format('CREATE INDEX IF NOT EXISTS messages_content_trgm_idx ON whatsapp_hub.messages USING gin (content %I.gin_trgm_ops)', s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx ON whatsapp_hub.contacts USING gin (name %I.gin_trgm_ops)', s);
  EXECUTE format('CREATE INDEX IF NOT EXISTS contacts_ig_username_trgm_idx ON whatsapp_hub.contacts USING gin (instagram_username %I.gin_trgm_ops) WHERE instagram_username IS NOT NULL', s);
END $$;

-- Aba "Concluídas" (status closed, mais recentes primeiro, paginada).
CREATE INDEX IF NOT EXISTS conversations_org_status_last_idx
  ON whatsapp_hub.conversations (org_id, status, last_message_at DESC NULLS LAST);

-- ----------------------------------------------------------------------------
-- inbox_search(p_q, p_limit, p_offset)
--   Devolve as conversas que casam (uma linha por conversa), mais recentes primeiro.
--   match_field: 'name' | 'username' | 'phone' | 'message'; snippet: trecho da mensagem que casou.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS whatsapp_hub.inbox_search(text, integer, integer);
CREATE FUNCTION whatsapp_hub.inbox_search(p_q text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
RETURNS TABLE (conversation_id uuid, match_field text, snippet text, last_message_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  v_org    uuid := whatsapp_hub.current_org_id();
  v_q      text := btrim(coalesce(p_q, ''));
  v_user   text;
  v_like   text;
  v_ulike  text;
  v_digits text;
  v_limit  int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_org IS NULL OR char_length(v_q) < 2 THEN RETURN; END IF;
  -- % e _ digitados valem como texto, não como curinga.
  v_like  := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_user  := ltrim(v_q, '@');
  v_ulike := '%' || replace(replace(replace(v_user, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '\D', '', 'g');
  IF char_length(v_digits) < 3 THEN v_digits := NULL; END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT cv.id AS cid,
           CASE WHEN ct.name ILIKE v_like THEN 'name'
                WHEN ct.instagram_username ILIKE v_ulike THEN 'username'
                ELSE 'phone' END AS field,
           NULL::text AS snip, 1 AS prio
      FROM whatsapp_hub.conversations cv
      JOIN whatsapp_hub.contacts ct ON ct.id = cv.contact_id
     WHERE cv.org_id = v_org AND ct.org_id = v_org
       AND (ct.name ILIKE v_like
            OR ct.instagram_username ILIKE v_ulike
            OR (v_digits IS NOT NULL AND regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g') LIKE '%' || v_digits || '%'))
    UNION ALL
    SELECT m.conversation_id, 'message', left(m.content, 160), 2
      FROM whatsapp_hub.messages m
     WHERE m.org_id = v_org AND m.content ILIKE v_like
  ),
  best AS (
    SELECT DISTINCT ON (h.cid) h.cid, h.field, h.snip
      FROM hits h
     ORDER BY h.cid, h.prio
  )
  SELECT b.cid, b.field, b.snip, cv.last_message_at
    FROM best b
    JOIN whatsapp_hub.conversations cv ON cv.id = b.cid
   ORDER BY cv.last_message_at DESC NULLS LAST, b.cid
   LIMIT v_limit OFFSET v_offset;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.inbox_search(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.inbox_search(text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
SELECT 'busca da inbox e @usuário do Instagram instalados' AS ok;
