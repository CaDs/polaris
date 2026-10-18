-- M10: per-project wiki (server/wiki.ts). 1 = runs get a snapshot of the wiki and approved work is ingested into it.
ALTER TABLE workspace_settings ADD COLUMN wiki INTEGER NOT NULL DEFAULT 1;
-- Wiki maintainer runs (runs.role = 'wiki'): 'ingest' | 'bootstrap' | 'lint'. base_sha = the project commit the maintainer reads.
ALTER TABLE runs ADD COLUMN wiki_op TEXT;
-- Bootstrap and lint runs belong to no ticket: they hang off one hidden ticket per workspace (number -1, so it takes no key).
ALTER TABLE tickets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
