-- Encaminhamento para o JURÍDICO (12/11/2026).
-- A AMAIA escreve [JURIDICO] (casos de inadimplência) → process-ai-message:
--   * pausa a IA e entrega a conversa ao responsável do jurídico (app_settings.juridico_member), sem rodízio;
--   * coloca a etiqueta "Jurídico" no contato;
--   * avisa no WhatsApp os destinatários de Notificações WhatsApp com o assunto "juridico".
-- Pode rodar mais de uma vez.
SET search_path TO whatsapp_hub;

ALTER TABLE whatsapp_hub.app_settings ADD COLUMN IF NOT EXISTS juridico_member uuid;

-- Etiqueta "Jurídico" em toda organização ativa (a função também cria se faltar).
INSERT INTO whatsapp_hub.tags (org_id, name, color)
SELECT o.id, 'Jurídico', '#7C3AED' FROM whatsapp_hub.organizations o
 WHERE o.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM whatsapp_hub.tags t WHERE t.org_id = o.id AND lower(t.name) = 'jurídico');

NOTIFY pgrst, 'reload schema';

SELECT 'juridico ok' AS situacao,
       (SELECT count(*) FROM whatsapp_hub.tags WHERE lower(name) = 'jurídico') AS etiquetas;
