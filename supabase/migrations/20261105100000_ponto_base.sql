-- ============================================================================
-- PONTO — fase 1: funcionários, aparelhos Control iD (iDFace) e registro das batidas (05/11/2026)
-- ----------------------------------------------------------------------------
-- O iDFace funciona como "coletor de marcações" (Portaria MTP 671, art. 75 parágrafo único). O CRM guarda as
-- batidas já no formato que o REP-P exige (Anexo IX), para os arquivos legais (AFD/AEJ, fase 3) saírem daqui:
--   * NSR sequencial por ESTABELECIMENTO (empresa = fin_companies), começando em 1, +1 por registro;
--   * cada batida com CPF, data/hora da marcação e do registro (com fuso), coletor e hash SHA-256;
--   * batidas NUNCA são alteradas nem apagadas (trigger) — correção vira AJUSTE (fase 2), não edição;
--   * alteração de funcionário (inclusão/alteração/exclusão) e de relógio ficam registradas com NSR (tipos 5 e 4).
-- O aparelho chama a Edge Function controlid-push pela internet (modo Push): não precisa abrir porta no parque.
-- Comunicação com o aparelho = fila ponto_device_cmds (o servidor entrega 1 comando por consulta do aparelho).
-- Permissões novas: ponto.view (ver), ponto.manage (funcionários e aparelhos), ponto.adjust (ajustes — fase 2),
-- ponto.export (AFD/AEJ — fase 3). Perfis "Administrador" já têm tudo; os outros recebem quando o admin marcar.
-- Idempotente. Só cria coisas novas.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, extensions, public;  -- pgcrypto (gen_random_bytes, digest) fica em extensions no Supabase
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('ponto.view',   'ponto', 'view',   'Ver ponto (batidas e espelho)', 1600),
  ('ponto.manage', 'ponto', 'manage', 'Cadastrar funcionários e aparelhos do ponto', 1601),
  ('ponto.adjust', 'ponto', 'adjust', 'Lançar e aprovar ajustes de ponto', 1602),
  ('ponto.export', 'ponto', 'export', 'Gerar arquivos do ponto (AFD/AEJ)', 1603)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- ------------------------------------------------------------------------ funcionários
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 52),
  cpf             text NOT NULL CHECK (cpf ~ '^[0-9]{11}$'),
  registration    text CHECK (registration IS NULL OR length(registration) <= 20),   -- matrícula
  job_title       text CHECK (job_title IS NULL OR length(job_title) <= 80),
  admission_date  date,
  dismissal_date  date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  device_user_id  bigint NOT NULL,                                                   -- id do usuário no iDFace
  photo_path      text,                                                              -- bucket whatsapp-hub-ponto
  photo_synced_at timestamptz,
  app_user_id     uuid,                                                              -- se também usa o CRM (opcional)
  notes           text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by      uuid DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, cpf),
  UNIQUE (org_id, device_user_id)
);
CREATE INDEX IF NOT EXISTS ponto_employees_company_idx ON whatsapp_hub.ponto_employees (company_id, status);
CREATE SEQUENCE IF NOT EXISTS whatsapp_hub.ponto_device_user_seq START 1000;
ALTER TABLE whatsapp_hub.ponto_employees ALTER COLUMN device_user_id SET DEFAULT nextval('whatsapp_hub.ponto_device_user_seq');
GRANT USAGE ON SEQUENCE whatsapp_hub.ponto_device_user_seq TO authenticated;

-- ------------------------------------------------------------------------ aparelhos
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  model            text NOT NULL DEFAULT 'idface' CHECK (model IN ('idface')),
  push_token       text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex') UNIQUE,  -- vai na URL do aparelho
  timezone         text NOT NULL DEFAULT 'America/Rio_Branco',
  device_serial    text,                       -- deviceId que o aparelho informa no Push
  last_seen_at     timestamptz,
  last_log_id      bigint NOT NULL DEFAULT 0,  -- maior access_logs.id já recebido
  last_logs_poll_at timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ponto_devices_org_idx ON whatsapp_hub.ponto_devices (org_id);

-- Fila de comandos para o aparelho (o aparelho busca no Push; 1 por vez, na ordem).
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_device_cmds (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES whatsapp_hub.ponto_devices(id) ON DELETE CASCADE,
  kind          text NOT NULL,                 -- user_upsert | user_photo | user_delete | set_time | raw
  employee_id   uuid,
  verb          text NOT NULL DEFAULT 'POST',
  endpoint      text NOT NULL,
  body          jsonb,
  query_string  text,
  content_type  text NOT NULL DEFAULT 'application/json',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'done', 'error')),
  uuid          text,
  attempts      int NOT NULL DEFAULT 0,
  result        jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  done_at       timestamptz
);
CREATE INDEX IF NOT EXISTS ponto_device_cmds_queue_idx ON whatsapp_hub.ponto_device_cmds (device_id, status, id);

-- ------------------------------------------------------------------------ registro (ARP)
-- NSR por estabelecimento (empresa). Um contador por empresa, com lock de linha.
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_nsr (
  company_id  uuid PRIMARY KEY REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  org_id      uuid NOT NULL,
  last_nsr    bigint NOT NULL DEFAULT 0
);

-- Batidas (AFD tipo 7). Imutáveis.
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_marks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE RESTRICT,
  company_id      uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  nsr             bigint NOT NULL,
  employee_id     uuid NOT NULL REFERENCES whatsapp_hub.ponto_employees(id) ON DELETE RESTRICT,
  cpf             text NOT NULL,
  marked_at       timestamptz NOT NULL,        -- quando a pessoa bateu (relógio do aparelho)
  recorded_at     timestamptz NOT NULL DEFAULT now(),  -- quando o CRM gravou
  tz              text NOT NULL,               -- fuso do estabelecimento (ex. America/Rio_Branco)
  device_id       uuid REFERENCES whatsapp_hub.ponto_devices(id) ON DELETE RESTRICT,
  collector       text NOT NULL,               -- identificação do coletor (nome + série)
  device_log_id   bigint,                      -- access_logs.id no aparelho
  online          boolean NOT NULL DEFAULT true,
  hash            text NOT NULL,               -- SHA-256 (hex)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, nsr),
  UNIQUE (device_id, device_log_id)
);
CREATE INDEX IF NOT EXISTS ponto_marks_emp_idx ON whatsapp_hub.ponto_marks (employee_id, marked_at);
CREATE INDEX IF NOT EXISTS ponto_marks_org_time_idx ON whatsapp_hub.ponto_marks (org_id, marked_at DESC);

-- Outros registros com NSR (AFD tipos 2 empresa, 4 relógio, 5 funcionário, 6 eventos). Imutáveis.
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE RESTRICT,
  company_id  uuid NOT NULL REFERENCES whatsapp_hub.fin_companies(id) ON DELETE RESTRICT,
  nsr         bigint NOT NULL,
  record_type smallint NOT NULL CHECK (record_type IN (2, 4, 5, 6)),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_cpf   text,
  data        jsonb NOT NULL,
  UNIQUE (company_id, nsr)
);
CREATE INDEX IF NOT EXISTS ponto_records_company_idx ON whatsapp_hub.ponto_records (company_id, at);

-- Tudo que o aparelho mandou (inclusive não identificado / negado): diagnóstico. Não é o registro legal.
CREATE TABLE IF NOT EXISTS whatsapp_hub.ponto_device_logs (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL,
  device_id     uuid NOT NULL REFERENCES whatsapp_hub.ponto_devices(id) ON DELETE CASCADE,
  device_log_id bigint NOT NULL,
  event         int,
  device_user_id bigint,
  raw_time      bigint,
  marked_at     timestamptz,
  mark_id       uuid,
  note          text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, device_log_id)
);
CREATE INDEX IF NOT EXISTS ponto_device_logs_recent_idx ON whatsapp_hub.ponto_device_logs (org_id, received_at DESC);

-- Imutabilidade do registro legal: nada de UPDATE/DELETE em batidas e registros (nem pela service role).
CREATE OR REPLACE FUNCTION whatsapp_hub._ponto_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro de ponto não pode ser alterado nem apagado (Portaria 671). Use um ajuste.';
END $$;
DROP TRIGGER IF EXISTS ponto_marks_immutable ON whatsapp_hub.ponto_marks;
CREATE TRIGGER ponto_marks_immutable BEFORE UPDATE OR DELETE ON whatsapp_hub.ponto_marks
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._ponto_immutable();
DROP TRIGGER IF EXISTS ponto_records_immutable ON whatsapp_hub.ponto_records;
CREATE TRIGGER ponto_records_immutable BEFORE UPDATE OR DELETE ON whatsapp_hub.ponto_records
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._ponto_immutable();

-- Próximo NSR do estabelecimento (lock de linha: duas batidas ao mesmo tempo não pegam o mesmo número).
CREATE OR REPLACE FUNCTION whatsapp_hub._ponto_next_nsr(p_company uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE v bigint; v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM whatsapp_hub.fin_companies WHERE id = p_company;
  INSERT INTO whatsapp_hub.ponto_nsr (company_id, org_id, last_nsr) VALUES (p_company, v_org, 0)
  ON CONFLICT (company_id) DO NOTHING;
  UPDATE whatsapp_hub.ponto_nsr SET last_nsr = last_nsr + 1 WHERE company_id = p_company RETURNING last_nsr INTO v;
  RETURN v;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._ponto_next_nsr(uuid) FROM PUBLIC, anon, authenticated;

-- Registro com NSR (tipos 2/4/5/6).
CREATE OR REPLACE FUNCTION whatsapp_hub._ponto_record(p_company uuid, p_type smallint, p_data jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE v_nsr bigint; v_org uuid; v_cpf text;
BEGIN
  SELECT org_id INTO v_org FROM whatsapp_hub.fin_companies WHERE id = p_company;
  v_nsr := whatsapp_hub._ponto_next_nsr(p_company);
  -- CPF de quem fez (se a pessoa logada também é funcionária cadastrada no ponto)
  SELECT e.cpf INTO v_cpf FROM whatsapp_hub.ponto_employees e WHERE e.app_user_id = auth.uid() AND e.org_id = v_org LIMIT 1;
  INSERT INTO whatsapp_hub.ponto_records (org_id, company_id, nsr, record_type, actor_id, actor_cpf, data)
  VALUES (v_org, p_company, v_nsr, p_type, auth.uid(), v_cpf, p_data);
  RETURN v_nsr;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._ponto_record(uuid, smallint, jsonb) FROM PUBLIC, anon, authenticated;

-- Gravar uma batida (só a Edge Function, com a service role). Devolve o id (ou o existente, se repetida).
CREATE OR REPLACE FUNCTION whatsapp_hub.ponto_register_mark(
  p_device uuid, p_device_log_id bigint, p_device_user_id bigint, p_marked_at timestamptz, p_online boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, extensions, public, pg_temp AS $$
DECLARE
  d whatsapp_hub.ponto_devices%ROWTYPE;
  e whatsapp_hub.ponto_employees%ROWTYPE;
  v_id uuid; v_nsr bigint; v_rec timestamptz := now(); v_collector text; v_hash text;
BEGIN
  SELECT * INTO d FROM whatsapp_hub.ponto_devices WHERE id = p_device;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aparelho não encontrado'; END IF;
  SELECT id INTO v_id FROM whatsapp_hub.ponto_marks WHERE device_id = p_device AND device_log_id = p_device_log_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT * INTO e FROM whatsapp_hub.ponto_employees WHERE org_id = d.org_id AND device_user_id = p_device_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- pessoa do aparelho que não está cadastrada no CRM

  v_nsr := whatsapp_hub._ponto_next_nsr(e.company_id);
  v_collector := left(d.name || COALESCE(' #' || d.device_serial, ''), 80);
  -- SHA-256 dos dados da marcação (NSR, CPF, data/hora da marcação e do registro, coletor, online/offline)
  v_hash := encode(digest(concat_ws('|', v_nsr, e.cpf,
              to_char(p_marked_at AT TIME ZONE d.timezone, 'YYYY-MM-DD"T"HH24:MI:SS'),
              to_char(v_rec AT TIME ZONE d.timezone, 'YYYY-MM-DD"T"HH24:MI:SS'),
              v_collector, CASE WHEN p_online THEN '0' ELSE '1' END), 'sha256'), 'hex');
  INSERT INTO whatsapp_hub.ponto_marks (org_id, company_id, nsr, employee_id, cpf, marked_at, recorded_at, tz, device_id,
                                        collector, device_log_id, online, hash)
  VALUES (d.org_id, e.company_id, v_nsr, e.id, e.cpf, p_marked_at, v_rec, d.timezone, d.id, v_collector, p_device_log_id,
          p_online, v_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.ponto_register_mark(uuid, bigint, bigint, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.ponto_register_mark(uuid, bigint, bigint, timestamptz, boolean) TO service_role;

-- ------------------------------------------------------------------------ funcionário → registro + aparelhos
-- Inclusão/alteração/desligamento: grava o registro tipo 5 (com NSR) e manda o cadastro para os aparelhos da empresa.
CREATE OR REPLACE FUNCTION whatsapp_hub._ponto_employee_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE
  v_op text; dev record; v_active boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN v_op := 'I';
  ELSIF NEW.status = 'inactive' AND OLD.status = 'active' THEN v_op := 'E';
  ELSIF NEW.name IS DISTINCT FROM OLD.name OR NEW.cpf IS DISTINCT FROM OLD.cpf OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN v_op := 'A';
  END IF;
  IF v_op IS NOT NULL THEN
    PERFORM whatsapp_hub._ponto_record(NEW.company_id, 5::smallint, jsonb_build_object(
      'op', v_op, 'cpf', NEW.cpf, 'name', NEW.name, 'employee_id', NEW.id,
      'old_cpf', CASE WHEN TG_OP = 'UPDATE' AND OLD.cpf IS DISTINCT FROM NEW.cpf THEN OLD.cpf END));
  END IF;

  v_active := NEW.status = 'active';
  IF TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.registration IS DISTINCT FROM OLD.registration THEN
    FOR dev IN SELECT id, org_id, company_id FROM whatsapp_hub.ponto_devices WHERE org_id = NEW.org_id AND is_active LOOP
      IF v_active AND dev.company_id = NEW.company_id THEN
        INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, employee_id, endpoint, body)
        VALUES (dev.org_id, dev.id, 'user_upsert', NEW.id, 'create_or_modify_objects', jsonb_build_object(
          'object', 'users',
          'values', jsonb_build_array(jsonb_build_object('id', NEW.device_user_id, 'name', NEW.name,
                                                         'registration', COALESCE(NEW.registration, NEW.cpf)))));
      ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, employee_id, endpoint, body)
        VALUES (dev.org_id, dev.id, 'user_delete', NEW.id, 'destroy_objects', jsonb_build_object(
          'object', 'users', 'where', jsonb_build_object('users', jsonb_build_object('id', NEW.device_user_id))));
      END IF;
    END LOOP;
  END IF;
  -- Foto nova: manda para os aparelhos (a Edge Function lê o arquivo e envia em base64).
  IF v_active AND NEW.photo_path IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.photo_path IS DISTINCT FROM OLD.photo_path
       OR NEW.company_id IS DISTINCT FROM OLD.company_id OR (OLD.status = 'inactive')) THEN
    INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, employee_id, endpoint, query_string, content_type)
    SELECT d.org_id, d.id, 'user_photo', NEW.id, 'user_set_image', 'user_id=' || NEW.device_user_id, 'application/octet-stream'
      FROM whatsapp_hub.ponto_devices d WHERE d.org_id = NEW.org_id AND d.is_active AND d.company_id = NEW.company_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._ponto_employee_after() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ponto_employees_after ON whatsapp_hub.ponto_employees;
CREATE TRIGGER ponto_employees_after AFTER INSERT OR UPDATE ON whatsapp_hub.ponto_employees
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._ponto_employee_after();

-- Guarda: CPF/empresa consistentes, ninguém troca org_id, apagar funcionário só se nunca bateu ponto.
CREATE OR REPLACE FUNCTION whatsapp_hub._ponto_employee_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM whatsapp_hub.ponto_marks WHERE employee_id = OLD.id) THEN
      RAISE EXCEPTION 'Funcionário com batidas não pode ser apagado. Use "Desligar".';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_companies c WHERE c.id = NEW.company_id AND c.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'Empresa inválida.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.org_id := OLD.org_id;
    NEW.device_user_id := OLD.device_user_id;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF NEW.photo_path IS DISTINCT FROM OLD.photo_path THEN NEW.photo_synced_at := NULL; END IF;
  END IF;
  IF NEW.status = 'inactive' AND NEW.dismissal_date IS NULL THEN NEW.dismissal_date := (now() AT TIME ZONE 'America/Rio_Branco')::date; END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._ponto_employee_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ponto_employees_guard ON whatsapp_hub.ponto_employees;
CREATE TRIGGER ponto_employees_guard BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_hub.ponto_employees
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._ponto_employee_guard();

-- Aparelho novo: recebe todos os funcionários ativos da empresa (cadastro + foto).
CREATE OR REPLACE FUNCTION whatsapp_hub.ponto_device_resync(p_device uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE d whatsapp_hub.ponto_devices%ROWTYPE; n int := 0; e record;
BEGIN
  SELECT * INTO d FROM whatsapp_hub.ponto_devices WHERE id = p_device;
  IF NOT FOUND OR d.org_id <> whatsapp_hub.current_org_id() OR NOT whatsapp_hub.has_perm('ponto.manage') THEN
    RAISE EXCEPTION 'Aparelho não encontrado ou sem permissão.';
  END IF;
  -- tira da fila o que ainda não foi (vai tudo de novo, na ordem)
  UPDATE whatsapp_hub.ponto_device_cmds SET status = 'error', error = 'substituído por reenvio completo'
   WHERE device_id = d.id AND status IN ('pending', 'sent') AND kind IN ('user_upsert', 'user_photo');
  FOR e IN SELECT * FROM whatsapp_hub.ponto_employees WHERE org_id = d.org_id AND company_id = d.company_id AND status = 'active' ORDER BY name LOOP
    INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, employee_id, endpoint, body)
    VALUES (d.org_id, d.id, 'user_upsert', e.id, 'create_or_modify_objects', jsonb_build_object(
      'object', 'users', 'values', jsonb_build_array(jsonb_build_object('id', e.device_user_id, 'name', e.name,
                                                                         'registration', COALESCE(e.registration, e.cpf)))));
    IF e.photo_path IS NOT NULL THEN
      INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, employee_id, endpoint, query_string, content_type)
      VALUES (d.org_id, d.id, 'user_photo', e.id, 'user_set_image', 'user_id=' || e.device_user_id, 'application/octet-stream');
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.ponto_device_resync(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.ponto_device_resync(uuid) TO authenticated;

-- Acertar o relógio do aparelho pela hora do servidor (registro tipo 4 com antes/depois quando o aparelho confirmar).
CREATE OR REPLACE FUNCTION whatsapp_hub.ponto_device_set_time(p_device uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE d whatsapp_hub.ponto_devices%ROWTYPE;
BEGIN
  SELECT * INTO d FROM whatsapp_hub.ponto_devices WHERE id = p_device;
  IF NOT FOUND OR d.org_id <> whatsapp_hub.current_org_id() OR NOT whatsapp_hub.has_perm('ponto.manage') THEN
    RAISE EXCEPTION 'Aparelho não encontrado ou sem permissão.';
  END IF;
  -- O corpo com a hora é montado pela Edge Function no momento do envio (hora exata).
  INSERT INTO whatsapp_hub.ponto_device_cmds (org_id, device_id, kind, endpoint, body)
  VALUES (d.org_id, d.id, 'set_time', 'set_system_time', jsonb_build_object('requested_by', auth.uid()));
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.ponto_device_set_time(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.ponto_device_set_time(uuid) TO authenticated;

-- Registro do relógio (tipo 4) — chamado pela Edge Function quando o aparelho confirma o acerto.
CREATE OR REPLACE FUNCTION whatsapp_hub.ponto_log_clock(p_device uuid, p_before timestamptz, p_after timestamptz, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE d whatsapp_hub.ponto_devices%ROWTYPE;
BEGIN
  SELECT * INTO d FROM whatsapp_hub.ponto_devices WHERE id = p_device;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM whatsapp_hub._ponto_record(d.company_id, 4::smallint, jsonb_build_object(
    'device_id', d.id, 'collector', d.name, 'before', p_before, 'after', p_after, 'actor_id', p_actor, 'tz', d.timezone));
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.ponto_log_clock(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.ponto_log_clock(uuid, timestamptz, timestamptz, uuid) TO service_role;

-- ------------------------------------------------------------------------ RLS
ALTER TABLE whatsapp_hub.ponto_employees   ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_devices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_device_cmds ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_nsr         ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_marks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ponto_device_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ponto_employees_sel ON whatsapp_hub.ponto_employees;
CREATE POLICY ponto_employees_sel ON whatsapp_hub.ponto_employees FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.view')));
DROP POLICY IF EXISTS ponto_employees_ins ON whatsapp_hub.ponto_employees;
CREATE POLICY ponto_employees_ins ON whatsapp_hub.ponto_employees FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));
DROP POLICY IF EXISTS ponto_employees_upd ON whatsapp_hub.ponto_employees;
CREATE POLICY ponto_employees_upd ON whatsapp_hub.ponto_employees FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));
DROP POLICY IF EXISTS ponto_employees_del ON whatsapp_hub.ponto_employees;
CREATE POLICY ponto_employees_del ON whatsapp_hub.ponto_employees FOR DELETE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));

DROP POLICY IF EXISTS ponto_devices_sel ON whatsapp_hub.ponto_devices;
CREATE POLICY ponto_devices_sel ON whatsapp_hub.ponto_devices FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));
DROP POLICY IF EXISTS ponto_devices_ins ON whatsapp_hub.ponto_devices;
CREATE POLICY ponto_devices_ins ON whatsapp_hub.ponto_devices FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));
DROP POLICY IF EXISTS ponto_devices_upd ON whatsapp_hub.ponto_devices;
CREATE POLICY ponto_devices_upd ON whatsapp_hub.ponto_devices FOR UPDATE TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')))
  WITH CHECK (org_id = (SELECT whatsapp_hub.current_org_id()));

DROP POLICY IF EXISTS ponto_cmds_sel ON whatsapp_hub.ponto_device_cmds;
CREATE POLICY ponto_cmds_sel ON whatsapp_hub.ponto_device_cmds FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));

DROP POLICY IF EXISTS ponto_marks_sel ON whatsapp_hub.ponto_marks;
CREATE POLICY ponto_marks_sel ON whatsapp_hub.ponto_marks FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.view')));
DROP POLICY IF EXISTS ponto_records_sel ON whatsapp_hub.ponto_records;
CREATE POLICY ponto_records_sel ON whatsapp_hub.ponto_records FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));
DROP POLICY IF EXISTS ponto_device_logs_sel ON whatsapp_hub.ponto_device_logs;
CREATE POLICY ponto_device_logs_sel ON whatsapp_hub.ponto_device_logs FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()) AND (SELECT whatsapp_hub.has_perm('ponto.manage')));
-- ponto_nsr: sem policy (só funções do banco).

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.ponto_employees TO authenticated;
GRANT SELECT, INSERT, UPDATE ON whatsapp_hub.ponto_devices TO authenticated;
GRANT SELECT ON whatsapp_hub.ponto_device_cmds, whatsapp_hub.ponto_marks, whatsapp_hub.ponto_records, whatsapp_hub.ponto_device_logs TO authenticated;
GRANT ALL ON whatsapp_hub.ponto_employees, whatsapp_hub.ponto_devices, whatsapp_hub.ponto_device_cmds, whatsapp_hub.ponto_nsr,
  whatsapp_hub.ponto_marks, whatsapp_hub.ponto_records, whatsapp_hub.ponto_device_logs TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA whatsapp_hub TO service_role;

-- ------------------------------------------------------------------------ fotos (bucket privado)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('whatsapp-hub-ponto', 'whatsapp-hub-ponto', false, 1048576, ARRAY['image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS ponto_photos_select ON storage.objects;
CREATE POLICY ponto_photos_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'whatsapp-hub-ponto'
    AND (storage.foldername(name))[1] = (SELECT whatsapp_hub.current_org_id())::text
    AND (SELECT whatsapp_hub.has_perm('ponto.view')));
DROP POLICY IF EXISTS ponto_photos_insert ON storage.objects;
CREATE POLICY ponto_photos_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'whatsapp-hub-ponto'
    AND (storage.foldername(name))[1] = (SELECT whatsapp_hub.current_org_id())::text
    AND (SELECT whatsapp_hub.has_perm('ponto.manage')));

-- Realtime: batida nova aparece sozinha na tela (respeita o RLS).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.ponto_marks; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Conferência
SELECT 'ponto instalado' AS situacao,
       (SELECT count(*) FROM whatsapp_hub.permissions WHERE module = 'ponto') AS permissoes,
       to_regclass('whatsapp_hub.ponto_marks') IS NOT NULL AS tabela_batidas,
       EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'whatsapp-hub-ponto') AS bucket_fotos;
