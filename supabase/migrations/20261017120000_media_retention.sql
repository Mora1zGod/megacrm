-- ============================================================================
-- Retenção de mídia do Atendimento (17/10/2026)
-- ----------------------------------------------------------------------------
-- O Storage estourou o plano (bucket whatsapp-hub-media). Política por organização, DESLIGADA por padrão:
--   * conversa concluída há mais de `purge_on_close_after_hours` (padrão 24 h, dá tempo de reabrir) → sai a mídia dela;
--   * qualquer mídia com mais de `purge_inactive_after_days` (padrão 30 dias), mesmo em conversa ativa → sai.
--   * contato com a tag "guardar-midia" → a mídia dele NUNCA sai.
--   * conversa reaberta: o trigger _reopen_closed_conversation já tira o status 'closed' — a regra das 24 h deixa de valer.
-- Só o ARQUIVO sai do Storage (pela Storage API, na edge function media-retention-purge). A mensagem fica no histórico
-- com messages.media_purged_at preenchido e o chat mostra "Mídia removida pela política de retenção".
-- Este SQL só acrescenta (colunas, tag, funções de LEITURA, índices, cron). Nada é apagado aqui. Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

-- 1. Colunas ------------------------------------------------------------------------------------------------
ALTER TABLE whatsapp_hub.messages ADD COLUMN IF NOT EXISTS media_purged_at timestamptz NULL;

ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS media_retention_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS purge_on_close_after_hours integer NOT NULL DEFAULT 24;
ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS purge_inactive_after_days integer NOT NULL DEFAULT 30;
DO $$ BEGIN
  ALTER TABLE whatsapp_hub.app_settings ADD CONSTRAINT app_settings_purge_hours_chk CHECK (purge_on_close_after_hours BETWEEN 1 AND 8760);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE whatsapp_hub.app_settings ADD CONSTRAINT app_settings_purge_days_chk CHECK (purge_inactive_after_days BETWEEN 1 AND 3650);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Tag "guardar-midia" em toda organização (e nas novas) ----------------------------------------------------
INSERT INTO whatsapp_hub.tags (org_id, name, color)
SELECT o.id, 'guardar-midia', '#16A34A' FROM whatsapp_hub.organizations o
 WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.tags t WHERE t.org_id = o.id AND lower(t.name) = 'guardar-midia');

CREATE OR REPLACE FUNCTION whatsapp_hub._org_seed_media_tag()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  INSERT INTO whatsapp_hub.tags (org_id, name, color)
  SELECT NEW.id, 'guardar-midia', '#16A34A'
   WHERE NOT EXISTS (SELECT 1 FROM whatsapp_hub.tags t WHERE t.org_id = NEW.id AND lower(t.name) = 'guardar-midia');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_org_seed_media_tag ON whatsapp_hub.organizations;
CREATE TRIGGER zz_org_seed_media_tag AFTER INSERT ON whatsapp_hub.organizations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_seed_media_tag();

-- 3. Caminho do arquivo no bucket a partir da URL pública ------------------------------------------------------
CREATE OR REPLACE FUNCTION whatsapp_hub._media_path(p_url text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT substring(p_url FROM '/whatsapp-hub-media/([^?#]+)')
$$;

CREATE INDEX IF NOT EXISTS messages_media_path_idx ON whatsapp_hub.messages (whatsapp_hub._media_path(media_url))
  WHERE media_url LIKE '%/whatsapp-hub-media/%';
CREATE INDEX IF NOT EXISTS messages_media_retention_idx ON whatsapp_hub.messages (org_id, created_at)
  WHERE media_url LIKE '%/whatsapp-hub-media/%' AND media_purged_at IS NULL;

-- 4. O que pode sair (só LEITURA; quem apaga é a edge function pela Storage API) -------------------------------
-- Um arquivo só sai se TODAS as mensagens (ainda não marcadas) que apontam para ele estiverem no prazo.
-- Nunca entram: fotos de contato (pasta avatars/ ou usadas em contacts.profile_pic_url).
CREATE OR REPLACE FUNCTION whatsapp_hub.media_retention_candidates(p_org uuid, p_limit integer DEFAULT 1000)
RETURNS TABLE (path text, bytes bigint, message_ids uuid[], rule text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, storage, pg_temp
AS $$
  WITH cfg AS (
    SELECT COALESCE(max(s.purge_on_close_after_hours), 24) AS hours, COALESCE(max(s.purge_inactive_after_days), 30) AS days
      FROM whatsapp_hub.app_settings s WHERE s.org_id = p_org
  ),
  keep AS (
    SELECT ct.contact_id FROM whatsapp_hub.contact_tags ct
      JOIN whatsapp_hub.tags t ON t.id = ct.tag_id
     WHERE t.org_id = p_org AND lower(t.name) = 'guardar-midia'
  ),
  ref AS (
    SELECT m.id, whatsapp_hub._media_path(m.media_url) AS path,
           CASE
             WHEN c.contact_id IN (SELECT contact_id FROM keep) THEN NULL
             WHEN c.status = 'closed' AND COALESCE(c.closed_at, c.last_message_at, m.created_at) < now() - make_interval(hours => (SELECT hours FROM cfg))
               THEN 'concluida'
             WHEN m.created_at < now() - make_interval(days => (SELECT days FROM cfg))
               THEN 'antiga'
           END AS rule
      FROM whatsapp_hub.messages m
      JOIN whatsapp_hub.conversations c ON c.id = m.conversation_id
     WHERE m.org_id = p_org
       AND m.media_url LIKE '%/whatsapp-hub-media/%'
       AND m.media_purged_at IS NULL
  ),
  grp AS (
    SELECT r.path, array_agg(r.id) AS ids, bool_and(r.rule IS NOT NULL) AS ok, min(r.rule) AS rule
      FROM ref r WHERE r.path IS NOT NULL GROUP BY r.path
  )
  SELECT g.path, (o.metadata->>'size')::bigint, g.ids, g.rule
    FROM grp g
    LEFT JOIN storage.objects o ON o.bucket_id = 'whatsapp-hub-media' AND o.name = g.path
   WHERE g.ok
     AND split_part(g.path, '/', 2) <> 'avatars'
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.contacts ct WHERE ct.profile_pic_url LIKE '%/whatsapp-hub-media/' || g.path || '%')
   ORDER BY g.path
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 50000));
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.media_retention_candidates(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.media_retention_candidates(uuid, integer) TO service_role;

-- Órfãos: arquivo da org no bucket que nenhuma mensagem ainda ativa e nenhuma foto de contato usa.
-- Arquivo com menos de 1 dia fica de fora (upload em andamento: "enviadas" sobe antes da mensagem existir).
CREATE OR REPLACE FUNCTION whatsapp_hub.media_retention_orphans(p_org uuid, p_limit integer DEFAULT 1000)
RETURNS TABLE (path text, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, storage, pg_temp
AS $$
  SELECT o.name, (o.metadata->>'size')::bigint
    FROM storage.objects o
   WHERE o.bucket_id = 'whatsapp-hub-media'
     AND o.name LIKE p_org::text || '/%'
     AND split_part(o.name, '/', 2) <> 'avatars'
     AND o.created_at < now() - interval '1 day'
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.messages m
                      WHERE whatsapp_hub._media_path(m.media_url) = o.name
                        AND m.media_url LIKE '%/whatsapp-hub-media/%'
                        AND m.media_purged_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.contacts ct WHERE ct.profile_pic_url LIKE '%/whatsapp-hub-media/' || o.name || '%')
   ORDER BY o.name
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 50000));
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.media_retention_orphans(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.media_retention_orphans(uuid, integer) TO service_role;

-- 5. Agendamento: de hora em hora (a função só age nas orgs com a retenção LIGADA) ----------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('media-retention-purge-hourly'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('media-retention-purge-hourly', '17 * * * *',
      $cron$SELECT whatsapp_hub._cron_invoke_edge('media-retention-purge')$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
SELECT 'retenção de mídia instalada (desligada em todas as organizações)' AS ok;
