-- ============================================================================
-- Busca automática de notas na SEFAZ (14/11/2026).
-- pg_cron chama POST https://crm.amaipark.com/api/sefaz { action: 'cron_sync' } com o cabeçalho x-cron-secret.
-- O segredo fica no Vault ('sefaz_cron_secret') e o MESMO valor na Vercel (variável SEFAZ_CRON_SECRET).
-- Horários (UTC 11 e 17 = 06 e 12 no Acre): 4 chamadas de 5 em 5 min (06:40–06:55 e 12:40–12:55). A 1ª busca; as
-- outras só continuam se ainda havia notas (com "aguarde 1 hora" da SEFAZ a função nem chama a SEFAZ).
-- Só chama se existir o segredo e alguma empresa com a busca ligada. Idempotente.
-- O segredo é criado pelo script da VPS (não fica no repositório):
--   select vault.create_secret('<64 caracteres aleatórios>', 'sefaz_cron_secret');
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('sefaz-auto-sync'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('sefaz-auto-sync', '40,45,50,55 11,17 * * *', $c$
    SELECT net.http_post(
      url := 'https://crm.amaipark.com/api/sefaz',
      body := '{"action":"cron_sync"}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', s.decrypted_secret),
      timeout_milliseconds := 60000)
      FROM vault.decrypted_secrets s
     WHERE s.name = 'sefaz_cron_secret'
       AND EXISTS (SELECT 1 FROM whatsapp_hub.pur_sefaz_state WHERE enabled)
  $c$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron indisponível — busca automática da SEFAZ não agendada: %', SQLERRM;
END $$;

SELECT jobname, schedule FROM cron.job WHERE jobname = 'sefaz-auto-sync';
