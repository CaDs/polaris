-- M9: a task that failed for good (or that triage judged too large) is replaced by a "Split:" epic. NULL = not replaced.
ALTER TABLE tickets ADD COLUMN escalated_to TEXT REFERENCES tickets(id) ON DELETE SET NULL;
-- 1 = a task that fails its last attempt becomes a "Split:" epic whose planner breaks it into smaller children.
ALTER TABLE workspace_settings ADD COLUMN auto_split INTEGER NOT NULL DEFAULT 1;
-- What the worker model reliably finishes; the planner sizes every child to at most this.
ALTER TABLE workspace_settings ADD COLUMN child_size_hint TEXT NOT NULL DEFAULT 'at most 3 files and about 60 changed lines, finishable in 20 agent turns';
-- System One model (served by the default Ollama provider) that scores a new ticket's size before its first run. '' = off.
ALTER TABLE workspace_settings ADD COLUMN triage_model TEXT NOT NULL DEFAULT '';
