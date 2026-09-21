-- ============================================================================
-- Chat Interno — conversa entre membros da org (DM 1:1 + grupos)
-- ----------------------------------------------------------------------------
-- Canal de comunicação da EQUIPE, separado do Inbox (que fala com o lead).
-- Nada aqui trafega para WhatsApp/Instagram — é 100% interno.
--
-- Três tabelas: `chat_channels` (a sala), `chat_members` (quem participa +
-- marcador de leitura) e `chat_messages` (as mensagens).
--
-- DECISÃO DE RLS — por que quase tudo passa por RPC SECURITY DEFINER:
-- a visibilidade aqui é por PERTENCIMENTO ("vejo o que acontece nas salas em
-- que estou"), e não apenas por org como no resto do schema. Uma policy em
-- `chat_messages` que consulta `chat_members`, cuja própria policy consulta
-- `chat_members` de novo, entra em recursão infinita de RLS (footgun clássico
-- do Postgres). Por isso o teste de pertencimento vive em
-- `whatsapp_hub.is_chat_member()`, SECURITY DEFINER, que enxerga a tabela sem
-- RLS e corta o ciclo. Pelo mesmo motivo criar sala / renomear / entrar / sair
-- são RPCs: dão para blindar invariantes (dm_key canônico, criador sempre
-- membro, ninguém se auto-adicionando a uma sala alheia) que uma policy
-- `WITH CHECK` sozinha não consegue expressar.
-- ============================================================================

SET search_path TO whatsapp_hub, public;

-- ----------------------------------------------------------------------------
-- Tabelas
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_hub.chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  kind text NOT NULL DEFAULT 'group' CHECK (kind IN ('dm', 'group')),
  -- NULL em DM (o título é o nome do outro lado, resolvido na leitura).
  name text,
  -- Chave canônica do par em DM: "<menor uuid>:<maior uuid>". Garante que
  -- abrir a conversa dos dois lados caia SEMPRE na mesma sala. NULL em grupo
  -- (UNIQUE ignora NULLs, então grupos não competem por essa chave).
  dm_key text,
  created_by uuid,
  -- Ordena a lista de conversas sem varrer chat_messages a cada render.
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dm_key)
);
CREATE INDEX IF NOT EXISTS chat_channels_org_idx
  ON whatsapp_hub.chat_channels (org_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_hub.chat_members (
  chat_id uuid NOT NULL REFERENCES whatsapp_hub.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  org_id uuid NOT NULL DEFAULT whatsapp_hub.current_org_id(),
  -- Tudo que chegou depois disso conta como não lido. NULL = nunca abriu.
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user_idx ON whatsapp_hub.chat_members (user_id);

CREATE TABLE IF NOT EXISTS whatsapp_hub.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) DEFAULT whatsapp_hub.current_org_id(),
  chat_id uuid NOT NULL REFERENCES whatsapp_hub.chat_channels(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  -- 'system' = evento da sala (renomeou, entrou, saiu), escrito pelas RPCs.
  content_type text NOT NULL DEFAULT 'text'
    CHECK (content_type IN ('text', 'image', 'file', 'system')),
  content text,
  -- Path DENTRO do bucket privado whatsapp-hub-chat (não é URL pública):
  -- <org_id>/<chat_id>/<uuid>.<ext>. O frontend assina na hora de exibir.
  media_path text,
  media_name text,
  media_size bigint,
  -- Menções @membro: dispara notificação para quem está aqui (trigger abaixo).
  mentions uuid[],
  -- "Encaminhar conversa do Inbox": aponta para whatsapp_hub.conversations.
  -- ON DELETE SET NULL — apagar o lead não pode apagar a discussão da equipe.
  ref_conversation_id uuid REFERENCES whatsapp_hub.conversations(id) ON DELETE SET NULL,
  edited_at timestamptz,
  -- Soft delete: o balão vira "Mensagem apagada" em vez de sumir do histórico.
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_chat_idx
  ON whatsapp_hub.chat_messages (chat_id, created_at DESC);

-- Deep link da notificação de menção. As colunas conversation_id/message_id
-- existentes são FK para as tabelas do WhatsApp e não servem aqui.
ALTER TABLE whatsapp_hub.notifications
  ADD COLUMN IF NOT EXISTS chat_id uuid REFERENCES whatsapp_hub.chat_channels(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS chat_message_id uuid REFERENCES whatsapp_hub.chat_messages(id) ON DELETE CASCADE;

-- org_id herdado do canal quando o insert vem da service role (sem JWT).
DROP TRIGGER IF EXISTS trg_org_from_parent ON whatsapp_hub.chat_messages;
CREATE TRIGGER trg_org_from_parent
  BEFORE INSERT ON whatsapp_hub.chat_messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_parent('chat_channels', 'chat_id');

DROP TRIGGER IF EXISTS trg_org_from_parent ON whatsapp_hub.chat_members;
CREATE TRIGGER trg_org_from_parent
  BEFORE INSERT ON whatsapp_hub.chat_members
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._org_from_parent('chat_channels', 'chat_id');

-- ----------------------------------------------------------------------------
-- Pertencimento (quebra a recursão de RLS — ver cabeçalho)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub.is_chat_member(p_chat uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM whatsapp_hub.chat_members m
     WHERE m.chat_id = p_chat
       AND m.user_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.is_chat_member(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION whatsapp_hub.is_chat_member(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

ALTER TABLE whatsapp_hub.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.chat_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_hub.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_channels_select        ON whatsapp_hub.chat_channels;
DROP POLICY IF EXISTS chat_channels_owner_delete  ON whatsapp_hub.chat_channels;
DROP POLICY IF EXISTS chat_members_select         ON whatsapp_hub.chat_members;
DROP POLICY IF EXISTS chat_messages_select        ON whatsapp_hub.chat_messages;
DROP POLICY IF EXISTS chat_messages_insert        ON whatsapp_hub.chat_messages;
DROP POLICY IF EXISTS chat_messages_author_update ON whatsapp_hub.chat_messages;

-- Salas: só as minhas. Criar/renomear/entrar/sair passa pelas RPCs — por isso
-- não existe policy de INSERT/UPDATE aqui.
CREATE POLICY chat_channels_select ON whatsapp_hub.chat_channels
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.is_chat_member(id));

-- Apagar grupo: só quem criou. DM não se apaga (o par sempre existe).
CREATE POLICY chat_channels_owner_delete ON whatsapp_hub.chat_channels
  FOR DELETE TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND kind = 'group' AND created_by = auth.uid());

-- Membros: enxergo a lista das salas em que estou (para montar o cabeçalho do
-- grupo e o seletor de menções). Escrita é toda via RPC.
CREATE POLICY chat_members_select ON whatsapp_hub.chat_members
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.is_chat_member(chat_id));

CREATE POLICY chat_messages_select ON whatsapp_hub.chat_messages
  FOR SELECT TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND whatsapp_hub.is_chat_member(chat_id));

-- Só membro escreve, e só em nome de si mesmo. 'system' é reservado às RPCs.
CREATE POLICY chat_messages_insert ON whatsapp_hub.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND whatsapp_hub.is_chat_member(chat_id)
              AND sender_id = auth.uid()
              AND content_type <> 'system');

-- Editar / apagar: só o autor, e só o que o guard abaixo deixa passar.
CREATE POLICY chat_messages_author_update ON whatsapp_hub.chat_messages
  FOR UPDATE TO authenticated
  USING (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
         AND sender_id = auth.uid() AND content_type <> 'system')
  WITH CHECK (org_id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()
              AND sender_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Guard de UPDATE: o cliente só controla `content` e `deleted_at`
-- ----------------------------------------------------------------------------
-- Sem isso, a policy de UPDATE (que só sabe olhar sender_id) deixaria o autor
-- mover a própria mensagem para outra sala trocando chat_id, ou forjar
-- edited_at. Mesmo espírito do _app_users_guard.

CREATE OR REPLACE FUNCTION whatsapp_hub._chat_messages_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service role (sem JWT de usuário) passa direto.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  NEW.id                 := OLD.id;
  NEW.org_id             := OLD.org_id;
  NEW.chat_id            := OLD.chat_id;
  NEW.sender_id          := OLD.sender_id;
  NEW.content_type       := OLD.content_type;
  NEW.media_name         := OLD.media_name;
  NEW.media_size         := OLD.media_size;
  NEW.ref_conversation_id := OLD.ref_conversation_id;
  NEW.created_at         := OLD.created_at;

  -- Apagar é irreversível e leva junto conteúdo, anexo e menções.
  IF OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_at := OLD.deleted_at;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.content    := NULL;
    NEW.media_path := NULL;
    NEW.mentions   := NULL;
    RETURN NEW;
  END IF;

  NEW.media_path := OLD.media_path;
  -- edited_at é carimbado pelo banco, nunca pelo cliente.
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_guard ON whatsapp_hub.chat_messages;
CREATE TRIGGER chat_messages_guard
  BEFORE UPDATE ON whatsapp_hub.chat_messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._chat_messages_guard();

-- ----------------------------------------------------------------------------
-- Triggers de INSERT: ordenação da lista + notificação de menção
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION whatsapp_hub._chat_bump_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  UPDATE whatsapp_hub.chat_channels
     SET last_message_at = NEW.created_at
   WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_bump_last_message ON whatsapp_hub.chat_messages;
CREATE TRIGGER chat_bump_last_message
  AFTER INSERT ON whatsapp_hub.chat_messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._chat_bump_last_message();

-- Menção @membro → linha em notifications. Precisa ser SECURITY DEFINER: a
-- policy notifications_self tem WITH CHECK (user_id = auth.uid()), ou seja um
-- cliente NUNCA consegue criar notificação para outra pessoa.
CREATE OR REPLACE FUNCTION whatsapp_hub._chat_notify_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, public, pg_temp
AS $$
DECLARE
  sender_label text;
  chat_label   text;
BEGIN
  IF NEW.mentions IS NULL OR array_length(NEW.mentions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(au.display_name, ''), 'Alguém')
    INTO sender_label
    FROM whatsapp_hub.app_users au
   WHERE au.user_id = NEW.sender_id;

  SELECT CASE WHEN c.kind = 'group'
              THEN ' em ' || COALESCE(NULLIF(c.name, ''), 'um grupo')
              ELSE '' END
    INTO chat_label
    FROM whatsapp_hub.chat_channels c
   WHERE c.id = NEW.chat_id;

  INSERT INTO whatsapp_hub.notifications (
    org_id, user_id, type, chat_id, chat_message_id, title, body
  )
  SELECT NEW.org_id,
         m.user_id,
         'mention'::whatsapp_hub.notification_type,
         NEW.chat_id,
         NEW.id,
         COALESCE(sender_label, 'Alguém') || ' mencionou você' || COALESCE(chat_label, ''),
         LEFT(COALESCE(NEW.content, ''), 140)
    FROM whatsapp_hub.chat_members m
   WHERE m.chat_id = NEW.chat_id
     AND m.user_id <> NEW.sender_id
     AND m.user_id = ANY (NEW.mentions);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_notify_mentions ON whatsapp_hub.chat_messages;
CREATE TRIGGER chat_notify_mentions
  AFTER INSERT ON whatsapp_hub.chat_messages
  FOR EACH ROW EXECUTE FUNCTION whatsapp_hub._chat_notify_mentions();

-- ----------------------------------------------------------------------------
-- RPCs
-- ----------------------------------------------------------------------------

-- Abre (ou reaproveita) a DM com outro membro da org. Idempotente dos dois
-- lados graças ao dm_key canônico.
CREATE OR REPLACE FUNCTION whatsapp_hub.chat_open_dm(p_other uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_me  uuid := auth.uid();
  v_org uuid := whatsapp_hub.current_org_id();
  v_key text;
  v_id  uuid;
BEGIN
  IF v_me IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'sessão inválida';
  END IF;
  IF NOT whatsapp_hub.current_org_active() THEN
    RAISE EXCEPTION 'organização inativa';
  END IF;
  IF p_other IS NULL OR p_other = v_me THEN
    RAISE EXCEPTION 'destinatário inválido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM whatsapp_hub.app_users
     WHERE user_id = p_other AND org_id = v_org
  ) THEN
    RAISE EXCEPTION 'membro não encontrado nesta organização';
  END IF;

  v_key := LEAST(v_me::text, p_other::text) || ':' || GREATEST(v_me::text, p_other::text);

  SELECT id INTO v_id
    FROM whatsapp_hub.chat_channels
   WHERE org_id = v_org AND dm_key = v_key;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO whatsapp_hub.chat_channels (org_id, kind, dm_key, created_by)
  VALUES (v_org, 'dm', v_key, v_me)
  ON CONFLICT (org_id, dm_key) DO NOTHING
  RETURNING id INTO v_id;

  -- Corrida: o outro lado abriu a mesma DM no mesmo instante.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
      FROM whatsapp_hub.chat_channels
     WHERE org_id = v_org AND dm_key = v_key;
    RETURN v_id;
  END IF;

  INSERT INTO whatsapp_hub.chat_members (chat_id, user_id, org_id)
  VALUES (v_id, v_me, v_org), (v_id, p_other, v_org)
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$;

-- Cria um grupo. O criador entra automaticamente (senão a sala nasceria
-- invisível para ele — a policy de SELECT exige pertencimento).
CREATE OR REPLACE FUNCTION whatsapp_hub.chat_create_group(p_name text, p_members uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_org  uuid := whatsapp_hub.current_org_id();
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_id   uuid;
BEGIN
  IF v_me IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'sessão inválida';
  END IF;
  IF NOT whatsapp_hub.current_org_active() THEN
    RAISE EXCEPTION 'organização inativa';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'o grupo precisa de um nome';
  END IF;

  INSERT INTO whatsapp_hub.chat_channels (org_id, kind, name, created_by)
  VALUES (v_org, 'group', v_name, v_me)
  RETURNING id INTO v_id;

  INSERT INTO whatsapp_hub.chat_members (chat_id, user_id, org_id)
  VALUES (v_id, v_me, v_org)
  ON CONFLICT DO NOTHING;

  -- Só entram membros ativos da MESMA org; ids inválidos são ignorados em
  -- silêncio em vez de derrubar a criação inteira.
  INSERT INTO whatsapp_hub.chat_members (chat_id, user_id, org_id)
  SELECT v_id, au.user_id, v_org
    FROM whatsapp_hub.app_users au
   WHERE au.org_id = v_org
     AND au.user_id = ANY (COALESCE(p_members, ARRAY[]::uuid[]))
     AND au.user_id <> v_me
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$;

-- Adiciona membros a um grupo existente. Qualquer membro pode convidar.
CREATE OR REPLACE FUNCTION whatsapp_hub.chat_add_members(p_chat uuid, p_members uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_me    uuid := auth.uid();
  v_org   uuid := whatsapp_hub.current_org_id();
  v_kind  text;
  v_added text;
BEGIN
  IF NOT whatsapp_hub.is_chat_member(p_chat) THEN
    RAISE EXCEPTION 'você não participa desta conversa';
  END IF;

  SELECT kind INTO v_kind
    FROM whatsapp_hub.chat_channels
   WHERE id = p_chat AND org_id = v_org;
  IF v_kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'só é possível adicionar membros em grupos';
  END IF;

  WITH novos AS (
    INSERT INTO whatsapp_hub.chat_members (chat_id, user_id, org_id)
    SELECT p_chat, au.user_id, v_org
      FROM whatsapp_hub.app_users au
     WHERE au.org_id = v_org
       AND au.user_id = ANY (COALESCE(p_members, ARRAY[]::uuid[]))
    ON CONFLICT DO NOTHING
    RETURNING user_id
  )
  SELECT string_agg(COALESCE(NULLIF(au.display_name, ''), 'um membro'), ', ')
    INTO v_added
    FROM novos
    JOIN whatsapp_hub.app_users au ON au.user_id = novos.user_id;

  IF v_added IS NOT NULL THEN
    PERFORM whatsapp_hub._chat_system_message(p_chat, v_me, 'adicionou ' || v_added || ' ao grupo');
  END IF;
END;
$$;

-- Sai do grupo (p_user = self) ou remove alguém (só o criador do grupo).
CREATE OR REPLACE FUNCTION whatsapp_hub.chat_remove_member(p_chat uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_me      uuid := auth.uid();
  v_org     uuid := whatsapp_hub.current_org_id();
  v_kind    text;
  v_creator uuid;
  v_label   text;
BEGIN
  IF NOT whatsapp_hub.is_chat_member(p_chat) THEN
    RAISE EXCEPTION 'você não participa desta conversa';
  END IF;

  SELECT kind, created_by INTO v_kind, v_creator
    FROM whatsapp_hub.chat_channels
   WHERE id = p_chat AND org_id = v_org;
  IF v_kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'não é possível sair de uma conversa direta';
  END IF;
  IF p_user <> v_me AND v_creator IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'só quem criou o grupo pode remover outros membros';
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), 'um membro') INTO v_label
    FROM whatsapp_hub.app_users WHERE user_id = p_user;

  DELETE FROM whatsapp_hub.chat_members
   WHERE chat_id = p_chat AND user_id = p_user;

  PERFORM whatsapp_hub._chat_system_message(
    p_chat, v_me,
    CASE WHEN p_user = v_me THEN 'saiu do grupo'
         ELSE 'removeu ' || COALESCE(v_label, 'um membro') || ' do grupo' END);
END;
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub.chat_rename(p_chat uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_org  uuid := whatsapp_hub.current_org_id();
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_kind text;
BEGIN
  IF NOT whatsapp_hub.is_chat_member(p_chat) THEN
    RAISE EXCEPTION 'você não participa desta conversa';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'o grupo precisa de um nome';
  END IF;

  SELECT kind INTO v_kind
    FROM whatsapp_hub.chat_channels
   WHERE id = p_chat AND org_id = v_org;
  IF v_kind IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'só grupos podem ser renomeados';
  END IF;

  UPDATE whatsapp_hub.chat_channels
     SET name = v_name
   WHERE id = p_chat AND org_id = v_org;

  PERFORM whatsapp_hub._chat_system_message(p_chat, v_me, 'renomeou o grupo para "' || v_name || '"');
END;
$$;

-- Marca a sala como lida até agora. É RPC (e não policy de UPDATE em
-- chat_members) porque um UPDATE livre na própria linha permitiria trocar o
-- chat_id e, com isso, se enfiar numa sala alheia.
CREATE OR REPLACE FUNCTION whatsapp_hub.chat_mark_read(p_chat uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
BEGIN
  IF NOT whatsapp_hub.is_chat_member(p_chat) THEN
    RETURN;
  END IF;
  UPDATE whatsapp_hub.chat_members
     SET last_read_at = now()
   WHERE chat_id = p_chat AND user_id = auth.uid();
END;
$$;

-- Mensagem de evento da sala. Interna: só as RPCs acima chamam.
CREATE OR REPLACE FUNCTION whatsapp_hub._chat_system_message(p_chat uuid, p_actor uuid, p_text text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_actor text;
  v_org   uuid;
BEGIN
  SELECT org_id INTO v_org FROM whatsapp_hub.chat_channels WHERE id = p_chat;
  SELECT COALESCE(NULLIF(display_name, ''), 'Alguém') INTO v_actor
    FROM whatsapp_hub.app_users WHERE user_id = p_actor;

  INSERT INTO whatsapp_hub.chat_messages (org_id, chat_id, sender_id, content_type, content)
  VALUES (v_org, p_chat, p_actor, 'system', COALESCE(v_actor, 'Alguém') || ' ' || p_text);
END;
$$;

-- Lista as conversas do usuário já com tudo que a sidebar precisa: título do
-- outro lado (DM), prévia da última mensagem e contador de não lidas. Uma
-- chamada em vez de N+1 queries por sala.
DROP FUNCTION IF EXISTS whatsapp_hub.chat_list();
CREATE FUNCTION whatsapp_hub.chat_list()
RETURNS TABLE (
  chat_id                uuid,
  kind                   text,
  name                   text,
  created_by             uuid,
  last_message_at        timestamptz,
  member_count           int,
  peer_user_id           uuid,
  peer_display_name      text,
  peer_email             text,
  peer_avatar_url        text,
  last_message_preview   text,
  last_message_sender_id uuid,
  unread_count           int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = whatsapp_hub, auth, public, pg_temp
AS $$
  WITH mine AS (
    SELECT c.id, c.kind, c.name, c.created_by, c.last_message_at, m.last_read_at
      FROM whatsapp_hub.chat_channels c
      JOIN whatsapp_hub.chat_members m ON m.chat_id = c.id
     WHERE m.user_id = auth.uid()
       AND c.org_id = whatsapp_hub.current_org_id()
  )
  SELECT
    mine.id,
    mine.kind,
    mine.name,
    mine.created_by,
    mine.last_message_at,
    (SELECT count(*)::int FROM whatsapp_hub.chat_members cm WHERE cm.chat_id = mine.id),
    peer.user_id,
    peer.display_name,
    peer.email,
    peer.avatar_url,
    last_msg.preview,
    last_msg.sender_id,
    (SELECT count(*)::int
       FROM whatsapp_hub.chat_messages x
      WHERE x.chat_id = mine.id
        AND x.deleted_at IS NULL
        AND x.content_type <> 'system'
        AND x.sender_id <> auth.uid()
        AND x.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz))
  FROM mine
  LEFT JOIN LATERAL (
    SELECT au.user_id, au.display_name, u.email::text AS email, au.avatar_url
      FROM whatsapp_hub.chat_members cm
      JOIN whatsapp_hub.app_users au ON au.user_id = cm.user_id
      JOIN auth.users u ON u.id = cm.user_id
     WHERE cm.chat_id = mine.id
       AND cm.user_id <> auth.uid()
     LIMIT 1
  ) peer ON mine.kind = 'dm'
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN x.deleted_at IS NOT NULL   THEN 'Mensagem apagada'
             WHEN x.content_type = 'image'   THEN 'Imagem'
             WHEN x.content_type = 'file'    THEN COALESCE(x.media_name, 'Arquivo')
             ELSE LEFT(COALESCE(x.content, ''), 120)
           END AS preview,
           x.sender_id
      FROM whatsapp_hub.chat_messages x
     WHERE x.chat_id = mine.id
     ORDER BY x.created_at DESC
     LIMIT 1
  ) last_msg ON true
  ORDER BY mine.last_message_at DESC NULLS LAST;
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_open_dm(uuid)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_create_group(text, uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_add_members(uuid, uuid[])  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_remove_member(uuid, uuid)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_rename(uuid, text)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_mark_read(uuid)            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.chat_list()                     FROM PUBLIC, anon;
-- _chat_system_message é helper interno: ninguém chama de fora.
REVOKE EXECUTE ON FUNCTION whatsapp_hub._chat_system_message(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_open_dm(uuid)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_create_group(text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_add_members(uuid, uuid[])  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_remove_member(uuid, uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_rename(uuid, text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_mark_read(uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION whatsapp_hub.chat_list()                     TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- Sem isso a subscription do frontend conecta e nunca recebe nada.

ALTER TABLE whatsapp_hub.chat_messages REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_hub.chat_channels REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.chat_messages;
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_hub.chat_channels;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- Bucket de anexos: whatsapp-hub-chat
-- ----------------------------------------------------------------------------
-- PRIVADO, ao contrário dos buckets de avatar/logo. Conversa interna da equipe
-- é exatamente onde um link público permanente não serve: o frontend assina a
-- URL na hora de exibir (createSignedUrls).
-- Path OBRIGATÓRIO pelas policies: <org_id>/<chat_id>/<uuid>.<ext>

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-hub-chat', 'whatsapp-hub-chat', false, 25 * 1024 * 1024)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS wh_chat_read   ON storage.objects;
DROP POLICY IF EXISTS wh_chat_insert ON storage.objects;
DROP POLICY IF EXISTS wh_chat_delete ON storage.objects;

-- Leitura/escrita gated pelo MESMO pertencimento das mensagens: a segunda
-- pasta do path é o chat_id, então is_chat_member() decide.
CREATE POLICY wh_chat_read
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-chat'
    AND whatsapp_hub.current_org_active()
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.is_chat_member(((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY wh_chat_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-hub-chat'
    AND whatsapp_hub.current_org_active()
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND whatsapp_hub.is_chat_member(((storage.foldername(name))[2])::uuid)
  );

CREATE POLICY wh_chat_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'whatsapp-hub-chat'
    AND whatsapp_hub.current_org_active()
    AND (storage.foldername(name))[1] = whatsapp_hub.current_org_id()::text
    AND owner = auth.uid()
  );
