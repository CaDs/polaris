-- M12: a separate reviewer model per workspace (null = the run's own), ticket comments, notifications.
ALTER TABLE workspace_settings ADD COLUMN review_provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE workspace_settings ADD COLUMN review_model TEXT;

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX comments_ticket ON comments(ticket_id);

-- Workspace-wide (every member sees the same list); actor_id hides a member's own comments from their bell.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('review', 'failed', 'comment')),
  text         TEXT NOT NULL,
  actor_id     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  read_at      INTEGER
);
CREATE INDEX notifications_workspace ON notifications(workspace_id, read_at);
