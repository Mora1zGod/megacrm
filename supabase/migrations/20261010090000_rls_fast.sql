-- ============================================================================
-- Sistema mais rápido: regras de acesso (RLS) calculadas 1x por consulta (10/10/2026)
-- ----------------------------------------------------------------------------
-- As policies usam in_org(org_id) e has_perm('...'). Essas funções são
-- SECURITY DEFINER e o Postgres não consegue "abrir" nem guardar o resultado:
-- recalculava a permissão do usuário EM CADA LINHA de cada tabela da consulta
-- (lista de contas com milhares de parcelas = dezenas de milhares de checagens
-- → "canceling statement due to statement timeout").
--
-- Correção (recomendação do Supabase): envolver as chamadas que não dependem da
-- linha em (SELECT ...) — vira um "InitPlan", calculado uma vez por consulta.
--   in_org(org_id)          → (org_id = (SELECT current_org_id()) AND (SELECT current_org_active()))
--   has_perm('x')           → (SELECT has_perm('x'))
--   current_org_id() etc.   → (SELECT current_org_id())
--   auth.uid()              → (SELECT auth.uid())
-- Mesmo resultado (as funções são STABLE: não mudam dentro da consulta).
-- Só ALTER POLICY no schema whatsapp_hub — nada é apagado. Pode rodar de novo.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE OR REPLACE FUNCTION pg_temp._rls_fast_expr(e text)
RETURNS text
LANGUAGE plpgsql
AS $f$
DECLARE s text := e;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(s, 'whatsapp_hub\.in_org\(([A-Za-z_][A-Za-z0-9_.]*)\)',
         '(\1 = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active()))', 'g');
  s := regexp_replace(s, '(?<!SELECT )whatsapp_hub\.(current_org_id|current_org_active|is_super_admin|is_full_admin|current_user_role|current_user_active)\(\)',
         '(SELECT whatsapp_hub.\1())', 'g');
  s := regexp_replace(s, '(?<!SELECT )whatsapp_hub\.(has_perm|perm_scope)\((''[^'']*''::text)\)',
         '(SELECT whatsapp_hub.\1(\2))', 'g');
  s := regexp_replace(s, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g');
  RETURN s;
END
$f$;

DO $$
DECLARE
  r      record;
  nq     text;
  nc     text;
  stmt   text;
  n      int := 0;
BEGIN
  -- Nomes sempre com schema na leitura das policies (para o regex achar "whatsapp_hub.").
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'whatsapp_hub'
  LOOP
    nq := pg_temp._rls_fast_expr(r.qual);
    nc := pg_temp._rls_fast_expr(r.with_check);
    IF nq IS NOT DISTINCT FROM r.qual AND nc IS NOT DISTINCT FROM r.with_check THEN CONTINUE; END IF;
    stmt := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF nq IS NOT NULL THEN stmt := stmt || format(' USING (%s)', nq); END IF;
    IF nc IS NOT NULL THEN stmt := stmt || format(' WITH CHECK (%s)', nc); END IF;
    EXECUTE stmt;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'RLS: % policy(s) ajustada(s).', n;
END
$$;

-- Última cobrança da parcela (usada pela lista de contas).
CREATE INDEX IF NOT EXISTS fin_charges_inst_created_idx ON whatsapp_hub.fin_charges (installment_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
