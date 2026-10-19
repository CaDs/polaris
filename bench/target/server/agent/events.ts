import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import type { AgentEvent } from "./types.ts";

export type StoredEvent = AgentEvent & { run_id: string; seq: number; created_at: number };
type Listener = (e: StoredEvent) => void;

// In-process fan-out for live views (dashboard SSE). The events table stays the source of truth.
const listeners = new Map<string, Set<Listener>>();

export function subscribe(runId: string, fn: Listener) {
  const set = listeners.get(runId) ?? new Set();
  listeners.set(runId, set.add(fn));
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(runId);
  };
}

export function createRun(r: {
  ticketId: string; model: string; worktree?: string; role?: string; attempt?: number; providerId?: string | null;
  promptVersion?: number; lessonsVersion?: number | null; evalRunId?: string; evalCaseId?: string;
}) {
  const id = randomUUID();
  db.prepare("INSERT INTO runs (id, ticket_id, model, worktree, role, attempt, provider_id, prompt_version, lessons_version, eval_run_id, eval_case_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, r.ticketId, r.model, r.worktree ?? null, r.role ?? "worker", r.attempt ?? 1, r.providerId ?? null,
    r.promptVersion ?? null, r.lessonsVersion ?? null, r.evalRunId ?? null, r.evalCaseId ?? null,
  );
  return id;
}

// Returns an appender for one run: assigns seq, persists, applies the runs-row projections, notifies listeners.
// Single writer per run is assumed (the loop that owns it).
export function eventLog(runId: string) {
  let seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?").get(runId) as { n: number }).n;
  const insert = db.prepare("INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
  return (e: AgentEvent) => {
    const now = Date.now();
    insert.run(runId, ++seq, e.type, JSON.stringify(e.payload), now);
    if (e.type === "run_started") db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, runId);
    // tokens_in counts all uncached prompt tokens (incl. cache writes); tokens_cached counts cache reads.
    if (e.type === "usage")
      db.prepare("UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, tokens_cached = tokens_cached + ? WHERE id = ?").run(
        e.payload.input + e.payload.cache_write, e.payload.output, e.payload.cache_read, runId,
      );
    if (e.type === "run_finished") db.prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(e.payload.status, now, runId);
    for (const fn of listeners.get(runId) ?? []) {
      try {
        fn({ ...e, run_id: runId, seq, created_at: now } as StoredEvent);
      } catch (err) {
        console.error("event listener failed", err); // a broken viewer must not kill the run
      }
    }
  };
}
