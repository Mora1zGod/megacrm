-- ============================================================================
-- Jarvis · núcleo do agente pessoal (schema whatsapp_hub)
-- ----------------------------------------------------------------------------
-- Cria APENAS estruturas novas. Nada existente é alterado, removido ou
-- renomeado — o fluxo AMAIA (ai_agent_config, conversations, messages,
-- triggers on_inbound_message / on_audio_inbound) fica intacto.
--
--   1. whatsapp_hub.jarvis_config  — config do agente POR ORG (singleton).
--   2. whatsapp_hub.jarvis_users   — números autorizados (o roteamento lê daqui;
--                                    NADA de número hardcoded no código).
--   3. whatsapp_hub.jarvis_messages— histórico do agente (as mensagens do Gabriel
--                                    não entram em whatsapp_hub.messages, porque
--                                    o roteamento desvia antes do fluxo de lead).
--   4. whatsapp_hub.ai_usage_log   — garantia idempotente de existência + das
--                                    colunas que o Jarvis escreve. Ver nota abaixo.
--
-- RLS: ligada nas três tabelas novas, com o mesmo predicado do resto do schema
-- (20260810120002_mt_policies):
--     org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
-- Escrita só para role 'admin'. As Edge Functions usam service_role (bypassa RLS).
--
-- NOTA sobre ai_usage_log: a tabela é LIDA pelo front (src/hooks/useAmaiaOverview.ts
-- e src/hooks/useSalesDashboard.ts) mas NÃO é criada por nenhuma migration deste
-- repositório nem escrita por nenhuma Edge Function. Ou ela foi criada fora do
-- controle de migrations no projeto hneqnopjvvwquyqogwdu, ou ainda não existe.
-- Por isso tudo aqui é IF NOT EXISTS / ADD COLUMN IF NOT EXISTS: se já existir,
-- esta migration só garante as colunas que o Jarvis usa e não toca no resto.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- 1. jarvis_config — um registro por organização
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.jarvis_config (
  org_id              UUID PRIMARY KEY REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  -- Modelo OpenAI usado no tool calling. Mesma credencial do AMAIA
  -- (public.org_settings → openai_api_key / llm_api_key). Nenhuma chave nova.
  model               TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
  -- Persona. NULL = usa o default embutido na Edge Function.
  system_prompt       TEXT,
  -- Fuso para "hoje", "ontem", "esta semana". Acre = America/Rio_Branco.
  timezone            TEXT NOT NULL DEFAULT 'America/Rio_Branco',
  -- Teto de rodadas de tool calling por mensagem (trava de custo/loop).
  max_tool_rounds     SMALLINT NOT NULL DEFAULT 4 CHECK (max_tool_rounds BETWEEN 1 AND 10),
  -- Quantos turnos anteriores entram no contexto.
  history_limit       SMALLINT NOT NULL DEFAULT 12 CHECK (history_limit BETWEEN 0 AND 50),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_jarvis_config_updated_at ON whatsapp_hub.jarvis_config;
CREATE TRIGGER trg_jarvis_config_updated_at
  BEFORE UPDATE ON whatsapp_hub.jarvis_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. jarvis_users — quem pode falar com o Jarvis
-- ----------------------------------------------------------------------------
-- MVP: 1 linha (o número do Gabriel). A tabela já suporta multi-usuário sem
-- refatoração: é só inserir outra linha.
--
-- phone em E.164 com '+' (mesmo formato que o zernio-webhook normaliza antes
-- de gravar em whatsapp_hub.contacts.phone).

CREATE TABLE IF NOT EXISTS whatsapp_hub.jarvis_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  display_name TEXT,
  -- Desligar o acesso sem apagar o histórico.
  is_active    BOOLEAN NOT NULL DEFAULT true,
  -- Usuário do painel correspondente (opcional, para auditoria).
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jarvis_users_phone_e164 CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT jarvis_users_org_phone_unique UNIQUE (org_id, phone)
);

-- O roteamento do webhook consulta por (phone, is_active) a cada inbound:
-- índice parcial para essa leitura ser barata.
CREATE INDEX IF NOT EXISTS idx_jarvis_users_active_phone
  ON whatsapp_hub.jarvis_users(phone)
  WHERE is_active;

DROP TRIGGER IF EXISTS trg_jarvis_users_updated_at ON whatsapp_hub.jarvis_users;
CREATE TRIGGER trg_jarvis_users_updated_at
  BEFORE UPDATE ON whatsapp_hub.jarvis_users
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. jarvis_messages — histórico de conversa do agente
-- ----------------------------------------------------------------------------
-- Por que existe: o roteamento desvia a mensagem do Gabriel ANTES do
-- handleMessageReceived, então ela não vira contact/conversation/message no CRM
-- (correto — ele não é lead). Sem esta tabela o agente seria stateless e não
-- conseguiria responder "e ontem?" depois de "quantas conversas novas hoje?".

CREATE TABLE IF NOT EXISTS whatsapp_hub.jarvis_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  jarvis_user_id  UUID NOT NULL REFERENCES whatsapp_hub.jarvis_users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- Rastro de execução: quais tools rodaram nesta resposta (só no role='assistant').
  tools_used      TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jarvis_messages_user_time
  ON whatsapp_hub.jarvis_messages(jarvis_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. ai_usage_log — existência + colunas que o Jarvis escreve
-- ----------------------------------------------------------------------------
-- Idempotente nos dois cenários (tabela já existe no projeto / não existe).

CREATE TABLE IF NOT EXISTS whatsapp_hub.ai_usage_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  -- NULL no Jarvis: ele não roda dentro de uma conversa do CRM.
  conversation_id    UUID REFERENCES whatsapp_hub.conversations(id) ON DELETE SET NULL,
  -- Origem/tipo do gasto. O front filtra kind='chat' para contar mensagens do
  -- AMAIA; o Jarvis grava 'jarvis' e 'jarvis_transcription', então não
  -- contamina essa contagem.
  kind               TEXT NOT NULL DEFAULT 'chat',
  model              TEXT,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Se a tabela já existia (criada fora das migrations), garante as colunas que o
-- Jarvis escreve. ADD COLUMN IF NOT EXISTS é aditivo — não altera tipo nem
-- apaga dado das colunas já existentes.
ALTER TABLE whatsapp_hub.ai_usage_log
  ADD COLUMN IF NOT EXISTS org_id             UUID,
  ADD COLUMN IF NOT EXISTS conversation_id    UUID,
  ADD COLUMN IF NOT EXISTS kind               TEXT,
  ADD COLUMN IF NOT EXISTS model              TEXT,
  ADD COLUMN IF NOT EXISTS prompt_tokens      INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_kind_time
  ON whatsapp_hub.ai_usage_log(kind, created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. RLS + grants
-- ----------------------------------------------------------------------------
-- Mesmo padrão de 20260810120002_mt_policies: SELECT para membro autenticado da
-- org ativa; escrita só admin. As policies são criadas condicionalmente para a
-- migration poder rodar de novo sem erro.

ALTER TABLE whatsapp_hub.jarvis_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.jarvis_users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.jarvis_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.ai_usage_log    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  -- jarvis_messages é escrita só por Edge Function (service_role): SELECT-only
  -- para o painel, como follow_up_log.
  v_admin_write  TEXT[] := ARRAY['jarvis_config', 'jarvis_users'];
  v_select_only  TEXT[] := ARRAY['jarvis_messages', 'ai_usage_log'];
BEGIN
  FOREACH t IN ARRAY v_admin_write LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'whatsapp_hub' AND tablename = t AND policyname = t || '_select') THEN
      EXECUTE format(
        'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated '
        || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active())',
        t || '_select', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'whatsapp_hub' AND tablename = t AND policyname = t || '_admin_write') THEN
      EXECUTE format(
        'CREATE POLICY %I ON whatsapp_hub.%I FOR ALL TO authenticated '
        || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
        ||        'AND whatsapp_hub.current_user_role() = ''admin'') '
        || 'WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active() '
        ||        'AND whatsapp_hub.current_user_role() = ''admin'')',
        t || '_admin_write', t);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY v_select_only LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'whatsapp_hub' AND tablename = t AND policyname = t || '_select') THEN
      EXECUTE format(
        'CREATE POLICY %I ON whatsapp_hub.%I FOR SELECT TO authenticated '
        || 'USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active())',
        t || '_select', t);
    END IF;
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.jarvis_config   TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.jarvis_users    TO authenticated, service_role;
GRANT SELECT                         ON whatsapp_hub.jarvis_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.jarvis_messages TO service_role;
GRANT SELECT                         ON whatsapp_hub.ai_usage_log    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_hub.ai_usage_log    TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Seed da config (sem número — o número é cadastrado no passo manual)
-- ----------------------------------------------------------------------------
-- Cria a config default para cada org existente. Não cadastra nenhum telefone:
-- enquanto jarvis_users estiver vazia, o roteamento é um no-op e 100% do
-- tráfego continua indo para o fluxo AMAIA de cliente.

INSERT INTO whatsapp_hub.jarvis_config (org_id)
SELECT id FROM whatsapp_hub.organizations
ON CONFLICT (org_id) DO NOTHING;
