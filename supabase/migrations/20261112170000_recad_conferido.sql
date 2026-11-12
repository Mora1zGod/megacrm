-- Recadastramento: status "conferido" (equipe conferiu os documentos; pronto para a extensão lançar no Pocket).
-- Fluxo: novo → em_analise → pendente → conferido → lancado (ou recusado).
-- "lancado" só a partir de "conferido": a extensão do navegador nunca lança um envio que ninguém conferiu.
-- Grava quem/quando conferiu e quem/quando lançou.
SET search_path TO whatsapp_hub;

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'whatsapp_hub.recad_submissions'::regclass AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE whatsapp_hub.recad_submissions DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE whatsapp_hub.recad_submissions
  ADD CONSTRAINT recad_submissions_status_check
  CHECK (status IN ('enviando', 'novo', 'em_analise', 'pendente', 'conferido', 'lancado', 'recusado'));

ALTER TABLE whatsapp_hub.recad_submissions
  ADD COLUMN IF NOT EXISTS checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS checked_by  uuid,
  ADD COLUMN IF NOT EXISTS launched_at timestamptz,
  ADD COLUMN IF NOT EXISTS launched_by uuid;

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
    IF NEW.status = 'lancado' AND OLD.status NOT IN ('conferido', 'lancado') THEN
      RAISE EXCEPTION 'Só dá para marcar como lançado no Pocket depois de "Conferido".';
    END IF;
    -- Datas/autores: só o banco preenche (o navegador não escolhe).
    NEW.checked_at := OLD.checked_at;  NEW.checked_by := OLD.checked_by;
    NEW.launched_at := OLD.launched_at; NEW.launched_by := OLD.launched_by;
    IF NEW.status = 'conferido' AND OLD.status <> 'conferido' THEN
      NEW.checked_at := now(); NEW.checked_by := auth.uid();
    END IF;
    IF NEW.status = 'lancado' AND OLD.status <> 'lancado' THEN
      NEW.launched_at := now(); NEW.launched_by := auth.uid();
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END $$;
