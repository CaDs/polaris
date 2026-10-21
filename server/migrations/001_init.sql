-- Every resource hangs off a workspace (Better Auth "organization"); tickets, cycles, the wiki and chats also belong to a
-- project, which is one git repository. Timestamps are unix milliseconds; dates (due, target, cycle bounds) 'YYYY-MM-DD' text.

CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama')),
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('api_key', 'oauth', 'none')),
  encrypted_secret TEXT,
  base_url         TEXT,
  context_window   INTEGER NOT NULL DEFAULT 1000000, -- tokens; a run compacts at min(70% of it, compact_at_tokens)
  created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- What applies to every project of a workspace: models, agent behaviour, budgets, spending caps. The row is created on
-- the first save; runs.ts SETTINGS_DEFAULTS repeats these defaults.
CREATE TABLE workspace_settings (
  workspace_id          TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  -- Provider/model per phase. NULL = fall through (ticket → phase → workspace default → env; the reviewer: the run's own;
  -- the planner and chat: the default; wiki: the run it documents).
  default_provider_id   TEXT REFERENCES providers(id) ON DELETE SET NULL,
  default_model         TEXT,
  review_provider_id    TEXT REFERENCES providers(id) ON DELETE SET NULL,
  review_model          TEXT,
  planner_provider_id   TEXT REFERENCES providers(id) ON DELETE SET NULL,
  planner_model         TEXT,
  wiki_provider_id      TEXT REFERENCES providers(id) ON DELETE SET NULL,
  wiki_model            TEXT,
  chat_provider_id      TEXT REFERENCES providers(id) ON DELETE SET NULL,
  chat_model            TEXT,
  compact_at_tokens     INTEGER NOT NULL DEFAULT 150000,
  -- 1 = a child whose run passes the gate is merged without a human click.
  auto_approve_children INTEGER NOT NULL DEFAULT 0,
  -- 1 = after the test gate, a model reviews the change (and the worker fixes its findings) before a human sees it.
  model_review          INTEGER NOT NULL DEFAULT 1,
  -- 1 = a task that fails its last attempt becomes a "Split:" epic whose planner breaks it into smaller children.
  auto_split            INTEGER NOT NULL DEFAULT 1,
  -- What the worker model reliably finishes; the planner sizes every child to at most this.
  child_size_hint       TEXT NOT NULL DEFAULT 'at most 3 files and about 60 changed lines, finishable in 20 agent turns',
  -- System One model (served by the default Ollama provider) that scores a new ticket's size before its first run. '' = off.
  triage_model          TEXT NOT NULL DEFAULT '',
  -- 1 = runs get a snapshot of their project's wiki and approved work is ingested into it.
  wiki                  INTEGER NOT NULL DEFAULT 1,
  -- Worker budget per attempt: turns per agent call, wall-clock minutes for the whole attempt (fix rounds included).
  max_turns             INTEGER NOT NULL DEFAULT 120,
  max_minutes           INTEGER NOT NULL DEFAULT 60,
  -- Spending caps per UTC calendar month. NULL = no cap.
  monthly_cap_usd       REAL,
  monthly_cap_tokens    INTEGER,
  updated_at            INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- A project is one repository: its board, cycles, wiki and ticket keys (KEY-12).
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,                        -- ticket key prefix, unique in the workspace (tracker.ts KEY)
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'started', 'paused', 'completed', 'canceled')),
  lead_id         TEXT REFERENCES user(id) ON DELETE SET NULL,
  target_date     TEXT,
  repo_path       TEXT NOT NULL,                        -- absolute path of a git repo on the server host
  base_branch     TEXT NOT NULL,                        -- runs branch from it; approve merges into it
  setup_command   TEXT NOT NULL DEFAULT 'npm ci',       -- '' = no setup step
  test_command    TEXT NOT NULL DEFAULT 'npm test',     -- '' = no test gate (protected-path check still runs)
  protected_paths TEXT NOT NULL DEFAULT 'tests/,evals/', -- comma list, read-only to agents
  image           TEXT NOT NULL DEFAULT 'polaris-sandbox:1',
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX projects_key ON projects(workspace_id, key);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  target_date TEXT,
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- Sprints of a project. No two cycles of a project overlap (checked in tracker.ts); current/upcoming/past come from the dates.
CREATE TABLE cycles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL CHECK (ends_at >= starts_at), -- a cycle includes both ends
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, number)
);

CREATE TABLE labels (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL, -- one of tracker.ts COLORS
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
-- NOCASE folds ASCII only; tracker.ts also compares names case-insensitively in full Unicode.
CREATE UNIQUE INDEX labels_name ON labels(workspace_id, name COLLATE NOCASE);

CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Fixed at creation: the repo the ticket's branches live in. A child is in its epic's project.
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL DEFAULT 0, -- per project (the key is <project key>-<number>); 0 = assign on insert
  parent_id      TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  spec           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'running', 'review', 'done', 'failed')),
  -- An epic's runs are planner rounds (runs.role = 'planner', runs.attempt = round number); its children have parent_id = it.
  kind           TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'epic')),
  -- Ids of sibling tickets (same parent) that must be done before this one is queued.
  depends_on     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  -- Child task: the worker's "## Handoff" for its planner. Epic: the complete_epic summary, or why the epic failed.
  handoff        TEXT,
  -- When the ticket last became done or failed (NULL otherwise). A planner round sees what settled before it started.
  settled_at     INTEGER,
  -- Provider/model choice; NULL = the workspace's. test_command NULL = the project's.
  provider_id    TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model          TEXT,
  test_command   TEXT,
  -- A task that failed for good (or that triage judged too large) is replaced by a "Split:" epic. NULL = not replaced.
  escalated_to   TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  -- Wiki bootstrap and lint runs hang off one hidden ticket per project (number -1, so it takes no key).
  hidden         INTEGER NOT NULL DEFAULT 0,
  -- Linear's priority convention: 0 none, 1 urgent, 2 high, 3 medium, 4 low. The run queue starts urgent work first.
  priority       INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id    TEXT REFERENCES user(id) ON DELETE SET NULL, -- the human who owns the outcome
  estimate       INTEGER CHECK (estimate IN (1, 2, 3, 5, 8)),
  due_date       TEXT,
  milestone_id   TEXT REFERENCES milestones(id) ON DELETE SET NULL, -- a milestone of project_id
  cycle_id       TEXT REFERENCES cycles(id) ON DELETE SET NULL,     -- a cycle of project_id
  cycle_added_at INTEGER, -- when the ticket entered its cycle: added after the cycle started = scope change
  mined_class    TEXT,    -- drafted by failure mining from this class (an open one blocks mining that class again)
  cap_usd        REAL,    -- spending cap; an epic's covers its whole tree. NULL = none
  cap_tokens     INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX tickets_workspace_status ON tickets(workspace_id, status);
CREATE UNIQUE INDEX tickets_project ON tickets(project_id, number);
CREATE INDEX tickets_parent ON tickets(parent_id);
CREATE INDEX tickets_escalated_to ON tickets(escalated_to);
CREATE INDEX tickets_milestone ON tickets(milestone_id);
CREATE INDEX tickets_cycle ON tickets(cycle_id);

CREATE TRIGGER tickets_assign_number AFTER INSERT ON tickets WHEN NEW.number = 0
BEGIN
  UPDATE tickets SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE project_id = NEW.project_id) WHERE id = NEW.id;
END;

CREATE TABLE ticket_labels (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, label_id)
) WITHOUT ROWID;
CREATE INDEX ticket_labels_label ON ticket_labels(label_id);

-- Ranked search over title + spec (keys are matched in tracker.ts). External content: the text lives only in tickets.
CREATE VIRTUAL TABLE tickets_fts USING fts5(title, spec, content = 'tickets', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER tickets_fts_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, title, spec) VALUES (NEW.rowid, NEW.title, NEW.spec);
END;
CREATE TRIGGER tickets_fts_delete AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, spec) VALUES ('delete', OLD.rowid, OLD.title, OLD.spec);
END;
CREATE TRIGGER tickets_fts_update AFTER UPDATE OF title, spec ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, spec) VALUES ('delete', OLD.rowid, OLD.title, OLD.spec);
  INSERT INTO tickets_fts(rowid, title, spec) VALUES (NEW.rowid, NEW.title, NEW.spec);
END;

-- prompts holds the worker system prompt versions: v1 seeded from prompts/worker.md, one active per workspace.
CREATE TABLE prompts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL,
  eval_score   REAL,
  active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  source       TEXT NOT NULL DEFAULT 'seed', -- seed | human | proposal
  author       TEXT,                         -- user email, or the model that proposed it
  rationale    TEXT,                         -- proposals: the model's one-paragraph rationale
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, role, version)
);
CREATE UNIQUE INDEX prompts_one_active ON prompts(workspace_id, role) WHERE active = 1;

-- Self-improvement: lessons, prompt versions and eval cases/results live only in the DB: no agent tool reaches them.
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

-- A frozen task: the ticket as it was approved, the commit its run started from, and its project's repo settings at creation.
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
CREATE INDEX eval_runs_prompt ON eval_runs(prompt_id);

CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'worker', -- worker | planner | wiki
  provider_id        TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model              TEXT NOT NULL,
  worktree           TEXT,
  branch             TEXT,
  base_sha           TEXT, -- wiki runs: the project commit the maintainer reads
  attempt            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cached      INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  -- Which prompt and lessons version a run used. Eval case runs belong to the case's ticket but never touch it.
  prompt_version     INTEGER,
  lessons_version    INTEGER,
  eval_run_id        TEXT REFERENCES eval_runs(id) ON DELETE CASCADE,
  eval_case_id       TEXT,
  wiki_op            TEXT, -- wiki maintainer runs: 'ingest' | 'bootstrap' | 'lint'
  -- Why a finished worker ticket run failed (failures.ts CLASSES); NULL = passed, not a worker ticket run, or not classified yet.
  failure_class      TEXT,
  started_at         INTEGER,
  ended_at           INTEGER
);
CREATE INDEX runs_ticket ON runs(ticket_id);
CREATE INDEX runs_status ON runs(status);
CREATE INDEX runs_eval_run ON runs(eval_run_id);

-- Append-only source of truth. Dashboard, token totals, replays and evals are projections of this.
CREATE TABLE events (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
-- A run's latest event of a type (run_metrics, model_review, ...) via MAX(seq) by type.
CREATE INDEX events_run_type ON events(run_id, type);

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

-- Saved views: the board/list query (filters as the URL's params), sort and layout. shared = 0: only its owner sees it.
CREATE TABLE views (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  filters      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters)),
  sort         TEXT NOT NULL DEFAULT 'manual',
  layout       TEXT NOT NULL DEFAULT 'board' CHECK (layout IN ('board', 'list')),
  shared       INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- One "Mine failures" click: what it created (tickets, lessons) and what it skipped, as returned by POST /api/failures/mine.
CREATE TABLE minings (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  author       TEXT,          -- the user's email
  model        TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (json_valid(result)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX comments_ticket ON comments(ticket_id);

-- Workspace-wide (every member sees the same list); actor_id hides a member's own comments from their bell.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('review', 'failed', 'comment')),
  text         TEXT NOT NULL,
  actor_id     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  read_at      INTEGER
);
CREATE INDEX notifications_workspace ON notifications(workspace_id, read_at);

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

-- Chat: a member's private conversations with a project; the agent proposes tickets, the member files them.
CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- whose checkout and wiki the agent reads, where proposals are filed
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  messages     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)), -- the provider conversation, resumed by the next turn
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX chats_owner ON chats(workspace_id, user_id, updated_at);

-- What the panel shows, append-only like events: user_message, the loop's events, proposal, turn_finished.
CREATE TABLE chat_events (
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (chat_id, seq)
) WITHOUT ROWID;

CREATE TABLE chat_proposals (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL, -- P1, P2 … within the chat: how the agent refers to its proposals
  payload    TEXT NOT NULL CHECK (json_valid(payload)), -- title, spec, kind, test_command, priority, estimate
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'dismissed', 'superseded')),
  ticket_id  TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX chat_proposals_number ON chat_proposals(chat_id, number);
