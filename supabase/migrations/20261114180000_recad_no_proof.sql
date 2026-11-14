-- ============================================================================
-- Recadastro SEM passaporte/contrato nem comprovante (14/11/2026).
-- O associado marca no formulário "Não tenho nenhum desses documentos": a foto do passaporte/contrato vira opcional,
-- o envio guarda no_proof = true e nasce com a pendência "Associado informou que não tem…" (criada pela função
-- recadastro-public), que trava "Conferido"/"Lançado" até a equipe/jurídico decidir. Nada é confirmado ao associado.
-- A equipe não muda no_proof (entra na lista de campos travados do _recad_sub_guard). Idempotente.
-- ============================================================================
SET search_path TO whatsapp_hub;
ALTER TABLE whatsapp_hub.recad_submissions ADD COLUMN IF NOT EXISTS no_proof boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION whatsapp_hub._recad_sub_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF (NEW.org_id, NEW.link_id, NEW.protocol, NEW.plan, NEW.people_count, NEW.passport_number, NEW.holder_name,
        NEW.holder_cpf, NEW.holder_birth, NEW.holder_email, NEW.portal_access,
        NEW.consent_at, NEW.ip, NEW.user_agent, NEW.completed_at, NEW.created_at, NEW.no_proof)
       IS DISTINCT FROM
       (OLD.org_id, OLD.link_id, OLD.protocol, OLD.plan, OLD.people_count, OLD.passport_number, OLD.holder_name,
        OLD.holder_cpf, OLD.holder_birth, OLD.holder_email, OLD.portal_access,
        OLD.consent_at, OLD.ip, OLD.user_agent, OLD.completed_at, OLD.created_at, OLD.no_proof) THEN
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


NOTIFY pgrst, 'reload schema';
SELECT 'recadastro sem comprovante ok' AS situacao;
