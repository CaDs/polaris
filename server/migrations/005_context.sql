-- M5: context management. Per-provider context window (tokens) and a workspace-level compaction cap.
ALTER TABLE providers ADD COLUMN context_window INTEGER NOT NULL DEFAULT 1000000;
UPDATE providers SET context_window = 400000 WHERE kind = 'openai';
UPDATE providers SET context_window = 32768 WHERE kind = 'ollama';
-- A run compacts at min(70% of the provider's window, this).
ALTER TABLE workspace_settings ADD COLUMN compact_at_tokens INTEGER NOT NULL DEFAULT 150000;
