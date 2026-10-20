-- ============================================================================
-- Agendamentos só chamam a Edge Function quando há trabalho (20/10/2026)
-- ----------------------------------------------------------------------------
-- Diagnóstico (24 h): wh-dispatch-campaigns rodou 2.873x e wh-sync-broadcast-status 720x — chamando a função
-- mesmo sem nenhuma campanha. Cada chamada gera log no banco + rede (pg_net) + Edge Function: estourou o
-- "Log Ingestion" do plano Free (1,04 de 1 GB).
-- Agora o próprio comando do agendamento confere no banco se há algo a fazer (consulta barata, sem log de
-- função) e só então chama a função — o MESMO critério que a função já usava para sair sem fazer nada:
--   * dispatch-campaign: campanha 'sending', ou 'scheduled' com horário já chegado;
--   * sync-broadcast-status: linha de campanha 'sent'/'delivered' com broadcast nos últimos 3 dias.
-- Frequência continua igual (30 s / 2 min): campanha começa no mesmo tempo de antes.
-- Também: limpeza diária do histórico do pg_cron (cron.job_run_details) com mais de 3 dias — é só o registro
-- de "rodou / não rodou" dos agendamentos (crescia ~4 mil linhas por dia). Não toca em nenhum dado do CRM.
-- Idempotente. Para voltar ao antigo: cron.alter_job(..., command := 'SELECT whatsapp_hub._cron_invoke_edge(''...'')').
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub;

CREATE INDEX IF NOT EXISTS campaigns_status_sched_idx ON whatsapp_hub.campaigns (status, scheduled_at);
CREATE INDEX IF NOT EXISTS campaign_contacts_broadcast_open_idx ON whatsapp_hub.campaign_contacts (sent_at)
  WHERE zernio_broadcast_id IS NOT NULL AND status IN ('sent', 'delivered');

DO $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = 'wh-dispatch-campaigns';
  IF v IS NOT NULL THEN
    PERFORM cron.alter_job(v, command := $c$SELECT whatsapp_hub._cron_invoke_edge('dispatch-campaign') WHERE EXISTS (SELECT 1 FROM whatsapp_hub.campaigns WHERE status = 'sending' OR (status = 'scheduled' AND scheduled_at <= now()))$c$);
  ELSE
    RAISE NOTICE 'wh-dispatch-campaigns não existe — nada alterado';
  END IF;

  SELECT jobid INTO v FROM cron.job WHERE jobname = 'wh-sync-broadcast-status';
  IF v IS NOT NULL THEN
    PERFORM cron.alter_job(v, command := $c$SELECT whatsapp_hub._cron_invoke_edge('sync-broadcast-status') WHERE EXISTS (SELECT 1 FROM whatsapp_hub.campaign_contacts WHERE zernio_broadcast_id IS NOT NULL AND status IN ('sent', 'delivered') AND sent_at >= now() - interval '3 days')$c$);
  ELSE
    RAISE NOTICE 'wh-sync-broadcast-status não existe — nada alterado';
  END IF;

  -- Limpeza do histórico do pg_cron: todo dia 03:40 UTC, apaga registros com mais de 3 dias.
  BEGIN PERFORM cron.unschedule('cron-history-cleanup-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('cron-history-cleanup-daily', '40 3 * * *',
    $c$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days'$c$);
END $$;

-- Conferência: os dois agendamentos com o comando novo (começando por SELECT ... WHERE EXISTS)
SELECT jobname, schedule, active, left(command, 120) AS comando
  FROM cron.job
 WHERE jobname IN ('wh-dispatch-campaigns', 'wh-sync-broadcast-status', 'cron-history-cleanup-daily')
 ORDER BY jobname;

-- Conferência 2: campanhas que mantêm o disparo "acordado". Se aparecer alguma 'sending' antiga que já terminou,
-- me mande — ela faria a função continuar sendo chamada a cada 30 s.
SELECT o.name AS empresa, c.name AS campanha, c.status, c.scheduled_at, c.started_at
  FROM whatsapp_hub.campaigns c JOIN whatsapp_hub.organizations o ON o.id = c.org_id
 WHERE c.status = 'sending' OR (c.status = 'scheduled' AND c.scheduled_at <= now())
 ORDER BY c.started_at NULLS LAST;
