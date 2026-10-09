-- ============================================================================
-- E-mail no CRM (09/10/2026) — caixas IMAP/SMTP (Hostinger e outros)
-- ----------------------------------------------------------------------------
-- Cada usuário liga a PRÓPRIA caixa (owner_id). Pode liberar para colegas
-- (mail_account_members). Ninguém mais vê — nem admin — sem ser liberado.
-- A senha fica em mail_account_secrets (cifrada AES-GCM com CRYPTO_KEY), tabela
-- SEM policy: só o servidor (rota /api/mail na Vercel, service role) lê.
-- Os e-mails NÃO são copiados para o banco: a rota lê direto da caixa (IMAP)
-- e envia por SMTP, salvando a cópia em "Enviados".
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE TABLE IF NOT EXISTS whatsapp_hub.mail_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL DEFAULT auth.uid(),
  email         text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name  text,
  username      text NOT NULL,
  imap_host     text NOT NULL DEFAULT 'imap.hostinger.com',
  imap_port     int  NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
  smtp_host     text NOT NULL DEFAULT 'smtp.hostinger.com',
  smtp_port     int  NOT NULL DEFAULT 465 CHECK (smtp_port BETWEEN 1 AND 65535),
  signature     text,
  is_active     boolean NOT NULL DEFAULT true,
  last_ok_at    timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS mail_accounts_owner ON whatsapp_hub.mail_accounts (org_id, owner_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.mail_account_members (
  account_id  uuid NOT NULL REFERENCES whatsapp_hub.mail_accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  org_id      uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  can_send    boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS mail_account_members_user ON whatsapp_hub.mail_account_members (org_id, user_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.mail_account_secrets (
  account_id          uuid PRIMARY KEY REFERENCES whatsapp_hub.mail_accounts(id) ON DELETE CASCADE,
  password_encrypted  text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_hub.mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.mail_account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.mail_account_secrets ENABLE ROW LEVEL SECURITY;  -- sem policy: só service role

-- Dono ou membro liberado (SECURITY DEFINER para não depender da RLS entre as duas tabelas).
CREATE OR REPLACE FUNCTION whatsapp_hub.mail_can_use(p_account uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_hub.mail_accounts a
    WHERE a.id = p_account AND whatsapp_hub.in_org(a.org_id)
      AND (a.owner_id = auth.uid()
           OR EXISTS (SELECT 1 FROM whatsapp_hub.mail_account_members m WHERE m.account_id = a.id AND m.user_id = auth.uid()))
  );
$$;
REVOKE ALL ON FUNCTION whatsapp_hub.mail_can_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_hub.mail_can_use(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS mail_accounts_select ON whatsapp_hub.mail_accounts;
CREATE POLICY mail_accounts_select ON whatsapp_hub.mail_accounts FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (owner_id = auth.uid() OR whatsapp_hub.mail_can_use(id)));
-- Criar/alterar/excluir: só o dono (a senha e o teste de login passam pela rota /api/mail).
DROP POLICY IF EXISTS mail_accounts_owner_write ON whatsapp_hub.mail_accounts;
CREATE POLICY mail_accounts_owner_write ON whatsapp_hub.mail_accounts FOR ALL TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND owner_id = auth.uid())
  WITH CHECK (whatsapp_hub.in_org(org_id) AND owner_id = auth.uid());

DROP POLICY IF EXISTS mail_members_select ON whatsapp_hub.mail_account_members;
CREATE POLICY mail_members_select ON whatsapp_hub.mail_account_members FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND (user_id = auth.uid() OR whatsapp_hub.mail_can_use(account_id)));
-- Liberar para colegas: só o dono da caixa, e só para gente da mesma org.
DROP POLICY IF EXISTS mail_members_owner_write ON whatsapp_hub.mail_account_members;
CREATE POLICY mail_members_owner_write ON whatsapp_hub.mail_account_members FOR ALL TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND EXISTS (SELECT 1 FROM whatsapp_hub.mail_accounts a WHERE a.id = account_id AND a.owner_id = auth.uid()))
  WITH CHECK (
    whatsapp_hub.in_org(org_id)
    AND EXISTS (SELECT 1 FROM whatsapp_hub.mail_accounts a WHERE a.id = account_id AND a.owner_id = auth.uid() AND a.org_id = mail_account_members.org_id)
    AND EXISTS (SELECT 1 FROM whatsapp_hub.app_users u WHERE u.user_id = mail_account_members.user_id AND u.org_id = mail_account_members.org_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.mail_accounts, whatsapp_hub.mail_account_members TO authenticated;
GRANT ALL ON whatsapp_hub.mail_accounts, whatsapp_hub.mail_account_members, whatsapp_hub.mail_account_secrets TO service_role;
REVOKE ALL ON whatsapp_hub.mail_account_secrets FROM authenticated, anon;

-- org_id e dono não mudam; updated_at automático.
CREATE OR REPLACE FUNCTION whatsapp_hub._mail_accounts_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Não é possível trocar a organização ou o dono da caixa.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mail_accounts_guard ON whatsapp_hub.mail_accounts;
CREATE TRIGGER mail_accounts_guard BEFORE UPDATE ON whatsapp_hub.mail_accounts FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._mail_accounts_guard();

-- Bucket privado para anexos grandes (acima de 3 MB) — link assinado de 10 minutos, gerado pelo servidor.
INSERT INTO storage.buckets (id, name, public) VALUES ('whatsapp-hub-mail', 'whatsapp-hub-mail', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
