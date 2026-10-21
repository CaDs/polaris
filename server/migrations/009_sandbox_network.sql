-- A project's sandbox network (POL-8): 'none' never, 'setup-only' during the setup command only (npm ci needs the registry;
-- no agent turn or test run has a network), 'full' always (what every project had before). Existing projects get the safe default.
ALTER TABLE projects ADD COLUMN sandbox_network TEXT NOT NULL DEFAULT 'setup-only' CHECK (sandbox_network IN ('none', 'setup-only', 'full'));
