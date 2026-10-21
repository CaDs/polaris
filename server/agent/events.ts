import { randomUUID } from "node:crypto";
import { recordUsage } from "../usage.ts";
import { db } from "../db.ts";
import type { AgentEvent, StreamEvent } from "./types.ts";

export type StoredEvent = AgentEvent & { run_id: string; seq: number; created_at: number };
// A running model call's output, for live views only (see liveStream): no seq, never stored.
export type LivePart = { kind: "text" | "reasoning"; text: string } | { kind: "tool"; id: string; name: string };
export type LiveEvent = { type: "live"; run_id: string; parts: LivePart[] };
type Listener = (e: StoredEvent | LiveEvent) => void;

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
function notify(runId: string, e: StoredEvent | LiveEvent) {
  for (const fn of listeners.get(runId) ?? []) {
    try {
      fn(e);
    } catch (err) {
      console.error("event listener failed", err); // a broken viewer must not kill the run
    }
  }
}

// The model's output while a call is still running (text and reasoning as it streams, tool calls as they start), so a
// live view isn't blank until the turn ends. Never stored: the turn's assistant_message holds all of it. Coalesced into
// one message per LIVE_MS; any stored event of the run sends what is pending first, so nothing of a turn arrives after
// its assistant_message. Nobody watching: dropped (a viewer that connects mid-turn starts from the next delta).
const LIVE_MS = 100;
const pending = new Map<string, { parts: LivePart[]; timer: ReturnType<typeof setTimeout> }>();
function flushLive(runId: string) {
  const p = pending.get(runId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(runId);
  notify(runId, { type: "live", run_id: runId, parts: p.parts });
}
export const liveStream = (runId: string) => (e: StreamEvent) => {
  if ((e.type !== "text" && e.type !== "reasoning" && e.type !== "tool_use") || !listeners.has(runId)) return;
  let p = pending.get(runId);
  if (!p) pending.set(runId, (p = { parts: [], timer: setTimeout(() => flushLive(runId), LIVE_MS) }));
  const last = p.parts.at(-1);
  if (e.type === "tool_use") p.parts.push({ kind: "tool", id: e.id, name: e.name });
  else if (last?.kind === e.type) last.text += e.text;
  else p.parts.push({ kind: e.type, text: e.text });
};

export function createRun(r: {
  ticketId: string; model: string; worktree?: string; role?: string; attempt?: number; providerId?: string | null;
  promptVersion?: number; lessonsVersion?: number | null; evalRunId?: string; evalCaseId?: string; wikiOp?: string; baseSha?: string;
}) {
  const id = randomUUID();
  db.prepare("INSERT INTO runs (id, ticket_id, model, worktree, role, attempt, provider_id, prompt_version, lessons_version, eval_run_id, eval_case_id, wiki_op, base_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, r.ticketId, r.model, r.worktree ?? null, r.role ?? "worker", r.attempt ?? 1, r.providerId ?? null,
    r.promptVersion ?? null, r.lessonsVersion ?? null, r.evalRunId ?? null, r.evalCaseId ?? null, r.wikiOp ?? null, r.baseSha ?? null,
  );
  touchRun(id);
  return id;
}

// Returns an appender for one run: assigns seq, persists, applies the runs-row projections, notifies listeners.
// Single writer per run is assumed (the loop that owns it).
export function eventLog(runId: string) {
  let seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?").get(runId) as { n: number }).n;
  const insert = db.prepare("INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");
  return (e: AgentEvent) => {
    flushLive(runId);
    const now = Date.now();
    insert.run(runId, ++seq, e.type, JSON.stringify(e.payload), now);
    if (e.type === "run_started") db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, runId);
    // Metered transport attempts have already updated projections atomically with their ledger entry.
    if (e.type === "usage" && !e.payload.metered) {
      const r = db.prepare(`SELECT r.*,t.workspace_id,p.name,p.kind,p.auth_type FROM runs r JOIN tickets t ON t.id=r.ticket_id LEFT JOIN providers p ON p.id=r.provider_id WHERE r.id=?`).get(runId) as Record<string, any>;
      recordUsage({ workspaceId: r.workspace_id, ticketId: r.ticket_id, runId, purpose: r.role },
        { id: r.provider_id, name: r.name ?? "Environment", kind: r.kind ?? "unknown", billing: r.kind === "ollama" ? "local" : r.auth_type === "oauth" ? "subscription" : "api_key" },
        r.model, { id: `event:${runId}:${seq}`, started_at: now, usage: e.payload, status: "reported", outcome: "completed" });
    }
    if (e.type === "run_finished") db.prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(e.payload.status, now, runId);
    if (e.type === "run_started" || e.type === "run_finished") touchRun(runId);
    notify(runId, { ...e, run_id: runId, seq, created_at: now } as StoredEvent);
  };
}

// Workspace channel for the live board and the notification bell: "something about this ticket changed, refetch".
// Not persisted (a reconnecting client refetches anyway); the run log above stays the only source of truth.
export type Change = { type: "ticket" | "notification" | "usage"; id: string };
const wsListeners = new Map<string, Set<(c: Change) => void>>();
export function subscribeWorkspace(ws: string, fn: (c: Change) => void) {
  const set = wsListeners.get(ws) ?? new Set();
  wsListeners.set(ws, set.add(fn));
  return () => {
    set.delete(fn);
    if (!set.size) wsListeners.delete(ws);
  };
}
// A run's status is part of its ticket's board card and its ticket page.
export function touchRun(runId: string) {
  const t = db.prepare("SELECT id, workspace_id FROM tickets WHERE id = (SELECT ticket_id FROM runs WHERE id = ?)").get(runId) as { id: string; workspace_id: string } | undefined;
  if (t) touch(t.workspace_id, { type: "ticket", id: t.id });
}
export function touch(ws: string, c: Change) {
  for (const fn of wsListeners.get(ws) ?? []) {
    try {
      fn(c);
    } catch (err) {
      console.error("workspace listener failed", err);
    }
  }
}
