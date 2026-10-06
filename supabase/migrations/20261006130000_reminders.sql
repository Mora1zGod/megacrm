-- ============================================================================
-- Lembretes (topo do CRM + Agenda) — 06/10/2026
-- ----------------------------------------------------------------------------
-- Nota rápida com cor e data opcional. Por padrão é PESSOAL (só quem criou
-- vê); "Compartilhar com a equipe" deixa toda a org ver. Só o autor edita ou
-- apaga. Com data, aparece também na Agenda.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  notes text,
  color text NOT NULL DEFAULT 'green' CHECK (color IN ('green', 'blue', 'purple', 'orange', 'red', 'gray')),
  due_at timestamptz,
  shared boolean NOT NULL DEFAULT false,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_org_due_idx ON whatsapp_hub.reminders (org_id, due_at);
CREATE INDEX IF NOT EXISTS reminders_owner_idx ON whatsapp_hub.reminders (created_by);

ALTER TABLE whatsapp_hub.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminders_select ON whatsapp_hub.reminders;
CREATE POLICY reminders_select ON whatsapp_hub.reminders
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND (created_by = auth.uid() OR shared));

DROP POLICY IF EXISTS reminders_insert ON whatsapp_hub.reminders;
CREATE POLICY reminders_insert ON whatsapp_hub.reminders
  FOR INSERT TO authenticated
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND created_by = auth.uid()
              AND whatsapp_hub.current_user_role() IN ('admin', 'operator'));

DROP POLICY IF EXISTS reminders_update ON whatsapp_hub.reminders;
CREATE POLICY reminders_update ON whatsapp_hub.reminders
  FOR UPDATE TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() AND created_by = auth.uid())
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND created_by = auth.uid());

DROP POLICY IF EXISTS reminders_delete ON whatsapp_hub.reminders;
CREATE POLICY reminders_delete ON whatsapp_hub.reminders
  FOR DELETE TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() AND created_by = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.reminders TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.reminders;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
