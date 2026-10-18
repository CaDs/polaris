-- M8: 1 = after the test gate, the run's own model reviews the change (and the worker fixes its findings) before a human sees it.
ALTER TABLE workspace_settings ADD COLUMN model_review INTEGER NOT NULL DEFAULT 1;
