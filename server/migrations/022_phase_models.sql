-- M14: a model per phase. Null = the phase's fallback (the planner and chat: the workspace default; wiki: the run it documents).
ALTER TABLE workspace_settings ADD COLUMN planner_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN planner_model TEXT;
ALTER TABLE workspace_settings ADD COLUMN wiki_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN wiki_model TEXT;
ALTER TABLE workspace_settings ADD COLUMN chat_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN chat_model TEXT;
