-- ============================================================================
-- Central de Recadastramento (13/11/2026): pendências, observações da equipe e histórico por envio.
-- ----------------------------------------------------------------------------
--   recad_issues  pendências (aberta/resolvida; quem criou/resolveu/excluiu e quando; exclusão LÓGICA)
--   recad_notes   observações internas (só inclusão — nada se edita nem apaga; o histórico fica íntegro)
--   recad_events  histórico (gravado pelo banco: pendências, observações, status, telefone; a tela só grava
--                 "whatsapp_aberto" — quando alguém abre a conversa com a mensagem pronta)
-- Regras no banco (valem para a tela e para a extensão do Pocket):
--   * "Conferido" e "Lançado no Pocket" são recusados enquanto houver pendência ABERTA;
--   * pendência aberta (nova ou reaberta) em envio "Novo"/"Em análise"/"Conferido" → status "Pendência" (aguardando o associado);
--     resolver não muda status sozinho (a equipe decide);
--   * a equipe pode corrigir o WhatsApp do titular (só dígitos, 10 a 13) — registrado no histórico.
-- Leitura: recad.view. Escrita: recad.manage. Nada aparece no formulário público, no portal nem no WhatsApp.
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  text          text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 400),
  status        text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'resolvida')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid,
  resolved_at   timestamptz,
  deleted_by    uuid,
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS recad_issues_sub_idx ON whatsapp_hub.recad_issues (submission_id, created_at);
CREATE INDEX IF NOT EXISTS recad_issues_open_idx ON whatsapp_hub.recad_issues (org_id, submission_id)
  WHERE status = 'aberta' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  text          text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 3000),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recad_notes_sub_idx ON whatsapp_hub.recad_notes (submission_id, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  actor         uuid,
  at            timestamptz NOT NULL DEFAULT now(),
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS recad_events_sub_idx ON whatsapp_hub.recad_events (submission_id, at DESC);

-- org e autor sempre do banco (nunca do navegador)
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_child_fill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  SELECT s.org_id INTO NEW.org_id FROM recad_submissions s WHERE s.id = NEW.submission_id;
  IF NEW.org_id IS NULL THEN RAISE EXCEPTION 'Recadastramento não encontrado.'; END IF;
  IF TG_TABLE_NAME = 'recad_events' THEN
    NEW.actor := coalesce(auth.uid(), NEW.actor);
    NEW.at := now();
  ELSE
    NEW.created_by := auth.uid();
    NEW.created_at := now();
  END IF;
  IF TG_TABLE_NAME = 'recad_issues' THEN
    NEW.text := btrim(NEW.text);
    NEW.status := 'aberta';
    NEW.resolved_by := NULL; NEW.resolved_at := NULL; NEW.deleted_by := NULL; NEW.deleted_at := NULL;
  ELSIF TG_TABLE_NAME = 'recad_notes' THEN
    NEW.text := btrim(NEW.text);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_issues_fill ON whatsapp_hub.recad_issues;
CREATE TRIGGER recad_issues_fill BEFORE INSERT ON whatsapp_hub.recad_issues FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_child_fill();
DROP TRIGGER IF EXISTS recad_notes_fill ON whatsapp_hub.recad_notes;
CREATE TRIGGER recad_notes_fill BEFORE INSERT ON whatsapp_hub.recad_notes FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_child_fill();
DROP TRIGGER IF EXISTS recad_events_fill ON whatsapp_hub.recad_events;
CREATE TRIGGER recad_events_fill BEFORE INSERT ON whatsapp_hub.recad_events FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_child_fill();

-- Pendência: só muda status (aberta/resolvida) e exclusão lógica; quem/quando vem do banco.
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_issue_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF (NEW.org_id, NEW.submission_id, NEW.text, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.org_id, OLD.submission_id, OLD.text, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A pendência não pode ser alterada — resolva, reabra ou exclua.';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Pendência já excluída.'; END IF;
  IF NEW.status = 'resolvida' AND OLD.status = 'aberta' THEN
    NEW.resolved_by := auth.uid(); NEW.resolved_at := now();
  ELSIF NEW.status = 'aberta' AND OLD.status = 'resolvida' THEN
    NEW.resolved_by := NULL; NEW.resolved_at := NULL;
  ELSE
    NEW.resolved_by := OLD.resolved_by; NEW.resolved_at := OLD.resolved_at;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now(); NEW.deleted_by := auth.uid();
  ELSE
    NEW.deleted_by := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_issue_guard ON whatsapp_hub.recad_issues;
CREATE TRIGGER recad_issue_guard BEFORE UPDATE ON whatsapp_hub.recad_issues FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_issue_guard();

-- Histórico + "aguardando associado" ao abrir pendência
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_issue_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    k := 'pendencia_criada';
    UPDATE recad_submissions SET status = 'pendente'
     WHERE id = NEW.submission_id AND status IN ('novo', 'em_analise', 'conferido');
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN k := 'pendencia_excluida';
  ELSIF NEW.status = 'resolvida' AND OLD.status = 'aberta' THEN k := 'pendencia_resolvida';
  ELSIF NEW.status = 'aberta' AND OLD.status = 'resolvida' THEN
    k := 'pendencia_reaberta';
    UPDATE recad_submissions SET status = 'pendente'
     WHERE id = NEW.submission_id AND status IN ('novo', 'em_analise', 'conferido');
  ELSE RETURN NULL;
  END IF;
  INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
  VALUES (NEW.org_id, NEW.submission_id, k, auth.uid(), jsonb_build_object('texto', NEW.text, 'pendencia', NEW.id));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_issue_after ON whatsapp_hub.recad_issues;
CREATE TRIGGER recad_issue_after AFTER INSERT OR UPDATE ON whatsapp_hub.recad_issues FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_issue_after();

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_note_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
  VALUES (NEW.org_id, NEW.submission_id, 'observacao', auth.uid(), jsonb_build_object('texto', left(NEW.text, 200)));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_note_after ON whatsapp_hub.recad_notes;
CREATE TRIGGER recad_note_after AFTER INSERT ON whatsapp_hub.recad_notes FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_note_after();

-- Guarda do envio: agora também deixa corrigir o WhatsApp e bloqueia concluir com pendência aberta.
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF (NEW.org_id, NEW.link_id, NEW.protocol, NEW.plan, NEW.people_count, NEW.passport_number, NEW.holder_name,
        NEW.holder_cpf, NEW.holder_birth, NEW.holder_email, NEW.portal_access,
        NEW.consent_at, NEW.ip, NEW.user_agent, NEW.completed_at, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.link_id, OLD.protocol, OLD.plan, OLD.people_count, OLD.passport_number, OLD.holder_name,
        OLD.holder_cpf, OLD.holder_birth, OLD.holder_email, OLD.portal_access,
        OLD.consent_at, OLD.ip, OLD.user_agent, OLD.completed_at, OLD.created_at) THEN
      RAISE EXCEPTION 'Só é possível mudar o status, o WhatsApp e a observação do recadastramento.';
    END IF;
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

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'enviando' THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
    VALUES (NEW.org_id, NEW.id, 'status', auth.uid(), jsonb_build_object('de', OLD.status, 'para', NEW.status));
  END IF;
  IF NEW.holder_phone IS DISTINCT FROM OLD.holder_phone AND OLD.status <> 'enviando' THEN
    INSERT INTO recad_events (org_id, submission_id, kind, actor, meta)
    VALUES (NEW.org_id, NEW.id, 'telefone', auth.uid(), jsonb_build_object('de', OLD.holder_phone, 'para', NEW.holder_phone));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS recad_sub_after ON whatsapp_hub.recad_submissions;
CREATE TRIGGER recad_sub_after AFTER UPDATE ON whatsapp_hub.recad_submissions FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_sub_after();

-- RLS (formato rápido: funções em SELECT viram InitPlan)
ALTER TABLE whatsapp_hub.recad_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_notes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recad_issues_sel ON whatsapp_hub.recad_issues;
CREATE POLICY recad_issues_sel ON whatsapp_hub.recad_issues FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_issues_ins ON whatsapp_hub.recad_issues;
CREATE POLICY recad_issues_ins ON whatsapp_hub.recad_issues FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')));
DROP POLICY IF EXISTS recad_issues_upd ON whatsapp_hub.recad_issues;
CREATE POLICY recad_issues_upd ON whatsapp_hub.recad_issues FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS recad_notes_sel ON whatsapp_hub.recad_notes;
CREATE POLICY recad_notes_sel ON whatsapp_hub.recad_notes FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_notes_ins ON whatsapp_hub.recad_notes;
CREATE POLICY recad_notes_ins ON whatsapp_hub.recad_notes FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')));

DROP POLICY IF EXISTS recad_events_sel ON whatsapp_hub.recad_events;
CREATE POLICY recad_events_sel ON whatsapp_hub.recad_events FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_events_ins ON whatsapp_hub.recad_events;
CREATE POLICY recad_events_ins ON whatsapp_hub.recad_events FOR INSERT TO authenticated
  WITH CHECK (kind = 'whatsapp_aberto' AND pg_column_size(meta) < 1000 AND org_id = (SELECT whatsapp_hub.current_org_id())
              AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));

REVOKE ALL ON whatsapp_hub.recad_issues, whatsapp_hub.recad_notes, whatsapp_hub.recad_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON whatsapp_hub.recad_issues TO authenticated;
GRANT SELECT, INSERT ON whatsapp_hub.recad_notes, whatsapp_hub.recad_events TO authenticated;
GRANT USAGE ON SEQUENCE whatsapp_hub.recad_events_id_seq TO authenticated;
GRANT ALL ON whatsapp_hub.recad_issues, whatsapp_hub.recad_notes, whatsapp_hub.recad_events TO service_role;
GRANT USAGE ON SEQUENCE whatsapp_hub.recad_events_id_seq TO service_role;

-- Travas do formulário público (recadastro-public): envios por link na última hora
CREATE INDEX IF NOT EXISTS recad_sub_link_idx ON whatsapp_hub.recad_submissions (link_id, created_at);

-- Tempo real: dois atendentes no mesmo cadastro veem a mesma coisa
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.recad_issues; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.recad_notes;  EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Observação antiga (campo único team_notes) vira a 1ª observação do histórico — o campo continua lá, intacto.
INSERT INTO whatsapp_hub.recad_notes (org_id, submission_id, text, created_by, created_at)
SELECT s.org_id, s.id, s.team_notes, s.reviewed_by, coalesce(s.reviewed_at, s.created_at)
  FROM whatsapp_hub.recad_submissions s
 WHERE coalesce(btrim(s.team_notes), '') <> ''
   AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.recad_notes n WHERE n.submission_id = s.id);
-- (o trigger de preenchimento põe autor = quem roda o SQL; corrige para o autor original)
UPDATE whatsapp_hub.recad_notes n SET created_by = s.reviewed_by, created_at = coalesce(s.reviewed_at, s.created_at)
  FROM whatsapp_hub.recad_submissions s
 WHERE n.submission_id = s.id AND n.text = s.team_notes AND n.created_by IS NULL;

NOTIFY pgrst, 'reload schema';
SELECT 'central de recadastramento ok' AS situacao;
