-- ============================================================================
-- Backfill: conversations.channel_id para conversas Zernio antigas
-- ----------------------------------------------------------------------------
-- Conversas criadas ANTES do multi-canal (channels) ficaram com channel_id
-- NULL — por isso a lista da Inbox cai no rótulo genérico "WhatsApp" em vez
-- do telefone do canal (o UAZAPI já mostra telefone porque toda conversa
-- UAZAPI sempre carimbou channel_id desde o início). O webhook Zernio já
-- AUTOCORRIGE isso na próxima mensagem de cada conversa (ver
-- zernio-webhook/index.ts:191), mas esta migration adianta o backfill pras
-- conversas que já existem hoje.
--
-- Só preenche quando a organização tem EXATAMENTE UM canal zernio ativo —
-- se houver mais de um número Zernio, não dá pra saber qual recebeu cada
-- conversa antiga sem ambiguidade, então essas ficam como estão (corrigem
-- sozinhas na próxima mensagem, via o mesmo mecanismo do webhook).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT org_id, (array_agg(id))[1] AS channel_id, count(*) AS n
      FROM whatsapp_hub.channels
     WHERE provider = 'zernio' AND is_active
     GROUP BY org_id
    HAVING count(*) = 1
  LOOP
    UPDATE whatsapp_hub.conversations
       SET channel_id = r.channel_id
     WHERE org_id = r.org_id
       AND channel_id IS NULL
       AND channel = 'whatsapp'
       AND provider = 'zernio';
  END LOOP;
END $$;
