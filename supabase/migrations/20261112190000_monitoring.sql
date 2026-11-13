-- ============================================================================
-- Monitoramento (12/11/2026) — rota /monitoramento + Edge Function monitor-alerts (cron 15 min)
-- ----------------------------------------------------------------------------
-- Motivo: em 11–12/11 o número oficial ficou um dia inteiro recusando tudo (Meta 131042, pagamento) e o CRM
-- mostrava "enviado". Este painel junta o que já está no banco para ninguém mais precisar adivinhar:
--   * envio por número (24 h): enviadas / entregues / lidas / falhas / presas em "enviado" há +30 min,
--     último motivo de falha, última entrega confirmada;
--   * clientes esperando resposta (última mensagem do cliente há +10 min, conversa aberta);
--   * AMAIA ligada/desligada por canal + custo da IA (ai_usage_log) hoje e no mês;
--   * gasto estimado do WhatsApp no mês: modelos (templates) enviados por categoria × preço que a EMPRESA
--     informa (nada de preço inventado) e limite mensal;
--   * última mensagem de cliente recebida (prova de que os webhooks chegam) e agendamentos com erro (pg_cron, 24 h).
-- Alertas: monitor_check(org) devolve a lista do que está errado; a Edge Function monitor-alerts manda no
-- WhatsApp para os destinatários com o assunto "monitoramento" (Notificações WhatsApp), no máx. 1 vez a cada
-- 2 h por tipo (monitor_alert_log).
-- Só leitura sobre os dados do CRM. Idempotente.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

-- 1. Configuração por org (preços em centavos de R$; 0 = não informado)
ALTER TABLE whatsapp_hub.app_settings
  ADD COLUMN IF NOT EXISTS wa_budget_month_cents   bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_price_marketing_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_price_utility_cents   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_price_auth_cents      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monitor_alerts_enabled   boolean NOT NULL DEFAULT true;

-- 2. Registro dos alertas enviados (evita repetir o mesmo aviso)
CREATE TABLE IF NOT EXISTS whatsapp_hub.monitor_alert_log (
  id       bigserial PRIMARY KEY,
  org_id   uuid NOT NULL REFERENCES whatsapp_hub.organizations(id) ON DELETE CASCADE,
  kind     text NOT NULL,
  detail   text,
  sent_to  integer NOT NULL DEFAULT 0,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitor_alert_log_org_idx ON whatsapp_hub.monitor_alert_log (org_id, kind, sent_at DESC);
ALTER TABLE whatsapp_hub.monitor_alert_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitor_alert_log_read ON whatsapp_hub.monitor_alert_log;
CREATE POLICY monitor_alert_log_read ON whatsapp_hub.monitor_alert_log FOR SELECT TO authenticated
  USING (org_id = (SELECT whatsapp_hub.current_org_id()) AND (SELECT whatsapp_hub.current_org_active())
         AND (SELECT whatsapp_hub.has_perm('dashboard.view')));
GRANT SELECT ON whatsapp_hub.monitor_alert_log TO authenticated;
GRANT ALL ON whatsapp_hub.monitor_alert_log TO service_role;
GRANT USAGE ON SEQUENCE whatsapp_hub.monitor_alert_log_id_seq TO service_role;

-- Índice para as contas de 24 h / mês (mensagens enviadas por org e data).
CREATE INDEX IF NOT EXISTS messages_org_out_created_idx ON whatsapp_hub.messages (org_id, created_at) WHERE direction = 'outbound';

-- 3. Números (mesma conta de cima, por org) — usado pela tela e pelos alertas
CREATE OR REPLACE FUNCTION whatsapp_hub._monitor_data(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE
  r jsonb;
  v_since timestamptz := now() - interval '24 hours';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Rio_Branco') AT TIME ZONE 'America/Rio_Branco';
  v_today timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Rio_Branco') AT TIME ZONE 'America/Rio_Branco';
  v_cron jsonb := '[]'::jsonb;
BEGIN
  BEGIN
    SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_cron FROM (
      SELECT j.jobname, count(*) AS falhas, max(d.end_time) AS ultima, left(max(d.return_message), 200) AS mensagem
        FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
       WHERE d.status = 'failed' AND d.end_time >= v_since
       GROUP BY j.jobname ORDER BY 2 DESC LIMIT 10) x;
  EXCEPTION WHEN OTHERS THEN v_cron := '[]'::jsonb;  -- sem acesso ao pg_cron: painel segue sem esse bloco
  END;

  WITH out24 AS (
    SELECT c.channel_id, m.meta_status::text AS st, m.created_at, m.error_reason
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.org_id = p_org AND m.direction = 'outbound' AND coalesce(m.is_private_note, false) = false
       AND m.created_at >= v_since
  ), por_canal AS (
    SELECT ch.id, ch.label, ch.provider, ch.phone, ch.is_active, ch.ai_enabled,
           count(*) FILTER (WHERE o.st IS NOT NULL)                       AS total,
           count(*) FILTER (WHERE o.st = 'sent')                          AS enviadas,
           count(*) FILTER (WHERE o.st = 'delivered')                     AS entregues,
           count(*) FILTER (WHERE o.st = 'read')                          AS lidas,
           count(*) FILTER (WHERE o.st = 'failed')                        AS falhas,
           count(*) FILTER (WHERE o.st = 'sent' AND o.created_at < now() - interval '30 minutes') AS presas,
           max(o.created_at) FILTER (WHERE o.st IN ('delivered', 'read'))   AS ultima_entrega,
           (SELECT o2.error_reason FROM out24 o2 WHERE o2.channel_id = ch.id AND o2.st = 'failed'
             ORDER BY o2.created_at DESC LIMIT 1)                           AS ultimo_erro,
           max(o.created_at) FILTER (WHERE o.st = 'failed')                 AS ultimo_erro_em
      FROM channels ch LEFT JOIN out24 o ON o.channel_id = ch.id
     WHERE ch.org_id = p_org
     GROUP BY ch.id
  )
  SELECT jsonb_build_object(
    'gerado_em', now(),
    'canais', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.total DESC), '[]'::jsonb) FROM por_canal p),
    'erros', (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
        SELECT coalesce(error_reason, 'sem detalhe') AS motivo, count(*) AS qtd, max(created_at) AS ultima
          FROM out24 WHERE st = 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8) x),
    'esperando', (SELECT jsonb_build_object(
        'total', count(*),
        'com_ia', count(*) FILTER (WHERE NOT c.ai_paused AND c.status = 'ai_active'),
        'mais_antiga', min(lm.created_at))
      FROM conversations c
      JOIN LATERAL (SELECT m.direction, m.created_at FROM messages m
                     WHERE m.conversation_id = c.id AND coalesce(m.is_private_note, false) = false
                     ORDER BY m.created_at DESC LIMIT 1) lm ON true
     WHERE c.org_id = p_org AND c.status <> 'closed' AND coalesce(c.archived, false) = false
       AND c.last_message_at >= now() - interval '3 days'
       AND lm.direction = 'inbound' AND lm.created_at < now() - interval '10 minutes'),
    'ia', (SELECT jsonb_build_object('ligada', a.is_active, 'whatsapp', a.active_whatsapp, 'instagram', a.active_instagram)
             FROM ai_agent_config a WHERE a.org_id = p_org),
    'ia_custo', (SELECT jsonb_build_object(
        'hoje_usd', coalesce(sum(estimated_cost_usd) FILTER (WHERE created_at >= v_today), 0),
        'mes_usd',  coalesce(sum(estimated_cost_usd), 0),
        'respostas_mes', count(*) FILTER (WHERE kind = 'chat'))
      FROM ai_usage_log WHERE org_id = p_org AND created_at >= v_month),
    'wa_gasto', (WITH t AS (
        SELECT coalesce(tp.category::text, 'sem_categoria') AS cat, count(*) AS qtd
          FROM messages m
          LEFT JOIN campaign_contacts cc ON cc.id = m.campaign_contact_id
          LEFT JOIN campaigns cp ON cp.id = cc.campaign_id
          LEFT JOIN templates tp ON tp.id = coalesce(cc.template_id_override, cp.template_id)
         WHERE m.org_id = p_org AND m.direction = 'outbound' AND m.content_type::text = 'template'
           AND m.created_at >= v_month AND coalesce(m.meta_status::text, '') <> 'failed'
         GROUP BY 1)
      SELECT jsonb_build_object(
        'por_categoria', coalesce((SELECT jsonb_object_agg(cat, qtd) FROM t), '{}'::jsonb),
        'precos', jsonb_build_object('marketing', s.wa_price_marketing_cents, 'utility', s.wa_price_utility_cents,
                                     'authentication', s.wa_price_auth_cents),
        'limite_mes_centavos', s.wa_budget_month_cents,
        'estimado_mes_centavos', coalesce((SELECT sum(qtd * CASE cat
              WHEN 'marketing' THEN s.wa_price_marketing_cents
              WHEN 'authentication' THEN s.wa_price_auth_cents
              ELSE s.wa_price_utility_cents END) FROM t), 0),
        'alertas_ligados', s.monitor_alerts_enabled)
      FROM app_settings s WHERE s.org_id = p_org),
    -- Sinal de que os webhooks chegam: última mensagem de cliente gravada (qualquer canal).
    'webhook_ultimo', (SELECT max(created_at) FROM messages WHERE org_id = p_org AND direction = 'inbound' AND created_at >= now() - interval '3 days'),
    'agendamentos_com_erro', v_cron
  ) INTO r
  FROM (SELECT 1) one;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION whatsapp_hub._monitor_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub._monitor_data(uuid) TO service_role;

-- 5. Alertas: o que está errado agora (lido pela Edge Function monitor-alerts, service role)
CREATE OR REPLACE FUNCTION whatsapp_hub.monitor_check(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE d jsonb; a jsonb := '[]'::jsonb; c jsonb; w jsonb;
BEGIN
  d := whatsapp_hub._monitor_data(p_org);
  FOR c IN SELECT * FROM jsonb_array_elements(d->'canais') LOOP
    IF (c->>'is_active')::boolean IS DISTINCT FROM false AND (c->>'falhas')::int >= 5
       AND (c->>'falhas')::int * 100 >= 20 * greatest((c->>'total')::int, 1) THEN
      a := a || jsonb_build_object('kind', 'falhas:' || (c->>'id'), 'texto',
        format('🔴 Número %s: %s de %s mensagens FALHARAM nas últimas 24 h. Último motivo: %s',
               coalesce(c->>'label', c->>'phone'), c->>'falhas', c->>'total', coalesce(c->>'ultimo_erro', 'sem detalhe')));
    END IF;
    -- Só número oficial (Zernio): o UAZAPI não devolve confirmação de entrega, lá tudo fica "enviado".
    IF c->>'provider' = 'zernio' AND (c->>'presas')::int >= 10 THEN
      a := a || jsonb_build_object('kind', 'presas:' || (c->>'id'), 'texto',
        format('🟠 Número %s: %s mensagens "enviadas" há mais de 30 min sem confirmação de entrega. Pode ser bloqueio na Meta (pagamento, qualidade) ou webhook parado.',
               coalesce(c->>'label', c->>'phone'), c->>'presas'));
    END IF;
  END LOOP;
  IF (d->'esperando'->>'total')::int >= 10 THEN
    a := a || jsonb_build_object('kind', 'esperando', 'texto',
      format('🟡 %s clientes esperando resposta há mais de 10 min (%s com a AMAIA ligada).',
             d->'esperando'->>'total', d->'esperando'->>'com_ia'));
  END IF;
  IF d->>'webhook_ultimo' IS NOT NULL AND (d->>'webhook_ultimo')::timestamptz < now() - interval '2 hours'
     AND EXTRACT(hour FROM now() AT TIME ZONE 'America/Rio_Branco') BETWEEN 8 AND 21 THEN
    a := a || jsonb_build_object('kind', 'webhook', 'texto',
      format('🟠 Nenhuma mensagem de cliente chega ao CRM desde %s. Confira os webhooks e os números.',
             to_char((d->>'webhook_ultimo')::timestamptz AT TIME ZONE 'America/Rio_Branco', 'DD/MM HH24:MI')));
  END IF;
  w := d->'wa_gasto';
  IF (w->>'limite_mes_centavos')::bigint > 0
     AND (w->>'estimado_mes_centavos')::bigint * 100 >= 80 * (w->>'limite_mes_centavos')::bigint THEN
    a := a || jsonb_build_object('kind', 'gasto_wa', 'texto',
      format('💰 Gasto estimado do WhatsApp no mês: R$ %s de R$ %s (limite).',
             to_char((w->>'estimado_mes_centavos')::numeric / 100, 'FM999G990D00'),
             to_char((w->>'limite_mes_centavos')::numeric / 100, 'FM999G990D00')));
  END IF;
  RETURN jsonb_build_object('enabled', coalesce((w->>'alertas_ligados')::boolean, true), 'alertas', a);
END $$;
REVOKE ALL ON FUNCTION whatsapp_hub.monitor_check(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION whatsapp_hub.monitor_check(uuid) TO service_role;

-- 4. Para a tela: só a org do token, com permissão de painel
CREATE OR REPLACE FUNCTION whatsapp_hub.monitor_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp AS $$
DECLARE v_org uuid := whatsapp_hub.current_org_id();
BEGIN
  IF NOT (whatsapp_hub.current_org_active() AND (whatsapp_hub.has_perm('dashboard.view') OR whatsapp_hub.is_full_admin())) THEN
    RAISE EXCEPTION 'Sem permissão para ver o monitoramento.';
  END IF;

  -- Mesmos alertas que vão para o WhatsApp, para a tela mostrar no topo.
  RETURN whatsapp_hub._monitor_data(v_org) || jsonb_build_object('alertas', whatsapp_hub.monitor_check(v_org)->'alertas');
END $$;
REVOKE ALL ON FUNCTION whatsapp_hub.monitor_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.monitor_overview() TO authenticated;


-- 6. Agendamento: a cada 15 min chama a Edge Function (só se alguma org tiver destinatário "monitoramento")
DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('monitor-alerts-15min'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('monitor-alerts-15min', '*/15 * * * *',
    $c$SELECT whatsapp_hub._cron_invoke_edge('monitor-alerts') WHERE EXISTS (SELECT 1 FROM whatsapp_hub.wa_notify_recipients WHERE is_active AND 'monitoramento' = ANY(topics))$c$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron indisponível — agendamento monitor-alerts não criado: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
SELECT 'monitoramento ok' AS situacao;
