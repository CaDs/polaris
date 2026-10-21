-- M17: workspace skills, made in Polaris (Settings → Skills, or the chat composer's Skills menu). Every run writes them to
-- .polaris/workspace-skills/ in its worktree (git-excluded, read-only to agents), next to the repo's own .polaris/skills/.
CREATE TABLE skills (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  phases       TEXT NOT NULL DEFAULT '["worker","planner"]' CHECK (json_valid(phases)), -- which agents are offered it
  author       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX skills_name ON skills(workspace_id, name COLLATE NOCASE);
