-- The worker's token budget per attempt, a workspace setting (it was a fixed 2M). It counts uncached input, cache writes
-- and output, so a provider whose cache misses spends it fast (HANDOVER-TASKS 0.5).
ALTER TABLE workspace_settings ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 2000000;
