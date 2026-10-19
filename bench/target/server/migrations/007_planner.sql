-- M7: planner. An epic is a ticket whose runs are planner rounds (runs.role = 'planner', runs.attempt = round number);
-- its children are tickets with parent_id = the epic (tickets.parent_id exists since 001).
ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'epic'));
-- Ids of sibling tickets (same parent) that must be done before this one is queued.
ALTER TABLE tickets ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on));
-- Child task: the worker's "## Handoff" for its planner. Epic: the complete_epic summary, or why the epic failed.
ALTER TABLE tickets ADD COLUMN handoff TEXT;
-- When the ticket last became done or failed (NULL otherwise). A planner round sees what settled before it started.
ALTER TABLE tickets ADD COLUMN settled_at INTEGER;
-- 1 = a child whose run passes the gate is merged without a human click.
ALTER TABLE workspace_settings ADD COLUMN auto_approve_children INTEGER NOT NULL DEFAULT 0;
