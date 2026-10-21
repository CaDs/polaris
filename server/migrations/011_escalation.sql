-- POL-30. Escalation: a model phase whose model takes the last attempt of a ticket the default model could not finish (and a
-- budget-exhausted retry). Triage: a model phase too, on any provider; null provider = the workspace default, as before.
ALTER TABLE workspace_settings ADD COLUMN escalation_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN escalation_model TEXT;
ALTER TABLE workspace_settings ADD COLUMN triage_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
-- 1 = the model was the user's explicit choice (the ticket's own, or Retry with…): escalation never overrides it.
ALTER TABLE runs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
