-- ============================================================================
-- Notificações por WhatsApp (08/10/2026)
-- ----------------------------------------------------------------------------
-- A org escolhe UM número UAZAPI que envia os avisos internos (sem janela de 24 h
-- da API oficial) e cadastra os destinatários: pessoas (número) ou grupos (JID
-- …@g.us). O envio é feito pela Edge Function `send-wa-notification`
-- (service role), que confere org, permissão e que o número é UAZAPI ativo.
-- Primeiro uso: Contas a pagar/receber → botão WhatsApp (imagem do resumo + texto).
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE TABLE IF NOT EXISTS whatsapp_hub.wa_notify_settings (
  org_id      uuid PRIMARY KEY DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES whatsapp_hub.channels(id) ON DELETE SET NULL,
  updated_by  uuid DEFAULT auth.uid(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.wa_notify_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL DEFAULT whatsapp_hub.current_org_id() REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- Pessoa: só dígitos com DDI (5568999990000). Grupo: JID terminado em @g.us.
  phone       text NOT NULL CHECK (phone ~ '^[0-9]{10,15}$' OR phone ~ '^[0-9-]{10,40}@g\.us$'),
  is_group    boolean GENERATED ALWAYS AS (phone LIKE '%@g.us') STORED,
  -- Assuntos que a pessoa/grupo recebe por padrão (pré-marcados no envio).
  topics      text[] NOT NULL DEFAULT ARRAY['financeiro']::text[],
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone)
);
CREATE INDEX IF NOT EXISTS wa_notify_recipients_org ON whatsapp_hub.wa_notify_recipients (org_id) WHERE is_active;

ALTER TABLE whatsapp_hub.wa_notify_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.wa_notify_recipients ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro ativo da org (a tela de envio lista os destinatários).
DROP POLICY IF EXISTS wa_notify_settings_select ON whatsapp_hub.wa_notify_settings;
CREATE POLICY wa_notify_settings_select ON whatsapp_hub.wa_notify_settings FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id));
DROP POLICY IF EXISTS wa_notify_recipients_select ON whatsapp_hub.wa_notify_recipients;
CREATE POLICY wa_notify_recipients_select ON whatsapp_hub.wa_notify_recipients FOR SELECT TO authenticated
  USING (whatsapp_hub.in_org(org_id));

-- Confere o número sem depender da RLS de channels (que esconde o token).
CREATE OR REPLACE FUNCTION whatsapp_hub._wa_notify_channel_ok(p_channel uuid, p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM whatsapp_hub.channels c WHERE c.id = p_channel AND c.org_id = p_org AND c.provider = 'uazapi');
$$;
REVOKE ALL ON FUNCTION whatsapp_hub._wa_notify_channel_ok(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_hub._wa_notify_channel_ok(uuid, uuid) TO authenticated, service_role;

-- Escrita: só quem gerencia os números (settings.channels). O número escolhido
-- tem de ser UAZAPI e da mesma org.
DROP POLICY IF EXISTS wa_notify_settings_write ON whatsapp_hub.wa_notify_settings;
CREATE POLICY wa_notify_settings_write ON whatsapp_hub.wa_notify_settings FOR ALL TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('settings.channels'))
  WITH CHECK (
    whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('settings.channels')
    AND (channel_id IS NULL OR whatsapp_hub._wa_notify_channel_ok(channel_id, org_id))
  );
DROP POLICY IF EXISTS wa_notify_recipients_write ON whatsapp_hub.wa_notify_recipients;
CREATE POLICY wa_notify_recipients_write ON whatsapp_hub.wa_notify_recipients FOR ALL TO authenticated
  USING (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('settings.channels'))
  WITH CHECK (whatsapp_hub.in_org(org_id) AND whatsapp_hub.has_perm('settings.channels'));

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.wa_notify_settings, whatsapp_hub.wa_notify_recipients TO authenticated;
GRANT ALL ON whatsapp_hub.wa_notify_settings, whatsapp_hub.wa_notify_recipients TO service_role;

-- org_id não muda depois de criado.
CREATE OR REPLACE FUNCTION whatsapp_hub._wa_notify_keep_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = whatsapp_hub, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN RAISE EXCEPTION 'Não é possível trocar a organização.'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wa_notify_settings_keep_org ON whatsapp_hub.wa_notify_settings;
CREATE TRIGGER wa_notify_settings_keep_org BEFORE UPDATE ON whatsapp_hub.wa_notify_settings FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._wa_notify_keep_org();
DROP TRIGGER IF EXISTS wa_notify_recipients_keep_org ON whatsapp_hub.wa_notify_recipients;
CREATE TRIGGER wa_notify_recipients_keep_org BEFORE UPDATE ON whatsapp_hub.wa_notify_recipients FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._wa_notify_keep_org();

NOTIFY pgrst, 'reload schema';
