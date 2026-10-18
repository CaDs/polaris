-- Per-workspace sequential ticket numbers (UI shows <SLUG>-<number>). 0 means "assign on insert".
ALTER TABLE tickets ADD COLUMN number INTEGER NOT NULL DEFAULT 0;

UPDATE tickets SET number = (
  SELECT COUNT(*) FROM tickets o
  WHERE o.workspace_id = tickets.workspace_id AND (o.created_at, o.rowid) <= (tickets.created_at, tickets.rowid)
);

CREATE UNIQUE INDEX tickets_workspace_number ON tickets(workspace_id, number);

CREATE TRIGGER tickets_assign_number AFTER INSERT ON tickets WHEN NEW.number = 0
BEGIN
  UPDATE tickets SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE workspace_id = NEW.workspace_id)
  WHERE id = NEW.id;
END;
