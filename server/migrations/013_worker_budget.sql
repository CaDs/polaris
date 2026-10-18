-- Worker run budget per attempt: turns per agent call, wall-clock minutes for the whole attempt (fix rounds included).
ALTER TABLE workspace_settings ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 120;
ALTER TABLE workspace_settings ADD COLUMN max_minutes INTEGER NOT NULL DEFAULT 60;
