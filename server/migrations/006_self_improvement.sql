-- M6: self-improvement. Lessons, prompt versions and eval cases/results live only in the DB: no agent tool reaches them.

-- The lessons document of a workspace. Every change is a new version; the latest one is active (injected into new runs).
CREATE TABLE lessons (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  body          TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('reflection', 'human', 'restore')),
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL, -- reflection: the run it reflected on
  author        TEXT,                                        -- human edit / restore: the user's email
  restored_from INTEGER,                                     -- restore: the version copied
  created_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, version)
);

-- prompts (001) holds the worker system prompt versions: v1 seeded from prompts/worker.md, one active per workspace.
ALTER TABLE prompts ADD COLUMN source TEXT NOT NULL DEFAULT 'seed'; -- seed | human | proposal
ALTER TABLE prompts ADD COLUMN author TEXT;                         -- user email, or the model that proposed it
ALTER TABLE prompts ADD COLUMN rationale TEXT;                      -- proposals: the model's one-paragraph rationale

-- A frozen task: the ticket as it was approved, the commit its run started from, and the repo settings at creation.
-- Deleting the ticket is refused while it is a case (its eval transcripts are runs of that ticket).
CREATE TABLE eval_cases (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  ticket_id       TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  spec            TEXT NOT NULL,
  repo_path       TEXT NOT NULL,
  base_sha        TEXT NOT NULL,
  setup_command   TEXT NOT NULL,
  test_command    TEXT NOT NULL,
  protected_paths TEXT NOT NULL,
  image           TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- One prompt version against a set of cases (case_ids: sorted JSON array, compared verbatim for promotion).
CREATE TABLE eval_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  prompt_id       TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_version  INTEGER NOT NULL,
  lessons_version INTEGER,                 -- active at start; NULL = no lessons
  case_ids        TEXT NOT NULL CHECK (json_valid(case_ids)),
  model           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  passed          INTEGER,
  total           INTEGER,
  mean_tokens     REAL,                    -- mean of tokens_in + tokens_out per case
  started_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ended_at        INTEGER
);

CREATE TABLE eval_results (
  eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL,               -- no FK: results outlive a removed case
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  passed      INTEGER NOT NULL CHECK (passed IN (0, 1)),
  turns       INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  cost_usd    REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (eval_run_id, case_id)
);

-- Which prompt and lessons version a run used. Eval case runs belong to the case's ticket but never touch it.
ALTER TABLE runs ADD COLUMN prompt_version INTEGER;
ALTER TABLE runs ADD COLUMN lessons_version INTEGER;
ALTER TABLE runs ADD COLUMN eval_run_id TEXT REFERENCES eval_runs(id) ON DELETE CASCADE;
ALTER TABLE runs ADD COLUMN eval_case_id TEXT;
