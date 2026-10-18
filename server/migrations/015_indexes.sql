-- Indexes for hot lookups that scanned: the board's child/split subqueries and the epic tree (app.ts TICKETS, TREE;
-- planner.ts children), project/milestone/cycle progress (tracker.ts), the queue and restart recovery (runs.ts pump,
-- recoverOrphans), eval case runs (app.ts /api/evals) and the promotion lookup (improve.ts latestEval).
CREATE INDEX IF NOT EXISTS tickets_parent ON tickets(parent_id);
CREATE INDEX IF NOT EXISTS tickets_escalated_to ON tickets(escalated_to);
CREATE INDEX IF NOT EXISTS tickets_project ON tickets(project_id);
CREATE INDEX IF NOT EXISTS tickets_milestone ON tickets(milestone_id);
CREATE INDEX IF NOT EXISTS tickets_cycle ON tickets(cycle_id);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_eval_run ON runs(eval_run_id);
CREATE INDEX IF NOT EXISTS eval_runs_prompt ON eval_runs(prompt_id);
