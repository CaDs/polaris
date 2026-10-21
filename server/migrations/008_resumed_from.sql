-- A run that continues an attempt interrupted by a server restart: same attempt, same worktree and branch, the
-- conversation rebuilt from the interrupted run's events (HANDOVER-TASKS 1.3). For a planner, a round re-run once.
ALTER TABLE runs ADD COLUMN resumed_from TEXT REFERENCES runs(id) ON DELETE SET NULL;
