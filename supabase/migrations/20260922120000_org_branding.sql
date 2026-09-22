-- ============================================================================
-- Identidade visual por organização: logo + tema (dark/light)
-- ----------------------------------------------------------------------------
-- `organizations.logo_url`/`theme_mode` e o bucket `org-branding` (usados por
-- src/hooks/useOrgBranding.ts e Settings → Identidade Visual) foram criados
-- fora do histórico de migrations deste repo — mesma situação de
-- automation_flows (20260921180000). Esta migration é idempotente: cria o
-- que faltar sem tocar em dados existentes.
--
-- Mudança de identidade visual (pedido do Gabriel): o CRM deixa de ser
-- "dark mode only" — a organização escolhe o tema em Configurações, e o
-- DEFAULT agora é 'light' (a nova identidade clara/teal, ver globals.css).
-- Org já existente sem tema explícito (NULL, de antes dessa coluna existir)
-- também vai pra 'light'.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.organizations
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE whatsapp_hub.organizations
  ADD COLUMN IF NOT EXISTS theme_mode TEXT;

UPDATE whatsapp_hub.organizations
   SET theme_mode = 'light'
 WHERE theme_mode IS NULL;

ALTER TABLE whatsapp_hub.organizations
  ALTER COLUMN theme_mode SET DEFAULT 'light';
ALTER TABLE whatsapp_hub.organizations
  ALTER COLUMN theme_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_theme_mode_check'
       AND conrelid = 'whatsapp_hub.organizations'::regclass
  ) THEN
    ALTER TABLE whatsapp_hub.organizations
      ADD CONSTRAINT organizations_theme_mode_check
      CHECK (theme_mode IN ('dark', 'light'));
  END IF;
END $$;

-- Bucket público de logo por org: path <org_id>/logo.<ext>.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'org-branding', 'org-branding', true, 2 * 1024 * 1024,
  ARRAY['image/png', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS wh_org_branding_read        ON storage.objects;
DROP POLICY IF EXISTS wh_org_branding_admin_write  ON storage.objects;

CREATE POLICY wh_org_branding_read
  ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'org-branding');

-- Só admin da própria org escreve, e só no path da própria org.
CREATE POLICY wh_org_branding_admin_write
  ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'org-branding'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'org-branding'
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.current_user_role() = 'admin'
  );
