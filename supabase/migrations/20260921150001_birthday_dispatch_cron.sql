-- ============================================================================
-- Config. Aniversário · Cron do disparo automático
-- ============================================================================
-- Agenda a Edge Function send-birthday-messages (deployada junto desta
-- migração) diariamente às 08:00 via o helper existente _cron_invoke_edge
-- (pg_net + service token da Vault).
--
-- A função tem kill-switch: com birthday_config.auto_send = false (default),
-- o run inteiro é curto-circuitado e NADA é enviado. Guardrails na função:
-- kill-switch → template configurado → horário comercial → mês/dia de
-- aniversário → ainda não enviado este ano → E.164 → auditoria em
-- crm_ai_actions.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('birthday-dispatch-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule(
  'birthday-dispatch-daily',
  '0 8 * * *',
  $cron$SELECT whatsapp_hub._cron_invoke_edge('send-birthday-messages')$cron$
);
