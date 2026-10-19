-- Immutable measurements: one row per actual inference attempt, including background work.
CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  ticket_id TEXT,
  run_id TEXT,
  provider_id TEXT,
  provider_name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  billing_mode TEXT NOT NULL,
  purpose TEXT NOT NULL,
  background INTEGER NOT NULL CHECK (background IN (0,1)),
  started_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('reported','partial','unavailable')),
  input INTEGER NOT NULL CHECK (input >= 0),
  output INTEGER NOT NULL CHECK (output >= 0),
  cache_read INTEGER NOT NULL CHECK (cache_read >= 0),
  cache_write INTEGER NOT NULL CHECK (cache_write >= 0),
  cost_usd REAL,
  historical INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX usage_workspace_time ON usage_ledger(workspace_id, started_at);
CREATE INDEX usage_ticket ON usage_ledger(ticket_id);
CREATE INDEX usage_run ON usage_ledger(run_id);
CREATE TABLE usage_accounting (id INTEGER PRIMARY KEY CHECK (id=1), complete_since INTEGER NOT NULL);
INSERT INTO usage_accounting VALUES (1, CAST(unixepoch('subsec') * 1000 AS INTEGER));
ALTER TABLE runs ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0;
