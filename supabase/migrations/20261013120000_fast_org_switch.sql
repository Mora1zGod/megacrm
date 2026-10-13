-- ============================================================================
-- Troca de organização rápida para o super admin (13/10/2026)
-- ----------------------------------------------------------------------------
-- Antes: o seletor chamava /api/admin/orgs e /api/admin/switch-org (funções da Vercel quase sem
-- uso → "acordavam" do zero a cada troca) e cada troca ainda fazia 2 chamadas ao servidor de login.
-- Agora: lista direto da tabela (o RLS já libera o super admin) e a troca é esta função no banco.
-- As rotas da Vercel continuam existindo (o front cai nelas se esta função ainda não existir).
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- p_back = true → volta para a organização de origem (home_org_id).
CREATE OR REPLACE FUNCTION whatsapp_hub.admin_switch_org(p_org uuid DEFAULT NULL, p_back boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
DECLARE v_meta jsonb; v_to uuid; v_name text;
BEGIN
  IF auth.uid() IS NULL OR NOT whatsapp_hub.is_super_admin() THEN
    RAISE EXCEPTION 'Só o super admin troca de organização por aqui.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(raw_app_meta_data, '{}'::jsonb) INTO v_meta FROM auth.users WHERE id = auth.uid();
  -- Confere também no banco (não só no token): a conta continua super admin.
  IF COALESCE((v_meta->>'is_super_admin')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Sua conta não é mais super admin.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_to := CASE WHEN p_back THEN NULLIF(v_meta->>'home_org_id', '')::uuid ELSE p_org END;
  IF v_to IS NULL THEN RAISE EXCEPTION 'Organização não informada.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT name INTO v_name FROM whatsapp_hub.organizations WHERE id = v_to;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organização não encontrada.' USING ERRCODE = 'no_data_found'; END IF;

  UPDATE auth.users SET raw_app_meta_data = v_meta || jsonb_build_object('org_id', v_to::text) WHERE id = auth.uid();
  RETURN v_to;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.admin_switch_org(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.admin_switch_org(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
SELECT 'troca rápida instalada' AS ok;
