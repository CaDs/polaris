-- "won't do": a ticket a person closed without doing it. SQLite cannot widen a CHECK in place, so the table is rebuilt
-- (as in 003; migrate() runs with foreign keys off and checks them before committing). rowid is copied so tickets_fts,
-- whose content_rowid is tickets.rowid, keeps matching; the indexes and triggers are dropped with the old table and remade.
CREATE TABLE tickets_new (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Fixed at creation: the repo the ticket's branches live in. A child is in its epic's project.
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL DEFAULT 0, -- per project (the key is <project key>-<number>); 0 = assign on insert
  parent_id      TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  spec           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'running', 'review', 'done', 'failed', 'wont_do')),
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
INSERT INTO tickets_new (rowid, id, workspace_id, project_id, number, parent_id, title, spec, status, kind, depends_on, handoff, settled_at, provider_id, model, test_command, escalated_to, hidden, priority, assignee_id, estimate, due_date, milestone_id, cycle_id, cycle_added_at, mined_class, cap_usd, cap_tokens, created_at, updated_at)
  SELECT rowid, id, workspace_id, project_id, number, parent_id, title, spec, status, kind, depends_on, handoff, settled_at, provider_id, model, test_command, escalated_to, hidden, priority, assignee_id, estimate, due_date, milestone_id, cycle_id, cycle_added_at, mined_class, cap_usd, cap_tokens, created_at, updated_at FROM tickets;
DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;
CREATE INDEX tickets_cycle ON tickets(cycle_id);
CREATE INDEX tickets_escalated_to ON tickets(escalated_to);
CREATE INDEX tickets_milestone ON tickets(milestone_id);
CREATE INDEX tickets_parent ON tickets(parent_id);
CREATE UNIQUE INDEX tickets_project ON tickets(project_id, number);
CREATE INDEX tickets_workspace_status ON tickets(workspace_id, status);
CREATE TRIGGER tickets_assign_number AFTER INSERT ON tickets WHEN NEW.number = 0
BEGIN
  UPDATE tickets SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE project_id = NEW.project_id) WHERE id = NEW.id;
END;
CREATE TRIGGER tickets_fts_delete AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, spec) VALUES ('delete', OLD.rowid, OLD.title, OLD.spec);
END;
CREATE TRIGGER tickets_fts_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, title, spec) VALUES (NEW.rowid, NEW.title, NEW.spec);
END;
CREATE TRIGGER tickets_fts_update AFTER UPDATE OF title, spec ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, spec) VALUES ('delete', OLD.rowid, OLD.title, OLD.spec);
  INSERT INTO tickets_fts(rowid, title, spec) VALUES (NEW.rowid, NEW.title, NEW.spec);
END;
