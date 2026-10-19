-- M12 failure mining (server/failures.ts). failure_class: why a finished worker ticket run failed (failures.ts CLASSES);
-- NULL = passed, not a worker ticket run, or not classified yet: runs from before this migration are classified by the
-- one classifier in failures.ts on the first GET /api/failures (no second copy of its rules in SQL).
ALTER TABLE runs ADD COLUMN failure_class TEXT;
-- A ticket drafted by failure mining: the class it was mined from (provenance badge; an open one blocks mining that class again).
ALTER TABLE tickets ADD COLUMN mined_class TEXT;

-- One "Mine failures" click: what it created (tickets, lessons) and what it skipped, as returned by POST /api/failures/mine.
CREATE TABLE minings (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  author       TEXT,          -- the user's email
  model        TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (json_valid(result)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
