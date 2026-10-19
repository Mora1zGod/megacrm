-- ============================================================================
-- Tarefas de TODAS as empresas numa tela só (19/10/2026)
-- ----------------------------------------------------------------------------
-- Quem tem acesso a 2+ organizações (ex.: AMAI PARK e BELA CENTER) via as tarefas das duas juntas, com a
-- etiqueta da empresa, e conclui/edita/cria sem trocar de organização. Nada é duplicado: cada tarefa continua
-- guardada na empresa dela (org_id). As policies de tasks NÃO mudam — tudo passa por estas funções, que
-- conferem, para CADA empresa, as mesmas regras da tela normal:
--   * organizações consideradas: onde o usuário está ATIVO (app_users) e a org está ativa, mais a org em uso
--     (super admin em modo suporte vê também a org em que entrou);
--   * ver: permissão tasks.view naquela org E (tarefa minha, criada por mim, sem responsável, ou escopo
--     "Todas" de tarefas naquela org / admin dela). Escopo "Equipe" conta como "só minhas" aqui (mais restrito);
--   * concluir: tasks.complete ou tasks.edit · editar: tasks.edit · criar: tasks.create
--     (+ tasks.assign para pôr outra pessoa) · responsável tem de ser membro ativo daquela org.
-- Idempotente. Só cria funções.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- Orgs que o usuário logado pode usar aqui.
CREATE OR REPLACE FUNCTION whatsapp_hub._xorg_orgs()
RETURNS TABLE (org_id uuid, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT o.id, o.name
    FROM whatsapp_hub.organizations o
   WHERE o.status = 'active'
     AND (EXISTS (SELECT 1 FROM whatsapp_hub.app_users au
                   WHERE au.user_id = auth.uid() AND au.org_id = o.id AND au.status = 'active')
          OR (o.id = whatsapp_hub.current_org_id() AND whatsapp_hub.current_org_active()))
$$;

-- Permissão do usuário logado numa org específica (super admin: só na org em uso, como no resto do sistema).
CREATE OR REPLACE FUNCTION whatsapp_hub._xorg_can(p_org uuid, p_key text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM whatsapp_hub._xorg_orgs() x WHERE x.org_id = p_org)
     AND (
       (p_org = whatsapp_hub.current_org_id() AND whatsapp_hub.has_perm(p_key))
       OR EXISTS (SELECT 1 FROM whatsapp_hub.effective_permissions(auth.uid(), p_org) k WHERE k = p_key)
     )
$$;

-- Vê todas as tarefas da org (escopo "Todas" ou admin) ou só as próprias?
CREATE OR REPLACE FUNCTION whatsapp_hub._xorg_tasks_all_scope(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT CASE
    WHEN p_org = whatsapp_hub.current_org_id() THEN whatsapp_hub.perm_scope('tasks') = 'all'
    ELSE COALESCE((
      SELECT CASE
               WHEN COALESCE(ar.is_admin, au.access_role_id IS NULL AND au.role = 'admin') THEN true
               ELSE COALESCE(ar.scopes->>'tasks', 'all') = 'all'
             END
        FROM whatsapp_hub.app_users au
        LEFT JOIN whatsapp_hub.access_roles ar ON ar.id = au.access_role_id
       WHERE au.user_id = auth.uid() AND au.org_id = p_org AND au.status = 'active'
    ), false)
  END
$$;

CREATE OR REPLACE FUNCTION whatsapp_hub._xorg_task_visible(p_org uuid, p_assigned uuid, p_created uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
  SELECT whatsapp_hub._xorg_can(p_org, 'tasks.view')
     AND (p_assigned IS NULL OR p_assigned = auth.uid() OR p_created = auth.uid()
          OR whatsapp_hub._xorg_tasks_all_scope(p_org))
$$;

-- 1) Lista (Tarefas e Tarefas Diárias). p_from/p_to opcionais (prazo); sem prazo entra só sem filtro de data.
CREATE OR REPLACE FUNCTION whatsapp_hub.tasks_all_orgs(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE (
  id uuid, org_id uuid, org_name text, title text, description text, due_at timestamptz,
  assigned_to uuid, assigned_name text, status text, contact_id uuid, deal_id uuid, conversation_id uuid,
  created_by uuid, completed_at timestamptz, created_at timestamptz, recurrence text,
  can_edit boolean, can_complete boolean, can_delete boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
  WITH orgs AS (
    SELECT x.org_id, x.org_name,
           whatsapp_hub._xorg_can(x.org_id, 'tasks.view')     AS can_view,
           whatsapp_hub._xorg_can(x.org_id, 'tasks.edit')     AS can_edit,
           whatsapp_hub._xorg_can(x.org_id, 'tasks.complete') AS can_complete,
           whatsapp_hub._xorg_can(x.org_id, 'tasks.delete')   AS can_delete,
           whatsapp_hub._xorg_tasks_all_scope(x.org_id)       AS all_scope
      FROM whatsapp_hub._xorg_orgs() x
  )
  SELECT t.id, t.org_id, o.org_name, t.title, t.description, t.due_at,
         t.assigned_to, COALESCE(au.display_name, u.email::text), t.status::text, t.contact_id, t.deal_id, t.conversation_id,
         t.created_by, t.completed_at, t.created_at, COALESCE(t.recurrence, 'none'),
         o.can_edit, (o.can_complete OR o.can_edit), o.can_delete
    FROM whatsapp_hub.tasks t
    JOIN orgs o ON o.org_id = t.org_id AND o.can_view
    LEFT JOIN whatsapp_hub.app_users au ON au.user_id = t.assigned_to AND au.org_id = t.org_id
    LEFT JOIN auth.users u ON u.id = t.assigned_to
   WHERE (t.assigned_to IS NULL OR t.assigned_to = auth.uid() OR t.created_by = auth.uid() OR o.all_scope)
     AND (p_from IS NULL OR t.due_at >= p_from)
     AND (p_to IS NULL OR t.due_at < p_to)
     -- concluídas antigas não precisam vir (lista ficaria enorme)
     AND (t.status::text <> 'done' OR t.completed_at IS NULL OR t.completed_at > now() - interval '60 days')
   ORDER BY t.due_at NULLS LAST, t.created_at DESC
   LIMIT 3000
$$;

-- 2) Concluir / reabrir. p_next_due = próxima repetição calculada pela tela (mesma regra de src/lib/tasks.ts);
--    a cópia nasce na MESMA empresa da tarefa (não duplica se já existir pendente igual).
CREATE OR REPLACE FUNCTION whatsapp_hub.task_xorg_set_done(p_task uuid, p_done boolean, p_next_due timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  t whatsapp_hub.tasks%ROWTYPE;
  created boolean := false;
BEGIN
  SELECT * INTO t FROM whatsapp_hub.tasks WHERE id = p_task;
  IF NOT FOUND OR NOT whatsapp_hub._xorg_task_visible(t.org_id, t.assigned_to, t.created_by) THEN
    RAISE EXCEPTION 'Tarefa não encontrada.';
  END IF;
  IF NOT (whatsapp_hub._xorg_can(t.org_id, 'tasks.complete') OR whatsapp_hub._xorg_can(t.org_id, 'tasks.edit')) THEN
    RAISE EXCEPTION 'Sem permissão para concluir tarefas nesta empresa.';
  END IF;

  UPDATE whatsapp_hub.tasks
     SET status = CASE WHEN p_done THEN 'done' ELSE 'pending' END,
         completed_at = CASE WHEN p_done THEN now() ELSE NULL END
   WHERE id = p_task;

  IF p_done AND p_next_due IS NOT NULL AND COALESCE(t.recurrence, 'none') <> 'none' THEN
    IF NOT EXISTS (
      SELECT 1 FROM whatsapp_hub.tasks x
       WHERE x.org_id = t.org_id AND x.status::text = 'pending' AND x.title = t.title AND x.due_at = p_next_due
         AND x.assigned_to IS NOT DISTINCT FROM t.assigned_to
    ) THEN
      INSERT INTO whatsapp_hub.tasks (org_id, title, description, due_at, assigned_to, contact_id, deal_id,
                                      conversation_id, created_by, recurrence)
      VALUES (t.org_id, t.title, t.description, p_next_due, t.assigned_to, t.contact_id, t.deal_id,
              t.conversation_id, t.created_by, t.recurrence);
      created := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'next_created', created, 'next_due', p_next_due);
END $$;

-- 3) Criar (p_id NULL) ou editar. p = {title, description, due_at, assigned_to, recurrence}.
--    Na edição, campo que não vem no p fica como está.
CREATE OR REPLACE FUNCTION whatsapp_hub.task_xorg_save(p_id uuid, p_org uuid, p jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  t whatsapp_hub.tasks%ROWTYPE;
  v_org uuid;
  v_title text := nullif(btrim(p->>'title'), '');
  v_assigned uuid := nullif(p->>'assigned_to', '')::uuid;
  v_rec text := COALESCE(nullif(p->>'recurrence', ''), 'none');
  v_id uuid;
BEGIN
  IF v_title IS NULL AND (p_id IS NULL OR p ? 'title') THEN RAISE EXCEPTION 'Informe o título da tarefa.'; END IF;
  IF v_rec NOT IN ('none', 'daily', 'weekdays', 'weekly', 'monthly') THEN RAISE EXCEPTION 'Recorrência inválida.'; END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO t FROM whatsapp_hub.tasks WHERE id = p_id;
    IF NOT FOUND OR NOT whatsapp_hub._xorg_task_visible(t.org_id, t.assigned_to, t.created_by) THEN
      RAISE EXCEPTION 'Tarefa não encontrada.';
    END IF;
    IF NOT whatsapp_hub._xorg_can(t.org_id, 'tasks.edit') THEN RAISE EXCEPTION 'Sem permissão para editar tarefas nesta empresa.'; END IF;
    v_org := t.org_id;
    IF NOT (p ? 'assigned_to') THEN v_assigned := t.assigned_to; END IF;
  ELSE
    v_org := p_org;
    IF v_org IS NULL OR NOT whatsapp_hub._xorg_can(v_org, 'tasks.create') THEN
      RAISE EXCEPTION 'Sem permissão para criar tarefas nesta empresa.';
    END IF;
  END IF;

  IF v_assigned IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM whatsapp_hub.app_users au WHERE au.user_id = v_assigned AND au.org_id = v_org AND au.status = 'active') THEN
      RAISE EXCEPTION 'O responsável escolhido não é membro ativo desta empresa.';
    END IF;
    IF v_assigned <> auth.uid() AND (p_id IS NULL OR v_assigned IS DISTINCT FROM t.assigned_to)
       AND NOT whatsapp_hub._xorg_can(v_org, 'tasks.assign') THEN
      RAISE EXCEPTION 'Sem permissão para atribuir tarefas a outra pessoa nesta empresa.';
    END IF;
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE whatsapp_hub.tasks
       SET title       = COALESCE(v_title, t.title),
           description = CASE WHEN p ? 'description' THEN nullif(p->>'description', '') ELSE t.description END,
           due_at      = CASE WHEN p ? 'due_at' THEN nullif(p->>'due_at', '')::timestamptz ELSE t.due_at END,
           assigned_to = v_assigned,
           recurrence  = CASE WHEN p ? 'recurrence' THEN v_rec ELSE COALESCE(t.recurrence, 'none') END
     WHERE id = p_id;
    RETURN p_id;
  END IF;

  INSERT INTO whatsapp_hub.tasks (org_id, title, description, due_at, assigned_to, created_by, recurrence)
  VALUES (v_org, v_title, nullif(p->>'description', ''), nullif(p->>'due_at', '')::timestamptz, v_assigned, auth.uid(), v_rec)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 4) Membros ativos de uma org (seletor "Responsável" ao criar/editar tarefa de outra empresa).
CREATE OR REPLACE FUNCTION whatsapp_hub.task_xorg_members(p_org uuid)
RETURNS TABLE (user_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = whatsapp_hub, auth, pg_temp
AS $$
  SELECT au.user_id, COALESCE(au.display_name, u.email::text)
    FROM whatsapp_hub.app_users au
    JOIN auth.users u ON u.id = au.user_id
   WHERE au.org_id = p_org AND au.status = 'active'
     AND whatsapp_hub._xorg_can(p_org, 'tasks.view')
   ORDER BY 2
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_hub._xorg_orgs() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._xorg_can(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._xorg_tasks_all_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub._xorg_task_visible(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.tasks_all_orgs(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.task_xorg_set_done(uuid, boolean, timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.task_xorg_save(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.task_xorg_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub._xorg_orgs() TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub._xorg_can(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub._xorg_tasks_all_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub._xorg_task_visible(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.tasks_all_orgs(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.task_xorg_set_done(uuid, boolean, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.task_xorg_save(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.task_xorg_members(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Conferência: em quais empresas EU tenho acesso (rode logado como você não funciona no SQL Editor;
-- aqui lista, por pessoa, quantas empresas ativas cada uma tem — quem tem 2+ verá a opção na tela).
SELECT COALESCE(au.display_name, u.email) AS pessoa, count(*) AS empresas, string_agg(o.name, ', ' ORDER BY o.name) AS quais
  FROM whatsapp_hub.app_users au
  JOIN auth.users u ON u.id = au.user_id
  JOIN whatsapp_hub.organizations o ON o.id = au.org_id AND o.status = 'active'
 WHERE au.status = 'active'
 GROUP BY 1 HAVING count(*) > 1
 ORDER BY 1;
