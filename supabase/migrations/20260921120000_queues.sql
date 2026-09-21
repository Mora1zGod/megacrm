-- Filas / Setores (departamentos de atendimento).
-- ----------------------------------------------------------------------------
-- O frontend inteiro dessa feature já existia (TeamSettings → seção "Filas",
-- useQueues, filtro de fila no Inbox em inbox-filters.ts, queue_id no tipo
-- Conversation) mas a migração nunca foi escrita — toda tela que tocava em
-- `queues`/`queue_members` falhava silenciosamente contra uma tabela
-- inexistente. Esta migração só fecha essa lacuna, sem mudar nenhum
-- comportamento de UI já implementado.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

CREATE TABLE IF NOT EXISTS whatsapp_hub.queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  name text NOT NULL,
  description text,
  color text,
  is_default boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS whatsapp_hub.queue_members (
  queue_id uuid NOT NULL REFERENCES whatsapp_hub.queues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  org_id uuid NOT NULL DEFAULT whatsapp_hub.current_org_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, user_id)
);
CREATE INDEX IF NOT EXISTS queue_members_user_idx ON whatsapp_hub.queue_members (user_id);

-- Conversa nova herda a fila do canal por onde chegou (mesmo padrão de
-- assigned_to herdado de channels.assigned_member em zernio-webhook /
-- uazapi-webhook); troca manual depois fica por conta do operador no Inbox.
ALTER TABLE whatsapp_hub.channels
  ADD COLUMN IF NOT EXISTS queue_id uuid REFERENCES whatsapp_hub.queues(id) ON DELETE SET NULL;

ALTER TABLE whatsapp_hub.conversations
  ADD COLUMN IF NOT EXISTS queue_id uuid REFERENCES whatsapp_hub.queues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_queue_idx ON whatsapp_hub.conversations (org_id, queue_id);

-- RLS: mesmo predicado padrão do resto do schema. Leitura aberta a qualquer
-- membro autenticado da org (o Inbox/TeamSettings precisam listar fila e
-- membership mesmo pra operador, que só não pode editar); escrita admin-only
-- — no frontend, toggleMembro/mudarCanalFila/FilaDialog já desabilitam esses
-- controles pra quem não é admin, então a policy só formaliza o que a UI
-- já impõe.
ALTER TABLE whatsapp_hub.queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.queue_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY queues_select ON whatsapp_hub.queues
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
CREATE POLICY queues_admin_write ON whatsapp_hub.queues
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() = 'admin');

CREATE POLICY queue_members_select ON whatsapp_hub.queue_members
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active());
CREATE POLICY queue_members_admin_write ON whatsapp_hub.queue_members
  FOR ALL TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.current_user_role() = 'admin')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.current_user_role() = 'admin');
