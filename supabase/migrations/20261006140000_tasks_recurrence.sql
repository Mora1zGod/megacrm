-- ============================================================================
-- Tarefas recorrentes — 06/10/2026
-- ----------------------------------------------------------------------------
-- recurrence: none | daily | weekdays | weekly | monthly. Ao concluir uma
-- tarefa recorrente, o app cria a próxima ocorrência (src/lib/tasks.ts).
-- Compatível: coluna nova com default 'none'; linhas existentes não mudam.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.tasks
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_recurrence_check') THEN
    ALTER TABLE whatsapp_hub.tasks
      ADD CONSTRAINT tasks_recurrence_check
      CHECK (recurrence IN ('none', 'daily', 'weekdays', 'weekly', 'monthly'));
  END IF;
END $$;
