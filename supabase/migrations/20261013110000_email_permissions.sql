-- ============================================================================
-- Permissões do E-mail (13/10/2026)
-- ----------------------------------------------------------------------------
-- O E-mail não tinha permissão: todo mundo via o menu (cada um só a própria caixa).
-- Agora aparece em Perfis de acesso e nas permissões individuais:
--   email.view    Acessar o E-mail
--   email.send    Enviar e responder e-mails
--   email.connect Ligar a própria caixa de e-mail
--   email.share   Liberar a caixa para colegas
-- Para ninguém perder o que já tinha, TODOS os perfis atuais recebem as 4 (tire depois
-- de quem não deve usar). Org nova: os perfis padrão também nascem com elas.
-- A rota /api/mail confere a permissão no servidor; liberar a caixa (mail_account_members)
-- passa a exigir email.share também no banco.
-- Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

INSERT INTO whatsapp_hub.permissions (key, module, action, label, sort) VALUES
  ('email.view',    'email', 'view',    'Acessar o E-mail', 1500),
  ('email.send',    'email', 'send',    'Enviar e responder e-mails', 1501),
  ('email.connect', 'email', 'connect', 'Ligar a própria caixa de e-mail', 1502),
  ('email.share',   'email', 'share',   'Liberar a caixa para colegas', 1503)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module, action = EXCLUDED.action, sort = EXCLUDED.sort;

-- Perfis que já existem: continuam com o e-mail como hoje (só na 1ª vez — depois vale o que o admin marcar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.role_permissions WHERE permission_key LIKE 'email.%') THEN
    INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
    SELECT ar.id, p.key FROM whatsapp_hub.access_roles ar
      JOIN whatsapp_hub.permissions p ON p.module = 'email'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Org nova: depois de criar os perfis padrão, dá o e-mail a todos eles.
CREATE OR REPLACE FUNCTION whatsapp_hub._org_seed_email_perms()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  INSERT INTO whatsapp_hub.role_permissions (role_id, permission_key)
  SELECT ar.id, p.key FROM whatsapp_hub.access_roles ar
    JOIN whatsapp_hub.permissions p ON p.module = 'email'
   WHERE ar.org_id = NEW.id AND ar.is_system
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._org_seed_email_perms() FROM PUBLIC, authenticated, anon;
-- "zz_" no nome: os triggers AFTER rodam em ordem alfabética, este depois do que cria os perfis.
DROP TRIGGER IF EXISTS zz_org_seed_email_perms ON whatsapp_hub.organizations;
CREATE TRIGGER zz_org_seed_email_perms
  AFTER INSERT ON whatsapp_hub.organizations
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_seed_email_perms();

-- Liberar a caixa para colega (incluir/alterar) exige email.share; tirar a liberação continua livre para o dono.
DROP POLICY IF EXISTS mail_members_share_perm_ins ON whatsapp_hub.mail_account_members;
CREATE POLICY mail_members_share_perm_ins ON whatsapp_hub.mail_account_members AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK ((SELECT whatsapp_hub.has_perm('email.share')));
DROP POLICY IF EXISTS mail_members_share_perm_upd ON whatsapp_hub.mail_account_members;
CREATE POLICY mail_members_share_perm_upd ON whatsapp_hub.mail_account_members AS RESTRICTIVE
  FOR UPDATE TO authenticated USING ((SELECT whatsapp_hub.has_perm('email.share'))) WITH CHECK ((SELECT whatsapp_hub.has_perm('email.share')));

NOTIFY pgrst, 'reload schema';

-- Conferência: quantos perfis têm cada permissão do e-mail.
SELECT p.key AS permissao, count(rp.role_id) AS perfis_com_ela
  FROM whatsapp_hub.permissions p
  LEFT JOIN whatsapp_hub.role_permissions rp ON rp.permission_key = p.key
 WHERE p.module = 'email'
 GROUP BY p.key, p.sort ORDER BY p.sort;
