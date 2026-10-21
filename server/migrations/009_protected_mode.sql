-- How a project's protected paths bind agents (POL-29). read_only: nothing under them changes. add_only: files that existed at
-- the run's base commit are untouchable but agents may add new ones (regression tests). Existing projects and eval cases keep
-- today's read_only; new projects are made add_only by the API (tracker.ts PROJECT_DEFAULTS).
ALTER TABLE projects ADD COLUMN protected_mode TEXT NOT NULL DEFAULT 'read_only' CHECK (protected_mode IN ('add_only', 'read_only'));
ALTER TABLE eval_cases ADD COLUMN protected_mode TEXT NOT NULL DEFAULT 'read_only' CHECK (protected_mode IN ('add_only', 'read_only'));
