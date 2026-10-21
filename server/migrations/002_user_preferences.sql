-- Per-user appearance (Settings → Appearance), the same in every workspace: a palette (web/style.css) and light/dark/system.
CREATE TABLE user_preferences (
  user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  palette    TEXT NOT NULL DEFAULT 'black',
  mode       TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
