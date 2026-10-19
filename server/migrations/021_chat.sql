-- M13: chat. A member's private conversations with the project; the agent proposes tickets, the member files them.
CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  messages     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)), -- the provider conversation, resumed by the next turn
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX chats_owner ON chats(workspace_id, user_id, updated_at);

-- What the panel shows, append-only like events: user_message, the loop's events, proposal, turn_finished.
CREATE TABLE chat_events (
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (chat_id, seq)
) WITHOUT ROWID;

CREATE TABLE chat_proposals (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL, -- P1, P2 … within the chat: how the agent refers to its proposals
  payload    TEXT NOT NULL CHECK (json_valid(payload)), -- title, spec, kind, test_command, priority, estimate
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'dismissed', 'superseded')),
  ticket_id  TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX chat_proposals_number ON chat_proposals(chat_id, number);
