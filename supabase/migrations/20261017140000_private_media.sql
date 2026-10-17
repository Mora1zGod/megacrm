-- ============================================================================
-- Mídia do Atendimento privada (LGPD) — FASE 1 (só ADICIONA permissão; nada deixa de funcionar)
-- ----------------------------------------------------------------------------
-- Antes: o bucket whatsapp-hub-media era público — qualquer pessoa com o link abria foto/documento de
-- paciente/cliente, sem login. Agora:
--   * O CRM mostra a mídia por LINK ASSINADO (vale 1 h; src/lib/signedMedia.ts). Para assinar, o usuário
--     logado precisa poder LER o arquivo em storage.objects — esta policy:
--       - arquivo da pasta da SUA org (1º pedaço do caminho = org do token) e org/usuário ativos;
--       - foto de contato (pasta avatars/) — contatos são da org toda;
--       - qualquer outro arquivo SÓ se existir mensagem que ele enxerga usando esse arquivo. A consulta em
--         messages passa pelo RLS dele: conversa de outro responsável (20261013130000) = sem acesso ao arquivo.
--   * Servidor (Edge Functions, service role) baixa pelo Storage e manda link assinado para Zernio/UAZAPI.
--   * O banco continua guardando a URL "pública" em messages.media_url / contacts.profile_pic_url — é só o
--     identificador do arquivo (retenção, busca, _media_path continuam iguais).
--
-- FASE 2 (SQL separado, depois de conferir que as telas mostram a mídia): bucket public = false.
-- Idempotente. Não mexe em nenhum arquivo.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- Índice para achar a mensagem pelo caminho do arquivo (criado na retenção; garante aqui se faltar).
CREATE OR REPLACE FUNCTION whatsapp_hub._media_path(p_url text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT substring(p_url FROM '/whatsapp-hub-media/([^?#]+)')
$$;
CREATE INDEX IF NOT EXISTS messages_media_path_idx ON whatsapp_hub.messages (whatsapp_hub._media_path(media_url))
  WHERE media_url LIKE '%/whatsapp-hub-media/%';
GRANT EXECUTE ON FUNCTION whatsapp_hub._media_path(text) TO authenticated;

DROP POLICY IF EXISTS whatsapp_hub_media_read_member ON storage.objects;
CREATE POLICY whatsapp_hub_media_read_member ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-media'
    AND split_part(name, '/', 1) = (SELECT whatsapp_hub.current_org_id())::text
    AND (SELECT whatsapp_hub.current_org_active())
    AND (
      split_part(name, '/', 2) = 'avatars'
      OR EXISTS (
        SELECT 1 FROM whatsapp_hub.messages m
         WHERE m.media_url LIKE '%/whatsapp-hub-media/%'
           AND whatsapp_hub._media_path(m.media_url) = objects.name
      )
    )
  );

-- Para conferir: policies que hoje existem em storage.objects (mande o resultado se aparecer alguma
-- outra citando whatsapp-hub-media para anon/public — ela seria um furo depois de fechar o bucket).
SELECT policyname, cmd, roles::text, coalesce(qual, '') AS usando, coalesce(with_check, '') AS checando
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
 ORDER BY policyname;
