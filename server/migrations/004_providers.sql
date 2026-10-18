-- M4: per-ticket and per-workspace provider/model choice. NULL = fall through to the next level (ticket → workspace → env).
ALTER TABLE tickets ADD COLUMN provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN model TEXT;
ALTER TABLE workspace_settings ADD COLUMN default_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN default_model TEXT;
