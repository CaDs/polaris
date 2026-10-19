import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import "../server/auth.ts";
import { db, migrate } from "../server/db.ts";

test("migrations apply on a fresh DB; the hot queries use their indexes", () => {
  migrate();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, readdirSync(new URL("../server/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).length);
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("x") as { detail: string }[]).map((r) => r.detail).join("\n");
  for (const [sql, index] of [
    ["SELECT COUNT(*) FROM tickets c WHERE c.parent_id = ?", "tickets_parent"],
    ["SELECT id FROM tickets s WHERE s.escalated_to = ?", "tickets_escalated_to"],
    ["SELECT id FROM tickets t WHERE t.project_id = ?", "tickets_project"],
    ["SELECT id FROM tickets t WHERE t.milestone_id = ?", "tickets_milestone"],
    ["SELECT id FROM tickets WHERE cycle_id = ?", "tickets_cycle"],
    ["SELECT id FROM runs r WHERE r.status = ?", "runs_status"],
    ["SELECT id FROM runs r WHERE r.eval_run_id = ?", "runs_eval_run"],
    ["SELECT * FROM eval_runs WHERE prompt_id = ?", "eval_runs_prompt"],
    ["SELECT MAX(seq) FROM events WHERE run_id = ? AND type = 'run_metrics'", "events_run_type"],
  ]) assert.match(plan(sql), new RegExp(`USING (COVERING )?INDEX ${index}\\b`), sql);
});
