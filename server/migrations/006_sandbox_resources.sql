-- A project's sandbox size (HANDOVER-TASKS 0.3). node --test runs test files in parallel up to the CPU count, so two CPUs
-- ran Polaris's own suite one file at a time: 83 s on the host, 404 s in the sandbox.
ALTER TABLE projects ADD COLUMN sandbox_cpus INTEGER NOT NULL DEFAULT 4;
ALTER TABLE projects ADD COLUMN sandbox_memory_gb INTEGER NOT NULL DEFAULT 4;
