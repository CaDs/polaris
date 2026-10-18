-- M11: Linear-style tracker (server/tracker.ts). Dates (due, target, cycle bounds) are 'YYYY-MM-DD' text; a cycle includes both ends.

CREATE TABLE labels (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL, -- one of tracker.ts COLORS
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
-- NOCASE folds ASCII only; tracker.ts also compares names case-insensitively in full Unicode.
CREATE UNIQUE INDEX labels_name ON labels(workspace_id, name COLLATE NOCASE);

CREATE TABLE ticket_labels (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, label_id)
) WITHOUT ROWID;
CREATE INDEX ticket_labels_label ON ticket_labels(label_id);

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'started', 'paused', 'completed', 'canceled')),
  lead_id      TEXT REFERENCES user(id) ON DELETE SET NULL,
  target_date  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  target_date TEXT,
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- Sprints. No two cycles of a workspace overlap (checked in tracker.ts); current/upcoming/past come from the dates.
CREATE TABLE cycles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL CHECK (ends_at >= starts_at),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, number)
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

-- Linear's priority convention: 0 none, 1 urgent, 2 high, 3 medium, 4 low. The run queue starts urgent work first.
ALTER TABLE tickets ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4);
ALTER TABLE tickets ADD COLUMN assignee_id TEXT REFERENCES user(id) ON DELETE SET NULL; -- the human who owns the outcome
ALTER TABLE tickets ADD COLUMN estimate INTEGER CHECK (estimate IN (1, 2, 3, 5, 8));
ALTER TABLE tickets ADD COLUMN due_date TEXT;
ALTER TABLE tickets ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL; -- a milestone of project_id
ALTER TABLE tickets ADD COLUMN cycle_id TEXT REFERENCES cycles(id) ON DELETE SET NULL;
-- When the ticket entered its cycle: added after the cycle started = scope change.
ALTER TABLE tickets ADD COLUMN cycle_added_at INTEGER;

-- Ranked search over title + spec (keys are matched in tracker.ts). External content: the text lives only in tickets.
CREATE VIRTUAL TABLE tickets_fts USING fts5(title, spec, content = 'tickets', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO tickets_fts(tickets_fts) VALUES ('rebuild');
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
