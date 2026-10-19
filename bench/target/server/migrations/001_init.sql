-- Every resource hangs off a workspace (Better Auth "organization").
-- Timestamps are unix milliseconds.

CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama')),
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('api_key', 'oauth', 'none')),
  encrypted_secret TEXT,
  base_url         TEXT,
  created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE tickets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  spec         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo', 'running', 'review', 'done', 'failed')),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX tickets_workspace_status ON tickets(workspace_id, status);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'worker',
  provider_id   TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,
  worktree      TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX runs_ticket ON runs(ticket_id);

-- Append-only source of truth. Dashboard, token totals, replays and evals are projections of this.
CREATE TABLE events (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE TABLE prompts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL,
  eval_score   REAL,
  active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, role, version)
);
CREATE UNIQUE INDEX prompts_one_active ON prompts(workspace_id, role) WHERE active = 1;
