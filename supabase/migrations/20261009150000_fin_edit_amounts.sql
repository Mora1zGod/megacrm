-- ============================================================================
-- Financeiro: editar o VALOR das parcelas de um lançamento (09/10/2026)
-- ----------------------------------------------------------------------------
-- Antes a edição só mudava o cabeçalho. Agora dá para corrigir o valor de cada
-- parcela que ainda não teve baixa; o total do lançamento passa a ser a soma.
-- O vencimento já mudava pelo fin_update_entry (chave due_dates) — a tela é que
-- não mandava. Não apaga nada; tudo vai para o fin_audit_log (trigger existente).
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- p_amounts: {"<id da parcela>": <centavos>, ...}
CREATE OR REPLACE FUNCTION whatsapp_hub.fin_update_installment_amounts(p_entry uuid, p_amounts jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  e       record;
  r       record;
  v_cents bigint;
  v_total bigint;
BEGIN
  PERFORM whatsapp_hub.fin_require('financial.ledger_edit', 'editar lançamentos');
  SELECT * INTO e FROM whatsapp_hub.fin_entries WHERE id = p_entry AND org_id = whatsapp_hub.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN PERFORM whatsapp_hub.fin_fail('Lançamento não encontrado.'); END IF;
  IF e.status = 'canceled' THEN PERFORM whatsapp_hub.fin_fail('Lançamento cancelado não pode ser alterado.'); END IF;
  IF jsonb_typeof(p_amounts) IS DISTINCT FROM 'object' THEN PERFORM whatsapp_hub.fin_fail('Nada para alterar.'); END IF;
  PERFORM whatsapp_hub.fin_assert_open(e.company_id, e.competence_date, 'alterar lançamentos');

  FOR r IN SELECT key, value FROM jsonb_each(p_amounts) LOOP
    BEGIN
      v_cents := (r.value #>> '{}')::bigint;
    EXCEPTION WHEN others THEN
      PERFORM whatsapp_hub.fin_fail('Valor inválido.');
    END;
    IF v_cents IS NULL OR v_cents <= 0 THEN PERFORM whatsapp_hub.fin_fail('Cada parcela precisa de um valor maior que zero.'); END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.fin_installments WHERE id::text = r.key AND entry_id = e.id) THEN
      PERFORM whatsapp_hub.fin_fail('Parcela não encontrada neste lançamento.');
    END IF;
    IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_settlements WHERE installment_id::text = r.key) THEN
      PERFORM whatsapp_hub.fin_fail('Parcela com baixa não muda de valor. Estorne a baixa antes, se precisar.');
    END IF;
    IF EXISTS (SELECT 1 FROM whatsapp_hub.fin_charges WHERE installment_id::text = r.key AND status IN ('pending', 'open')) THEN
      PERFORM whatsapp_hub.fin_fail('Parcela com cobrança emitida: cancele a cobrança antes de mudar o valor.');
    END IF;
    UPDATE whatsapp_hub.fin_installments SET amount_cents = v_cents
     WHERE id::text = r.key AND entry_id = e.id AND amount_cents IS DISTINCT FROM v_cents;
  END LOOP;

  SELECT sum(amount_cents) INTO v_total FROM whatsapp_hub.fin_installments WHERE entry_id = e.id;
  UPDATE whatsapp_hub.fin_entries SET total_cents = v_total WHERE id = e.id AND total_cents IS DISTINCT FROM v_total;
  RETURN v_total;
END
$$;

REVOKE ALL ON FUNCTION whatsapp_hub.fin_update_installment_amounts(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_hub.fin_update_installment_amounts(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
