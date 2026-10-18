-- M3: one repository per workspace, plus per-run git branch bookkeeping.
CREATE TABLE workspace_settings (
  workspace_id    TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  repo_path       TEXT NOT NULL,                       -- absolute path of a git repo on the server host
  base_branch     TEXT NOT NULL,                       -- runs branch from it; approve merges into it
  setup_command   TEXT NOT NULL DEFAULT 'npm ci',      -- '' = no setup step
  test_command    TEXT NOT NULL DEFAULT 'npm test',    -- '' = no test gate (protected-path check still runs)
  protected_paths TEXT NOT NULL DEFAULT 'tests/,evals/', -- comma list, read-only to agents
  image           TEXT NOT NULL DEFAULT 'agent-harness-sandbox:1',
  updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

ALTER TABLE runs ADD COLUMN branch TEXT;
ALTER TABLE runs ADD COLUMN base_sha TEXT;
