-- M16: OpenRouter and LiteLLM providers, and per-provider options (JSON; OpenRouter: data_collection). SQLite cannot widen a
-- CHECK in place, so the table is rebuilt; migrate() runs with foreign keys off and checks them before committing
-- (SQLite's documented procedure), so the tickets, runs and settings that point at a provider keep pointing at it.
CREATE TABLE providers_new (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama', 'openrouter', 'litellm')),
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('api_key', 'oauth', 'none')),
  encrypted_secret TEXT,
  base_url         TEXT,
  context_window   INTEGER NOT NULL DEFAULT 1000000, -- tokens; a run compacts at min(70% of it, compact_at_tokens)
  options          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
  created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
INSERT INTO providers_new (id, workspace_id, name, kind, auth_type, encrypted_secret, base_url, context_window, created_at)
  SELECT id, workspace_id, name, kind, auth_type, encrypted_secret, base_url, context_window, created_at FROM providers;
DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;
