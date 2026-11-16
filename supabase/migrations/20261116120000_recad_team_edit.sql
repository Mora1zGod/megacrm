-- ============================================================================
-- Central de Recadastramento: a EQUIPE completa o cadastro (16/11/2026).
-- ----------------------------------------------------------------------------
-- Para quem ficou pendente/incompleto e mandou o que faltava pelo WhatsApp:
--   * anexar documentos (passaporte/contrato, RG/CNH do titular ou de dependente, certidão) — Storage do bucket privado
--     whatsapp-hub-recadastro em <org>/<envio>/equipe-…; recad_files.uploaded_by = quem anexou (NULL = o próprio associado);
--   * corrigir dados do titular e do passaporte (nome, CPF, nascimento, e-mail, plano, nº de pessoas, nº do passaporte);
--   * incluir e corrigir dependentes;
--   * tirar do "Incompleto" (status enviando → outro): completed_at é gravado pelo banco.
-- Nada se apaga (arquivo errado → anexar o certo e registrar em observação). Tudo vai para o histórico (recad_events).
-- Só quem tem recad.manage. Continuam travados: org, link, protocolo, consentimento, IP, navegador, criação, no_proof.
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- ------------------------------------------------------------------ envio: edição pela equipe
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF (NEW.org_id, NEW.link_id, NEW.protocol, NEW.portal_access, NEW.consent_at, NEW.ip, NEW.user_agent, NEW.created_at, NEW.no_proof)
       IS DISTINCT FROM
       (OLD.org_id, OLD.link_id, OLD.protocol, OLD.portal_access, OLD.consent_at, OLD.ip, OLD.user_agent, OLD.created_at, OLD.no_proof) THEN
      RAISE EXCEPTION 'Esse campo do recadastramento não pode ser alterado.';
    END IF;
    -- dados que a equipe pode corrigir (os CHECKs da tabela validam formato)
    IF NEW.holder_name IS DISTINCT FROM OLD.holder_name THEN NEW.holder_name := btrim(regexp_replace(NEW.holder_name, '\s+', ' ', 'g')); END IF;
    IF NEW.holder_cpf IS DISTINCT FROM OLD.holder_cpf THEN NEW.holder_cpf := regexp_replace(coalesce(NEW.holder_cpf, ''), '\D', '', 'g'); END IF;
    IF NEW.holder_email IS DISTINCT FROM OLD.holder_email THEN NEW.holder_email := nullif(lower(btrim(coalesce(NEW.holder_email, ''))), ''); END IF;
    IF NEW.passport_number IS DISTINCT FROM OLD.passport_number THEN NEW.passport_number := nullif(btrim(coalesce(NEW.passport_number, '')), ''); END IF;
    IF NEW.plan <> 'amai10' THEN NEW.people_count := NULL; END IF;
    IF NEW.holder_phone IS DISTINCT FROM OLD.holder_phone THEN
      NEW.holder_phone := nullif(regexp_replace(coalesce(NEW.holder_phone, ''), '\D', '', 'g'), '');
      IF NEW.holder_phone IS NOT NULL AND NEW.holder_phone !~ '^[0-9]{10,13}$' THEN
        RAISE EXCEPTION 'WhatsApp inválido: informe DDD + número (10 ou 11 dígitos).';
      END IF;
    END IF;
    IF NEW.status = 'enviando' AND OLD.status <> 'enviando' THEN
      RAISE EXCEPTION 'Status inválido.';
    END IF;
    IF NEW.status = 'lancado' AND OLD.status NOT IN ('conferido', 'lancado') THEN
      RAISE EXCEPTION 'Só dá para marcar como lançado no Pocket depois de "Conferido".';
    END IF;
    NEW.completed_at := OLD.completed_at;
    IF OLD.status = 'enviando' AND NEW.status <> 'enviando' AND OLD.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    NEW.checked_at := OLD.checked_at;  NEW.checked_by := OLD.checked_by;
    NEW.launched_at := OLD.launched_at; NEW.launched_by := OLD.launched_by;
    IF NEW.status = 'conferido' AND OLD.status <> 'conferido' THEN NEW.checked_at := now(); NEW.checked_by := auth.uid(); END IF;
    IF NEW.status = 'lancado' AND OLD.status <> 'lancado' THEN NEW.launched_at := now(); NEW.launched_by := auth.uid(); END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;
  -- Vale para todos (tela, extensão, service role): não conclui com pendência aberta.
  IF NEW.status IN ('conferido', 'lancado') AND NEW.status IS DISTINCT FROM OLD.status
     AND EXISTS (SELECT 1 FROM recad_issues i WHERE i.submission_id = NEW.id AND i.status = 'aberta' AND i.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Há pendência em aberto neste recadastramento. Resolva as pendências antes de marcar como conferido ou lançado.';
  END IF;
  RETURN NEW;
END $$;

-- histórico: status, telefone e dados corrigidos (antes só registrava fora do "Incompleto"; agora registra toda ação da equipe)
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE d jsonb := '{}'::jsonb;
BEGIN
  IF OLD.status = 'enviando' AND auth.uid() IS NULL THEN RETURN NULL; END IF;  -- o próprio associado terminando o envio
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
    VALUES (NEW.org_id, NEW.id, 'status', auth.uid(), jsonb_build_object('de', OLD.status, 'para', NEW.status));
  END IF;
  IF NEW.holder_phone IS DISTINCT FROM OLD.holder_phone THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
    VALUES (NEW.org_id, NEW.id, 'telefone', auth.uid(), jsonb_build_object('de', OLD.holder_phone, 'para', NEW.holder_phone));
  END IF;
  IF NEW.holder_name IS DISTINCT FROM OLD.holder_name THEN d := d || jsonb_build_object('nome', jsonb_build_array(OLD.holder_name, NEW.holder_name)); END IF;
  IF NEW.holder_cpf IS DISTINCT FROM OLD.holder_cpf THEN d := d || jsonb_build_object('cpf', jsonb_build_array(OLD.holder_cpf, NEW.holder_cpf)); END IF;
  IF NEW.holder_birth IS DISTINCT FROM OLD.holder_birth THEN d := d || jsonb_build_object('nascimento', jsonb_build_array(OLD.holder_birth, NEW.holder_birth)); END IF;
  IF NEW.holder_email IS DISTINCT FROM OLD.holder_email THEN d := d || jsonb_build_object('e-mail', jsonb_build_array(OLD.holder_email, NEW.holder_email)); END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN d := d || jsonb_build_object('plano', jsonb_build_array(OLD.plan, NEW.plan)); END IF;
  IF NEW.people_count IS DISTINCT FROM OLD.people_count THEN d := d || jsonb_build_object('pessoas', jsonb_build_array(OLD.people_count, NEW.people_count)); END IF;
  IF NEW.passport_number IS DISTINCT FROM OLD.passport_number THEN d := d || jsonb_build_object('nº passaporte', jsonb_build_array(OLD.passport_number, NEW.passport_number)); END IF;
  IF d <> '{}'::jsonb THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta) VALUES (NEW.org_id, NEW.id, 'dados_editados', auth.uid(), d);
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ dependentes: incluir e corrigir
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_people_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.org_id INTO NEW.org_id FROM recad_submissions s WHERE s.id = NEW.submission_id;
    IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'Recadastramento não encontrado.'; END IF;
    IF auth.uid() IS NOT NULL THEN  -- equipe (SECURITY DEFINER: current_user aqui é o dono, por isso auth.uid())
      SELECT coalesce(max(p.position), 0) + 1 INTO NEW.position FROM recad_people p WHERE p.submission_id = NEW.submission_id;
      NEW.created_at := now();
    END IF;
  ELSIF auth.uid() IS NOT NULL
     AND (NEW.submission_id, NEW.org_id, NEW.position, NEW.created_at) IS DISTINCT FROM (OLD.submission_id, OLD.org_id, OLD.position, OLD.created_at) THEN
    RAISE EXCEPTION 'Esse campo do dependente não pode ser alterado.';
  END IF;
  NEW.name := btrim(regexp_replace(NEW.name, '\s+', ' ', 'g'));
  NEW.cpf := nullif(regexp_replace(coalesce(NEW.cpf, ''), '\D', '', 'g'), '');
  NEW.email := nullif(lower(btrim(coalesce(NEW.email, ''))), '');
  IF NEW.relationship <> 'outro' THEN NEW.relationship_other := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_people_guard ON whatsapp_hub.recad_people;
CREATE TRIGGER recad_people_guard BEFORE INSERT OR UPDATE ON whatsapp_hub.recad_people FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_people_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_people_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;  -- inclusão pelo formulário público não entra no histórico
  INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
  VALUES (NEW.org_id, NEW.submission_id, CASE WHEN TG_OP = 'INSERT' THEN 'dependente_incluido' ELSE 'dependente_editado' END,
          auth.uid(), jsonb_build_object('texto', NEW.name));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_people_after ON whatsapp_hub.recad_people;
CREATE TRIGGER recad_people_after AFTER INSERT OR UPDATE ON whatsapp_hub.recad_people FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_people_after();

DROP POLICY IF EXISTS recad_people_ins ON whatsapp_hub.recad_people;
CREATE POLICY recad_people_ins ON whatsapp_hub.recad_people FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')));
DROP POLICY IF EXISTS recad_people_upd ON whatsapp_hub.recad_people;
CREATE POLICY recad_people_upd ON whatsapp_hub.recad_people FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));
GRANT INSERT, UPDATE ON whatsapp_hub.recad_people TO authenticated;

-- ------------------------------------------------------------------ documentos anexados pela equipe
ALTER TABLE whatsapp_hub.recad_files ADD COLUMN IF NOT EXISTS uploaded_by uuid;

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_files_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;  -- formulário público (service role, sem usuário)
  SELECT s.org_id INTO NEW.org_id FROM recad_submissions s WHERE s.id = NEW.submission_id;
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'Recadastramento não encontrado.'; END IF;
  IF NEW.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recad_people p WHERE p.id = NEW.person_id AND p.submission_id = NEW.submission_id) THEN
    RAISE EXCEPTION 'Dependente não pertence a este recadastramento.';
  END IF;
  IF NEW.path NOT LIKE NEW.org_id::text || '/' || NEW.submission_id::text || '/equipe-%' OR NEW.path LIKE '%..%' THEN
    RAISE EXCEPTION 'Caminho de arquivo inválido.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'whatsapp-hub-recadastro' AND o.name = NEW.path) THEN
    RAISE EXCEPTION 'Arquivo não encontrado no armazenamento.';
  END IF;
  IF NEW.mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN RAISE EXCEPTION 'Tipo de arquivo não aceito.'; END IF;
  NEW.uploaded_by := auth.uid();
  NEW.created_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_files_guard ON whatsapp_hub.recad_files;
CREATE TRIGGER recad_files_guard BEFORE INSERT ON whatsapp_hub.recad_files FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_files_guard();

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_files_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF NEW.uploaded_by IS NULL THEN RETURN NULL; END IF;
  INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
  VALUES (NEW.org_id, NEW.submission_id, 'documento_equipe', NEW.uploaded_by,
          jsonb_build_object('tipo', NEW.kind,
                             'texto', coalesce((SELECT p.name FROM recad_people p WHERE p.id = NEW.person_id), 'titular')));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_files_after ON whatsapp_hub.recad_files;
CREATE TRIGGER recad_files_after AFTER INSERT ON whatsapp_hub.recad_files FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_files_after();

DROP POLICY IF EXISTS recad_files_ins ON whatsapp_hub.recad_files;
CREATE POLICY recad_files_ins ON whatsapp_hub.recad_files FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')));
GRANT INSERT ON whatsapp_hub.recad_files TO authenticated;

-- Storage: a equipe sobe arquivo SÓ na pasta de um envio da própria org, com nome equipe-… (sem sobrescrever: sem UPDATE/DELETE)
DROP POLICY IF EXISTS recad_files_team_upload ON storage.objects;
CREATE POLICY recad_files_team_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'whatsapp-hub-recadastro'
    AND (storage.foldername(name))[1] = (SELECT whatsapp_hub.current_org_id())::text
    AND (SELECT whatsapp_hub.current_org_active())
    AND (SELECT whatsapp_hub.has_perm('recad.manage'))
    AND storage.filename(name) LIKE 'equipe-%'
    AND EXISTS (SELECT 1 FROM whatsapp_hub.recad_submissions s
                 WHERE s.id::text = (storage.foldername(name))[2] AND s.org_id = (SELECT whatsapp_hub.current_org_id())));

NOTIFY pgrst, 'reload schema';
SELECT 'recadastro: edição pela equipe ok' AS situacao;
