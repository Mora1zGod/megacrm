-- ============================================================================
-- Nota de entrada: item que o fornecedor já vendeu antes entra JÁ VINCULADO (17/10/2026)
-- ----------------------------------------------------------------------------
-- A "memória" é o próprio histórico: linhas de notas anteriores do MESMO fornecedor (pur_invoices.party_id)
-- que já foram ligadas a um item do estoque. Nota nova chegando (SEFAZ/XML/manual) → cada linha sem item
-- procura, nesta ordem: mesmo código de barras, mesmo código do produto do fornecedor, mesma descrição.
-- Copia também o fator de conversão usado da última vez. Nada é apagado; função e trigger novos. Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE OR REPLACE FUNCTION whatsapp_hub._pur_invoice_item_memory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE v_party uuid; v_item uuid; v_factor numeric;
BEGIN
  IF NEW.item_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT party_id INTO v_party FROM whatsapp_hub.pur_invoices WHERE id = NEW.invoice_id;
  IF v_party IS NULL THEN RETURN NEW; END IF;
  SELECT ii.item_id, ii.conversion_factor INTO v_item, v_factor
    FROM whatsapp_hub.pur_invoice_items ii
    JOIN whatsapp_hub.pur_invoices n ON n.id = ii.invoice_id
    JOIN whatsapp_hub.inv_items x ON x.id = ii.item_id AND x.is_active
   WHERE ii.org_id = NEW.org_id AND n.org_id = NEW.org_id AND n.party_id = v_party
     AND ii.invoice_id <> NEW.invoice_id AND ii.item_id IS NOT NULL
     AND ((NEW.gtin IS NOT NULL AND ii.gtin = NEW.gtin)
       OR (NEW.product_code IS NOT NULL AND ii.product_code = NEW.product_code)
       OR lower(btrim(ii.description)) = lower(btrim(NEW.description)))
   ORDER BY (NEW.gtin IS NOT NULL AND ii.gtin = NEW.gtin) DESC,
            (NEW.product_code IS NOT NULL AND ii.product_code = NEW.product_code) DESC,
            n.created_at DESC
   LIMIT 1;
  IF v_item IS NOT NULL THEN
    NEW.item_id := v_item;
    IF v_factor IS NOT NULL AND v_factor > 0 THEN NEW.conversion_factor := v_factor; END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_pur_invoice_items_memory ON whatsapp_hub.pur_invoice_items;
CREATE TRIGGER trg_pur_invoice_items_memory BEFORE INSERT ON whatsapp_hub.pur_invoice_items
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._pur_invoice_item_memory();

-- Índice para a busca do histórico por fornecedor.
CREATE INDEX IF NOT EXISTS pur_invoice_items_linked_idx
  ON whatsapp_hub.pur_invoice_items (org_id, product_code) WHERE item_id IS NOT NULL;

SELECT 'memória de itens por fornecedor instalada' AS ok;
