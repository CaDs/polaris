import { withUsage } from "./usage.ts";
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { touch } from "./agent/events.ts";
import type { EventPayloads, Provider, ToolDef } from "./agent/types.ts";
import { ask, capLessons, currentLessons, LESSONS_MAX, runDigest, saveLessons, scrub } from "./improve.ts";
import { applyTracker, labelIds, ticketKey } from "./tracker.ts";

// M12 failure mining (see SPEC "Failure mining (M12)"): every finished worker ticket run that failed gets a failure class,
// mechanically from its events; "Mine failures" turns each class seen often enough into one draft ticket (or, when the
// cause is the harness, a lesson) with one structured call of the workspace's model. Drafts never run on their own.

export const CLASSES = {
  stuck: "the stuck monitor stopped the attempt",
  budget_turns: "the attempt ran out of turns (or tokens)",
  budget_time: "the attempt ran out of time",
  gate_tests: "the tests failed after the agent finished",
  gate_protected: "the change touched protected (read-only) paths",
  review_rejected: "the model reviewer still requested changes after its last round",
  human_rejected: "a person rejected the change in review",
  provider_error: "the model provider failed or refused",
  environment: "the setup command, the sandbox or the server failed",
  cancelled: "cancelled by a person",
  unknown: "a harness error or a reason not recognized",
};
export type FailureClass = keyof typeof CLASSES;
export const MINE_MAX = 5; // tickets per mining
export const MINED_LABEL = "mined";

// A run_finished reason → its class; undefined = not recognized.
const byReason = (s: string): FailureClass | undefined =>
  s.startsWith("stuck:") ? "stuck"
  : /^(turn|token) budget exhausted/.test(s) ? "budget_turns"
  : s.startsWith("time budget exhausted") ? "budget_time"
  : s.startsWith("modified protected path") ? "gate_protected"
  : /^`[\s\S]*` (exited with code \S+|timed out)$/.test(s) ? "gate_tests"
  : s.startsWith("model review") ? "review_rejected"
  : /^ProviderError:|^the reply was cut off/.test(s) ? "provider_error"
  : /^(UnexpectedEnvironment|Timeout):|^interrupted by server restart/.test(s) ? "environment"
  : /^(UserAborted:|cancelled)/.test(s) ? "cancelled"
  : undefined;
const ENDS = new Set<FailureClass>(["stuck", "provider_error", "environment", "cancelled"]);

// A fix round's end ("<why>; the fix round ended: <how>") is the class only when it is a stuck stop, a provider or
// environment error or a cancel; a budget running out there leaves the gate or review that started the round as the cause.
// Unrecognized reasons fall back to a stuck stop, then a failed gate, then unknown. A passed run is a failure only once a
// person rejects it. null = no failure.
export function failureClass(o: { status: string; reason?: string; gate?: EventPayloads["test_result"]; stuck?: boolean; rejected?: boolean }): FailureClass | null {
  if (o.status === "passed") return o.rejected ? "human_rejected" : null;
  if (o.status === "cancelled") return "cancelled";
  const [why, how] = (o.reason ?? "").split("; the fix round ended: ");
  const end = how === undefined ? undefined : byReason(how);
  if (end && ENDS.has(end)) return end;
  return byReason(why) ?? (o.stuck ? "stuck" : o.gate && !o.gate.passed ? (o.gate.protected.length ? "gate_protected" : "gate_tests") : "unknown");
}

// Classifies a finished run from its events and stores the class (worker ticket runs only: eval case runs measure a prompt).
export function classifyRun(runId: string) {
  const last = <T extends keyof EventPayloads>(type: T) => {
    const row = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(runId, type) as { payload: string } | undefined;
    return row && (JSON.parse(row.payload) as EventPayloads[T]);
  };
  const fin = last("run_finished");
  if (!fin) return null;
  const c = failureClass({ status: fin.status, reason: fin.reason, gate: last("test_result"), stuck: last("stuck")?.action === "stop", rejected: last("review")?.decision === "rejected" });
  db.prepare("UPDATE runs SET failure_class = ? WHERE id = ? AND role = 'worker' AND eval_run_id IS NULL").run(c, runId);
  return c;
}

// Runs from before migration 017, and runs that ended outside the pipeline (cancelled while queued, a restart), get their
// class on read. Converges: every failed or rejected run gets one.
function backfill(ws: string) {
  const ids = db.prepare(`SELECT r.id FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.role = 'worker' AND r.eval_run_id IS NULL
    AND r.failure_class IS NULL AND (r.status IN ('failed', 'cancelled') OR (r.status = 'passed'
      AND EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'review' AND json_extract(e.payload, '$.decision') = 'rejected')))`).all(ws) as { id: string }[];
  for (const { id } of ids) classifyRun(id);
}

const openMined = (ws: string, cls: string) =>
  db.prepare(`SELECT t.id, ${ticketKey()} AS key, t.status FROM tickets t
    WHERE t.workspace_id = ? AND t.mined_class = ? AND t.status NOT IN ('done', 'failed') ORDER BY t.number DESC LIMIT 1`).get(ws, cls) as { id: string; key: string; status: string } | undefined;

type Row = { run_id: string; class: FailureClass; model: string; ticket_id: string; ticket_key: string; title: string; day: string; reason: string | null };

// The classes of the last `days` days (UTC, by run end, today included), most runs first: counts, up to 3 examples (from
// different tickets first) and the open mined ticket of the class; rows = runs per day and class. Runs of tickets labelled
// `mined` never count: mining its own drafts would only feed on itself.
export function failures(ws: string, days = 30) {
  backfill(ws);
  const since = Date.parse(new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10));
  const runs = db.prepare(`SELECT r.id AS run_id, r.failure_class AS class, r.model, t.id AS ticket_id, ${ticketKey()} AS ticket_key, t.title,
      strftime('%Y-%m-%d', r.ended_at / 1000, 'unixepoch') AS day,
      CASE WHEN r.failure_class = 'human_rejected'
        THEN (SELECT 'rejected in review: ' || COALESCE(json_extract(payload, '$.note'), '(no note)') FROM events WHERE run_id = r.id AND type = 'review' ORDER BY seq DESC LIMIT 1)
        ELSE (SELECT json_extract(payload, '$.reason') FROM events WHERE run_id = r.id AND type = 'run_finished' ORDER BY seq DESC LIMIT 1) END AS reason
    FROM runs r JOIN tickets t ON t.id = r.ticket_id
    WHERE t.workspace_id = ? AND r.failure_class IS NOT NULL AND r.ended_at >= ?
      AND NOT EXISTS (SELECT 1 FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.ticket_id = t.id AND l.name = ? COLLATE NOCASE)
    ORDER BY r.ended_at DESC, r.rowid DESC`).all(ws, since, MINED_LABEL) as Row[];
  const classes = [...Map.groupBy(runs, (r) => r.class)].map(([cls, rs]) => {
    const firsts = rs.filter((r, i) => rs.findIndex((x) => x.ticket_id === r.ticket_id) === i);
    return {
      class: cls, description: CLASSES[cls], runs: rs.length, tickets: firsts.length,
      examples: [...firsts, ...rs.filter((r) => !firsts.includes(r))].slice(0, 3).map(({ run_id, ticket_id, ticket_key, title, reason, model }) => ({ run_id, ticket_id, ticket_key, title, reason, model })),
      mined: openMined(ws, cls) ?? null,
    };
  }).sort((a, b) => b.runs - a.runs || (a.class < b.class ? -1 : 1));
  const rows = [...Map.groupBy(runs, (r) => `${r.day} ${r.class}`).values()].map((rs) => ({ day: rs[0].day, class: rs[0].class, runs: rs.length }));
  return { days, classes, rows };
}
type Class = ReturnType<typeof failures>["classes"][number];

export const MINE_SYSTEM = `You turn one class of failed coding-agent runs into one improvement. The agent works tickets in a git repository inside a sandbox; when it finishes, the harness runs the repository's tests (the gate), checks read-only paths, and a model may review the change. You get a dossier: the failure class, how often it happened, digests of up to 3 example runs (outcome, tool errors, setup and gate output tails) and the agent's current lessons.

Decide where the cause is:
- repo: something in THIS repository makes agents fail this way (missing or misleading docs, flaky, slow or unclear tests, missing scripts, confusing code). Write a ticket a person reads before anyone runs it: a short imperative title, and a spec saying what to change in this repository (tests, docs, code), where, and how to check that this class stops happening.
- harness: the cause is the harness or the model, not the repository (budget, sandbox, provider, tool use). Write one short imperative lesson for the agent instead of a ticket.

Use only what the dossier shows; do not invent files it does not name. Never include secrets. Call submit_mined_ticket exactly once.`;

const SUBMIT: ToolDef = {
  name: "submit_mined_ticket",
  description: "Submit your conclusion about this failure class. Call it exactly once.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["repo", "harness"], description: "repo: a change to this repository stops the class; harness: the cause is the harness or the model" },
      title: { type: "string", description: "repo: the ticket title, imperative, at most 100 chars" },
      spec: { type: "string", description: "repo: what to change in this repository (tests, docs, code), where, and how to check it" },
      lesson: { type: "string", description: "harness: one short imperative bullet for the agent's lessons" },
      confidence: { type: "number", description: "0 to 1: how likely this stops the class" },
    },
    required: ["verdict", "confidence"],
  },
};

function dossier(ws: string, c: Class, days: number) {
  return [
    `<class>${c.class}: ${c.description}</class>`,
    `<count>${c.runs} runs on ${c.tickets} ticket${c.tickets === 1 ? "" : "s"} in the last ${days} days</count>`,
    `<examples>\n${c.examples.map((e) => `## ${e.ticket_key} ${e.title}\n${c.class === "human_rejected" ? `${e.reason}\n` : ""}${runDigest(e.run_id)}`).join("\n\n")}\n</examples>`,
    `<lessons>\n${currentLessons(ws)?.body || "(none yet)"}\n</lessons>`,
  ].join("\n\n");
}

const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`its ${what} is empty`);
  return v.trim().slice(0, max);
};

// One structured call: the dossier in, submit_mined_ticket's input out (validated).
async function verdict(o: { workspaceId: string; provider: Provider; model: string }, prompt: string) {
  const r = await withUsage({ workspaceId: o.workspaceId, purpose: "mining", background: true }, () => ask(o.provider, o.model, MINE_SYSTEM, scrub(prompt), 4096, 120_000, undefined, [SUBMIT]));
  const call = r.content.find((b) => b.type === "tool_use" && b.name === SUBMIT.name);
  if (call?.type !== "tool_use") throw new Error(`it did not call ${SUBMIT.name}`);
  const i = call.input;
  const confidence = Math.min(1, Math.max(0, Number(i.confidence) || 0));
  if (i.verdict === "harness") return { verdict: "harness" as const, lesson: scrub(text(i.lesson, "lesson", 500)).replace(/^[-*]\s*/, ""), confidence };
  if (i.verdict !== "repo") throw new Error('its verdict is not "repo" or "harness"');
  return { verdict: "repo" as const, title: scrub(text(i.title, "title", 200)), spec: scrub(text(i.spec, "spec", 15_000)), confidence };
}

export type Mining = {
  id: string;
  created: { class: string; ticket_id: string; key: string; title: string; confidence: number }[];
  lessons: { class: string; version: number; lesson: string; confidence: number }[];
  skipped: { class: string; why: string }[];
};

// "Mine failures": one call per class with ≥ 2 runs in the window and no open mined ticket (cancelled runs are a person's
// choice, never mined); at most MINE_MAX tickets. Tickets are todo, labelled `mined`, with the evidence under the model's
// spec; they never run on their own. A harness verdict appends its lesson instead (as a reflection on the newest example
// run). The result is stored in minings and returned.
// ponytail: one model call per class in a row (≤ 11, each ≤ 2 min); concurrent clicks are deduped only per class.
export async function mine(o: { workspaceId: string; provider: Provider; model: string; author?: string; days?: number }): Promise<Mining> {
  const ws = o.workspaceId;
  const days = o.days ?? 30;
  const out: Omit<Mining, "id"> = { created: [], lessons: [], skipped: [] };
  for (const c of failures(ws, days).classes) {
    const skip = (why: string) => void out.skipped.push({ class: c.class, why });
    if (c.class === "cancelled") skip("cancelled by a person: nothing to fix");
    else if (c.runs < 2) skip("only 1 run");
    else if (c.mined) skip(`${c.mined.key} is still open`);
    else if (out.created.length >= MINE_MAX) skip(`at most ${MINE_MAX} tickets per mining`);
    else
      try {
        const v = await verdict(o, dossier(ws, c, days));
        const evidence = c.examples.map((e) => `- ${e.ticket_key} (${e.model}): ${e.reason ?? "no reason"}`).join("\n");
        if (v.verdict === "harness") {
          const cur = currentLessons(ws)?.body ?? "";
          const bullet = `- ${v.lesson}`;
          if (cur.split("\n").includes(bullet)) skip("the model's lesson is already in the lessons");
          else if (cur.length + bullet.length + 1 > LESSONS_MAX) skip(`harness, but the lessons are full (${LESSONS_MAX} chars): ${v.lesson}`);
          else {
            const l = saveLessons(ws, capLessons(cur ? `${cur}\n${bullet}` : bullet), { source: "reflection", run_id: c.examples[0].run_id });
            out.lessons.push({ class: c.class, version: l.version, lesson: v.lesson, confidence: v.confidence });
          }
        } else if (openMined(ws, c.class)) skip("a mined ticket was created meanwhile");
        else {
          const id = randomUUID();
          const spec = `${v.spec}\n\n## Mined from failures\n\nClass \`${c.class}\` (${c.description}): ${c.runs} runs on ${c.tickets} tickets in the last ${days} days. Model confidence ${v.confidence.toFixed(2)}. Examples:\n${evidence}`;
          // In the project of the newest example: the repository the failures happened in.
          db.prepare("INSERT INTO tickets (id, workspace_id, project_id, title, spec, mined_class) SELECT ?, ?, project_id, ?, ?, ? FROM tickets WHERE id = ?").run(id, ws, v.title, spec, c.class, c.examples[0].ticket_id);
          applyTracker(id, { label_ids: labelIds(ws, [MINED_LABEL]) });
          touch(ws, { type: "ticket", id });
          const t = db.prepare(`SELECT ${ticketKey()} AS key FROM tickets t WHERE t.id = ?`).get(id) as { key: string };
          out.created.push({ class: c.class, ticket_id: id, key: t.key, title: v.title, confidence: v.confidence });
        }
      } catch (e) {
        skip(`mining failed: ${(e as Error).message}`);
      }
  }
  const id = randomUUID();
  db.prepare("INSERT INTO minings (id, workspace_id, author, model, result) VALUES (?, ?, ?, ?, ?)").run(id, ws, o.author ?? null, o.model, JSON.stringify(out));
  return { id, ...out };
}
