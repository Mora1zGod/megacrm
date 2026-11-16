-- ============================================================================
-- Central de Recadastramento: EXCLUIR documento (16/11/2026).
-- Exclusão LÓGICA: recad_files.deleted_at/deleted_by — o documento some da tela e dos contadores, mas o arquivo continua guardado
-- no Storage e a exclusão fica no histórico (quem e quando). Só quem tem recad.manage. Nada mais na linha muda.
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.recad_files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE whatsapp_hub.recad_files ADD COLUMN IF NOT EXISTS deleted_by uuid;

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_files_upd_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF (NEW.org_id, NEW.submission_id, NEW.person_id, NEW.kind, NEW.path, NEW.mime, NEW.size_bytes, NEW.created_at, NEW.uploaded_by)
     IS DISTINCT FROM (OLD.org_id, OLD.submission_id, OLD.person_id, OLD.kind, OLD.path, OLD.mime, OLD.size_bytes, OLD.created_at, OLD.uploaded_by) THEN
    RAISE EXCEPTION 'O documento não pode ser alterado — só excluído.';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Documento já excluído.'; END IF;
  IF NEW.deleted_at IS NULL THEN RETURN OLD; END IF;
  NEW.deleted_at := now();
  NEW.deleted_by := auth.uid();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_files_upd_guard ON whatsapp_hub.recad_files;
CREATE TRIGGER recad_files_upd_guard BEFORE UPDATE ON whatsapp_hub.recad_files FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_files_upd_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_files_del_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
    VALUES (NEW.org_id, NEW.submission_id, 'documento_excluido', auth.uid(),
            jsonb_build_object('tipo', NEW.kind,
                               'texto', coalesce((SELECT p.name FROM recad_people p WHERE p.id = NEW.person_id), 'titular')));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_files_del_after ON whatsapp_hub.recad_files;
CREATE TRIGGER recad_files_del_after AFTER UPDATE ON whatsapp_hub.recad_files FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_files_del_after();

DROP POLICY IF EXISTS recad_files_upd ON whatsapp_hub.recad_files;
CREATE POLICY recad_files_upd ON whatsapp_hub.recad_files FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));
GRANT UPDATE (deleted_at) ON whatsapp_hub.recad_files TO authenticated;

NOTIFY pgrst, 'reload schema';
SELECT 'recadastro: excluir documento ok' AS situacao;
