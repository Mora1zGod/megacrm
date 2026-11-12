-- ============================================================================
-- RECADASTRAMENTO DE ASSOCIADOS (11/11/2026)
-- ----------------------------------------------------------------------------
-- Formulário público (/recadastro/<token>) onde o associado do AMAI 10 ou do
-- AMAI Infinity informa os próprios dados e os dos dependentes e envia as fotos
-- dos documentos. A equipe confere na tela /recadastramentos e lança no Pocket.
--
--   recad_links        link público por organização (token; desativar = trocar)
--   recad_submissions  1 envio = titular + passaporte + status da análise
--   recad_people       dependentes do envio
--   recad_files        fotos/PDF (bucket PRIVADO whatsapp-hub-recadastro)
--
-- Escrita pública só pela Edge Function recadastro-public (service role). A
-- equipe lê com recad.view e muda status/observação com recad.manage.
-- Regras dos passaportes (conferidas na função e mostradas na tela):
--   AMAI 10   = individual, 1 a 10 pessoas CONTANDO o titular;
--   Infinity  = familiar: pai, mãe, sogro, sogra, cônjuge e filhos (sem limite).
-- Idempotente. Só cria coisas novas.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, extensions, public;

INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('recad.view',   'recad', 'view',   'Ver recadastramentos de associados', 1700),
  ('recad.manage', 'recad', 'manage', 'Analisar recadastramentos e gerenciar o link', 1701)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- ------------------------------------------------------------------------ link público
CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(16), 'hex') CHECK (token ~ '^[0-9a-f]{20,64}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recad_links_org_idx ON whatsapp_hub.recad_links (org_id, is_active);

-- ------------------------------------------------------------------------ envios
CREATE SEQUENCE IF NOT EXISTS whatsapp_hub.recad_protocol_seq START 1001;
CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  link_id         uuid REFERENCES whatsapp_hub.recad_links(id) ON DELETE SET NULL,
  protocol        bigint NOT NULL DEFAULT nextval('whatsapp_hub.recad_protocol_seq') UNIQUE,
  status          text NOT NULL DEFAULT 'enviando'
                    CHECK (status IN ('enviando', 'novo', 'em_analise', 'pendente', 'lancado', 'recusado')),
  plan            text NOT NULL CHECK (plan IN ('amai10', 'infinity', 'nao_sei')),
  people_count    smallint CHECK (people_count IS NULL OR people_count BETWEEN 1 AND 10),
  passport_number text CHECK (passport_number IS NULL OR length(passport_number) <= 40),
  holder_name     text NOT NULL CHECK (length(btrim(holder_name)) BETWEEN 3 AND 120),
  holder_cpf      text NOT NULL CHECK (holder_cpf ~ '^[0-9]{11}$'),
  holder_birth    date,
  holder_email    text CHECK (holder_email IS NULL OR length(holder_email) <= 254),
  holder_phone    text CHECK (holder_phone IS NULL OR holder_phone ~ '^[0-9]{10,13}$'),
  portal_access   text NOT NULL CHECK (portal_access IN ('email', 'whatsapp')),
  contact_id      uuid REFERENCES whatsapp_hub.contacts(id) ON DELETE SET NULL,
  consent_at      timestamptz NOT NULL,
  ip              text,
  user_agent      text,
  team_notes      text CHECK (team_notes IS NULL OR length(team_notes) <= 2000),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  completed_at    timestamptz,                  -- o associado terminou de enviar os documentos
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recad_sub_org_idx ON whatsapp_hub.recad_submissions (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS recad_sub_cpf_idx ON whatsapp_hub.recad_submissions (org_id, holder_cpf);
CREATE INDEX IF NOT EXISTS recad_sub_ip_idx ON whatsapp_hub.recad_submissions (ip, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_people (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  position       smallint NOT NULL,
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  birth_date     date NOT NULL,
  relationship   text NOT NULL CHECK (relationship IN ('pai', 'mae', 'sogro', 'sogra', 'conjuge', 'filho', 'outro')),
  relationship_other text CHECK (relationship_other IS NULL OR length(relationship_other) <= 40),
  cpf            text CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$'),
  email          text CHECK (email IS NULL OR length(email) <= 254),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, position)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  person_id      uuid REFERENCES whatsapp_hub.recad_people(id) ON DELETE CASCADE,  -- NULL = do titular
  kind           text NOT NULL CHECK (kind IN ('passaporte', 'documento', 'certidao_casamento')),
  path           text NOT NULL,
  mime           text NOT NULL,
  size_bytes     integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recad_files_sub_idx ON whatsapp_hub.recad_files (submission_id);

-- Segredo do envio em andamento (o navegador manda junto com cada arquivo).
-- Sem policy e sem grant para a equipe: só a Edge Function lê. Apagado ao concluir.
CREATE TABLE IF NOT EXISTS whatsapp_hub.recad_upload_keys (
  submission_id  uuid PRIMARY KEY REFERENCES whatsapp_hub.recad_submissions(id) ON DELETE CASCADE,
  key_hash       text NOT NULL,
  expires_at     timestamptz NOT NULL
);

-- updated_at
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_sub_touch ON whatsapp_hub.recad_submissions;
CREATE TRIGGER recad_sub_touch BEFORE UPDATE ON whatsapp_hub.recad_submissions
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_touch();

-- A equipe (authenticated) só muda status, observação e quem analisou.
CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF (NEW.org_id, NEW.link_id, NEW.protocol, NEW.plan, NEW.people_count, NEW.passport_number, NEW.holder_name,
        NEW.holder_cpf, NEW.holder_birth, NEW.holder_email, NEW.holder_phone, NEW.portal_access,
        NEW.consent_at, NEW.ip, NEW.user_agent, NEW.completed_at, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.link_id, OLD.protocol, OLD.plan, OLD.people_count, OLD.passport_number, OLD.holder_name,
        OLD.holder_cpf, OLD.holder_birth, OLD.holder_email, OLD.holder_phone, OLD.portal_access,
        OLD.consent_at, OLD.ip, OLD.user_agent, OLD.completed_at, OLD.created_at) THEN
      RAISE EXCEPTION 'Só é possível mudar o status e a observação do recadastramento.';
    END IF;
    IF NEW.status = 'enviando' AND OLD.status <> 'enviando' THEN
      RAISE EXCEPTION 'Status inválido.';
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS recad_sub_guard ON whatsapp_hub.recad_submissions;
CREATE TRIGGER recad_sub_guard BEFORE UPDATE ON whatsapp_hub.recad_submissions
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._recad_sub_guard();

-- ------------------------------------------------------------------------ RLS
ALTER TABLE whatsapp_hub.recad_links       ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_people      ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_files       ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.recad_upload_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recad_links_sel ON whatsapp_hub.recad_links;
CREATE POLICY recad_links_sel ON whatsapp_hub.recad_links FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_links_ins ON whatsapp_hub.recad_links;
CREATE POLICY recad_links_ins ON whatsapp_hub.recad_links FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')));
DROP POLICY IF EXISTS recad_links_upd ON whatsapp_hub.recad_links;
CREATE POLICY recad_links_upd ON whatsapp_hub.recad_links FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS recad_sub_sel ON whatsapp_hub.recad_submissions;
CREATE POLICY recad_sub_sel ON whatsapp_hub.recad_submissions FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_sub_upd ON whatsapp_hub.recad_submissions;
CREATE POLICY recad_sub_upd ON whatsapp_hub.recad_submissions FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS recad_people_sel ON whatsapp_hub.recad_people;
CREATE POLICY recad_people_sel ON whatsapp_hub.recad_people FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));
DROP POLICY IF EXISTS recad_files_sel ON whatsapp_hub.recad_files;
CREATE POLICY recad_files_sel ON whatsapp_hub.recad_files FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('recad.view')));

REVOKE ALL ON whatsapp_hub.recad_links, whatsapp_hub.recad_submissions, whatsapp_hub.recad_people, whatsapp_hub.recad_files, whatsapp_hub.recad_upload_keys FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON whatsapp_hub.recad_links TO authenticated;
GRANT SELECT ON whatsapp_hub.recad_people, whatsapp_hub.recad_files TO authenticated;
GRANT SELECT, UPDATE ON whatsapp_hub.recad_submissions TO authenticated;  -- o trigger _recad_sub_guard limita a status/observação
GRANT ALL ON whatsapp_hub.recad_links, whatsapp_hub.recad_submissions, whatsapp_hub.recad_people, whatsapp_hub.recad_files, whatsapp_hub.recad_upload_keys TO service_role;
GRANT USAGE ON SEQUENCE whatsapp_hub.recad_protocol_seq TO service_role;

-- ------------------------------------------------------------------------ arquivos (bucket privado)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('whatsapp-hub-recadastro', 'whatsapp-hub-recadastro', false, 8388608,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS recad_files_read ON storage.objects;
CREATE POLICY recad_files_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'whatsapp-hub-recadastro'
    AND (storage.foldername(name))[1] = (SELECT whatsapp_hub.current_org_id())::text
    AND (SELECT whatsapp_hub.current_org_active())
    AND (SELECT whatsapp_hub.has_perm('recad.view')));

-- Link inicial de cada organização ativa (a equipe troca na tela quando quiser).
INSERT INTO whatsapp_hub.recad_links (org_id, created_by)
SELECT o.id, NULL FROM whatsapp_hub.organizations o
 WHERE o.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.recad_links l WHERE l.org_id = o.id);

-- Realtime: envio novo aparece sozinho na tela da equipe (respeita o RLS).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.recad_submissions; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

SELECT 'recadastramento instalado' AS situacao,
       (SELECT count(*) FROM whatsapp_hub.recad_links WHERE is_active) AS links_ativos,
       EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whatsapp-hub-recadastro') AS bucket;
