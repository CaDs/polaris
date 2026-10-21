import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.ts";
import { metered, withUsage } from "./usage.ts";
import { parseProtected, truncate } from "./agent/tools.ts";
import type { EventPayloads, Provider, ToolDef } from "./agent/types.ts";
import { addDetached, removeWorktree } from "./git.ts";
import { COMMAND_TIMEOUT, dataDir, openSandbox, type Sandbox } from "./sandbox.ts";
import { ticketKey } from "./tracker.ts";

// M6 self-improvement, three loops (see SPEC "Self-improvement (M6)"):
// 1. reflection after a run series → a new lessons version (applies to the next run at once; easy to restore);
// 2. eval cases = frozen approved tickets that fail at their base commit; eval runs score a prompt version on them;
// 3. prompt versions: proposed by a no-tools call or written by a human, promoted only by a human click and only when
//    their eval beats the active version's on the same case set (the one exception: a new built-in replacing an
//    unmodified built-in, see activePrompt).
// Everything here lives in the DB. Agents have no tool that reads or writes it; reflection/proposal calls get no tools.

export const LESSONS_MAX = 8000; // chars, ≈ 2,000 tokens
export const PROMPT_MAX = 20_000;
const SEED = readFileSync(new URL("./agent/prompts/worker.md", import.meta.url), "utf8");

type Lessons = { id: string; workspace_id: string; version: number; body: string; source: string; run_id: string | null; author: string | null; restored_from: number | null; created_at: number };
export type Prompt = { id: string; workspace_id: string; version: number; body: string; active: number; source: string; author: string | null; rationale: string | null; created_at: number };
type Final = { status: string; reason?: string; turns: number };

export const gateFailure = (r: EventPayloads["test_result"]) =>
  r.protected.length ? `modified protected path ${r.protected.join(", ")}` : `\`${r.command}\` ${r.timed_out ? "timed out" : `exited with code ${r.code}`}`;

// --- lessons: the latest version is the active one ---

export const currentLessons = (ws: string) => db.prepare("SELECT * FROM lessons WHERE workspace_id = ? ORDER BY version DESC LIMIT 1").get(ws) as Lessons | undefined;
export const lessonsAt = (ws: string, version: number | null) =>
  version ? (db.prepare("SELECT * FROM lessons WHERE workspace_id = ? AND version = ?").get(ws, version) as Lessons | undefined) : undefined;

export function saveLessons(ws: string, body: string, from: { source: "reflection" | "human" | "restore"; run_id?: string; author?: string; restored_from?: number }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO lessons (id, workspace_id, version, body, source, run_id, author, restored_from)
    SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ? FROM lessons WHERE workspace_id = ?`).run(
    id, ws, body, from.source, from.run_id ?? null, from.author ?? null, from.restored_from ?? null, ws,
  );
  return db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Lessons;
}

// --- prompt versions (role 'worker') ---

// The active worker prompt; v1 is seeded from prompts/worker.md the first time a workspace needs one.
// When worker.md changes, a workspace without a seed version of the new text gets one (the next version, source seed). It
// becomes active only when the active version is itself a seed (rows are never edited, so that is unmodified built-in
// text); a workspace on an edited or proposed version keeps it, and the new built-in waits as a candidate with a note.
// ponytail: someone who promoted an old seed back on purpose is moved to the new built-in once; the old one stays in history.
export function activePrompt(ws: string): Prompt {
  db.prepare(`INSERT INTO prompts (id, workspace_id, role, version, body, active) SELECT ?, ?, 'worker', 1, ?, 1
    WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE workspace_id = ? AND role = 'worker')`).run(randomUUID(), ws, SEED, ws);
  const active = db.prepare("SELECT * FROM prompts WHERE workspace_id = ? AND role = 'worker' AND active = 1").get(ws) as Prompt;
  if (active.body === SEED || db.prepare("SELECT 1 FROM prompts WHERE workspace_id = ? AND role = 'worker' AND source = 'seed' AND body = ?").get(ws, SEED)) return active;
  const stock = active.source === "seed";
  const id = randomUUID();
  const note = stock
    ? `prompts/worker.md changed. The active v${active.version} was the unmodified built-in, so this version replaced it (v${active.version} stays in history).`
    : `prompts/worker.md changed. Not activated: the active v${active.version} is an edited or proposed version. Run an eval and promote this one if it scores better.`;
  db.prepare(`INSERT INTO prompts (id, workspace_id, role, version, body, source, rationale)
    SELECT ?, ?, 'worker', MAX(version) + 1, ?, 'seed', ? FROM prompts WHERE workspace_id = ? AND role = 'worker'`).run(id, ws, SEED, note, ws);
  const fresh = db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as Prompt;
  if (!stock) return active;
  promote(ws, fresh);
  return { ...fresh, active: 1 };
}
export const promptAt = (ws: string, version: number) =>
  db.prepare("SELECT * FROM prompts WHERE workspace_id = ? AND role = 'worker' AND version = ?").get(ws, version) as Prompt | undefined;
export const promptIn = (ws: string, id: string) => db.prepare("SELECT * FROM prompts WHERE workspace_id = ? AND role = 'worker' AND id = ?").get(ws, id) as Prompt | undefined;

// New versions are always inactive: only promote() activates one.
export function addPrompt(ws: string, body: string, from: { source: "human" | "proposal"; author: string; rationale?: string }) {
  activePrompt(ws);
  const id = randomUUID();
  db.prepare(`INSERT INTO prompts (id, workspace_id, role, version, body, source, author, rationale)
    SELECT ?, ?, 'worker', MAX(version) + 1, ?, ?, ?, ? FROM prompts WHERE workspace_id = ? AND role = 'worker'`).run(
    id, ws, body, from.source, from.author, from.rationale ?? null, ws,
  );
  return db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as Prompt;
}

// --- digests: what reflection and proposals see instead of transcripts ---

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ticketOf = (runId: string) =>
  db.prepare(`SELECT ${ticketKey()} AS key, t.title FROM runs r JOIN tickets t ON t.id = r.ticket_id
    WHERE r.id = ?`).get(runId) as { key: string; title: string };

// One run from its event log: outcome, counts, tool errors (name + class + first line), setup/gate failures with output tails.
// final: the outcome when run_finished is not logged yet (reflection runs just before it).
export function runDigest(runId: string, final?: Final) {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, any>;
  const ev = (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));
  const fin: Final = final ?? ev.find((e) => e.type === "run_finished")?.p ?? { status: r.status, turns: 0 };
  const names = new Map(ev.filter((e) => e.type === "tool_call").map((e) => [e.p.id, e.p.name]));
  const out = [`Attempt ${r.attempt}${r.eval_run_id ? " (eval)" : ""}: ${fin.status}${fin.reason && fin.reason !== fin.status ? ` (${fin.reason})` : ""}, ${fin.turns} turns, ${r.tokens_in + r.tokens_out} tokens, model ${r.model}`];
  const errors = ev.filter((e) => e.type === "tool_result" && e.p.is_error);
  for (const e of errors.slice(0, 10)) out.push(`- tool ${names.get(e.p.tool_use_id) ?? "?"} error: ${short(e.p.content.split("\n")[0], 200)}`);
  if (errors.length > 10) out.push(`- … ${errors.length - 10} more tool errors`);
  for (const e of ev) {
    if (e.type === "error" && !e.p.retrying) out.push(`- ${e.p.kind}: ${short(e.p.message, 300)}`);
    if (e.type === "setup" && e.p.step === "command" && e.p.code !== 0) out.push(`- setup \`${e.p.command}\` exited with ${e.p.code}:\n${truncate(e.p.output, 1000, "tail")}`);
    if (e.type === "test_result" && !e.p.passed) out.push(`- gate failed: ${gateFailure(e.p)}\n${truncate(e.p.output, 1000, "tail")}`);
  }
  return out.join("\n");
}

// The series that ended with runId: every attempt of its ticket since the latest attempt 1, plus the reviewer's note.
export function seriesDigest(runId: string, final?: Final, note?: string) {
  const r = db.prepare("SELECT rowid AS n, ticket_id FROM runs WHERE id = ?").get(runId) as { n: number; ticket_id: string };
  const ids = (db.prepare(`SELECT id FROM runs WHERE ticket_id = ? AND eval_run_id IS NULL AND rowid <= ?
    AND rowid >= (SELECT MAX(rowid) FROM runs WHERE ticket_id = ? AND attempt = 1 AND eval_run_id IS NULL AND rowid <= ?) ORDER BY rowid`).all(r.ticket_id, r.n, r.ticket_id, r.n) as { id: string }[]).map((x) => x.id);
  const t = ticketOf(runId);
  const status = note ? "rejected" : (final?.status ?? (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status);
  return [
    `Ticket: ${t.key} ${t.title}`,
    `Final status: ${status} after ${ids.length} attempt${ids.length === 1 ? "" : "s"}`,
    ...(note ? [`Reviewer note: ${note}`] : []),
    "",
    ...ids.map((id) => runDigest(id, id === runId ? final : undefined)),
  ].join("\n");
}

// --- the two no-tools meta calls ---

export const REFLECT_SYSTEM = `You maintain LESSONS: a short document of what a coding agent has learned about one repository and the harness it runs in (sandbox, test gate, tools). After each finished ticket you get the current lessons and a compact digest of the run.

Reply with the full updated lessons document and nothing else. Rules:
- Short imperative bullets about THIS repository and THIS harness ("Run one test file with node --test test/<name>.test.ts", "Read tests/ first"). Facts the first message already states (test command, read-only paths, budget, git) need no bullet. No prose, no headings needed.
- Merge new insights into the existing bullets, deduplicate, and remove bullets the digest shows to be wrong.
- Keep only what will help future tickets; skip one-off details of this ticket.
- The digest is followed by <tools>, the exact tool names the agent has. Name tools exactly as listed there, and never mention a tool that is not listed (do not invent tools or call a missing capability a missing tool).
- Never include secrets, API keys, tokens, passwords or personal data.
- Stay under ${LESSONS_MAX} characters (about 2,000 tokens): drop the least useful bullets to fit.
- If nothing new was learned, return the current document unchanged.`;

const PROPOSE_SYSTEM = `You improve the system prompt of a coding agent that works tickets in a git repository inside a sandbox, gated by the repository's tests. You get its current system prompt, the lessons learned so far, and digests of recent failed runs (including eval runs).

Write a revised full system prompt that would avoid such failures in general, not just for these tickets. Keep what works, keep it concise, and keep repository-specific facts out (those belong in the lessons). Never include secrets. Stay under ${PROMPT_MAX} characters.

Answer exactly in this format:
<rationale>One paragraph: what you changed and why.</rationale>
<prompt>
The full revised system prompt.
</prompt>`;

import { scrub } from "./egress.ts";
export { scrub }; // ponytail: common key shapes only; the prompt forbids the rest

// Over the cap: cut at the last line break before it.
export function capLessons(s: string) {
  s = s.trim();
  if (s.length <= LESSONS_MAX) return s;
  const cut = s.slice(0, LESSONS_MAX);
  return cut.slice(0, cut.lastIndexOf("\n") > 0 ? cut.lastIndexOf("\n") : LESSONS_MAX).trimEnd();
}

// timeoutMs: a hung reflection must not hold its run's queue slot for long. tools are only declared, never run (failure
// mining's submit tool): the caller reads the call from content.
export async function ask(provider: Provider, model: string, system: string, text: string, maxTokens: number, timeoutMs: number, signal?: AbortSignal, tools: ToolDef[] = []) {
  const res = await metered(provider, { name: "Custom provider", kind: "unknown", billing: "unknown" }).stream(
    { system: [{ type: "text", text: system }], messages: [{ role: "user", content: [{ type: "text", text }] }], tools, model, maxTokens,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) },
    () => {},
  );
  return { text: res.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim(), usage: res.usage, content: res.message.content };
}

// Reflections of one workspace run one at a time, each on the then-current lessons, so none overwrites another.
const chains = new Map<string, Promise<unknown>>();

// A fresh one-message conversation with no tools: current lessons + digest in, the full updated document out → new version.
export function reflect(o: { workspaceId: string; runId: string; digest: string; tools?: string[]; provider: Provider; model: string; signal?: AbortSignal }): Promise<EventPayloads["reflection"]> {
  const job = (chains.get(o.workspaceId) ?? Promise.resolve()).then(async () => {
    const cur = currentLessons(o.workspaceId);
    const r = await withUsage({ workspaceId: o.workspaceId, runId: o.runId, ticketId: (db.prepare("SELECT ticket_id FROM runs WHERE id=?").get(o.runId) as { ticket_id: string } | undefined)?.ticket_id, purpose: "reflection", background: true }, () => ask(o.provider, o.model, REFLECT_SYSTEM, `<lessons>\n${cur?.body || "(none yet)"}\n</lessons>\n\n<digest>\n${scrub(o.digest)}\n</digest>${o.tools ? `\n\n<tools>\n${o.tools.join(", ")}\n</tools>` : ""}`, 4096, 120_000, o.signal));
    const body = capLessons(scrub(r.text.replace(/^```\w*\n([\s\S]*?)\n```$/, "$1")));
    if (!body) throw new Error("the model returned no lessons");
    if (cur?.body === body) return { lessons_id: cur.id, version: cur.version, chars: body.length, unchanged: true, usage: r.usage, accounted: true };
    const v = saveLessons(o.workspaceId, body, { source: "reflection", run_id: o.runId });
    return { lessons_id: v.id, version: v.version, chars: body.length, unchanged: false, usage: r.usage, accounted: true };
  });
  chains.set(o.workspaceId, job.catch(() => {}));
  return job.catch((e) => ({ error: `reflection failed: ${(e as Error).message}` }));
}

// The recursive step: current prompt + lessons + recent failures in, a revised prompt + rationale out → new inactive version.
export async function propose(o: { workspaceId: string; provider: Provider; model: string }) {
  const cur = activePrompt(o.workspaceId);
  const failed = db.prepare(`SELECT r.id FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.status = 'failed'
    ORDER BY r.rowid DESC LIMIT 5`).all(o.workspaceId) as { id: string }[];
  const failures = failed.map(({ id }) => {
    const t = ticketOf(id);
    return `## ${t.key} ${t.title}\n${runDigest(id)}`;
  });
  const r = await withUsage({ workspaceId: o.workspaceId, purpose: "proposal", background: true }, () => ask(o.provider, o.model, PROPOSE_SYSTEM, [
    `<current_prompt>\n${cur.body}\n</current_prompt>`,
    `<lessons>\n${currentLessons(o.workspaceId)?.body || "(none yet)"}\n</lessons>`,
    `<failures>\n${scrub(failures.join("\n\n")) || "(no failed runs yet)"}\n</failures>`,
  ].join("\n\n"), 16_000, 600_000));
  const body = /<prompt>([\s\S]*?)<\/prompt>/.exec(r.text)?.[1].trim();
  if (!body) throw new Error("the model did not answer with a <prompt>…</prompt> block");
  if (body.length > PROMPT_MAX) throw new Error(`the proposed prompt is longer than ${PROMPT_MAX} chars`);
  const rationale = /<rationale>([\s\S]*?)<\/rationale>/.exec(r.text)?.[1].trim() ?? "";
  return addPrompt(o.workspaceId, body, { source: "proposal", author: o.model, rationale: short(rationale, 2000) });
}

// --- evals ---

export type EvalCase = {
  id: string; workspace_id: string; ticket_id: string; title: string; spec: string; repo_path: string; base_sha: string;
  setup_command: string; test_command: string; protected_paths: string; image: string; created_at: number;
};
type EvalRun = {
  id: string; workspace_id: string; prompt_id: string; prompt_version: number; lessons_version: number | null; case_ids: string; model: string;
  status: "running" | "done"; passed: number | null; total: number | null; mean_tokens: number | null; started_at: number; ended_at: number | null;
};

// The workspace's current case set, as stored in eval_runs.case_ids (sorted ids).
export const caseSet = (ws: string) => JSON.stringify((db.prepare("SELECT id FROM eval_cases WHERE workspace_id = ? ORDER BY id").all(ws) as { id: string }[]).map((c) => c.id));

// A case must FAIL at base_sha in a clean worktree + sandbox: one that passes without the change can't tell an agent that
// solved it from one that did nothing. Returns the reason it is rejected, or undefined.
export async function validateCase(c: Omit<EvalCase, "id" | "workspace_id" | "ticket_id" | "title" | "spec" | "created_at">) {
  if (!c.test_command.trim()) return "The workspace has no test command, so an eval case can't be scored.";
  const id = `eval-check-${randomUUID()}`;
  const wt = join(dataDir(), "worktrees", id);
  let sandbox: Sandbox | undefined;
  try {
    mkdirSync(join(dataDir(), "worktrees"), { recursive: true });
    await addDetached(c.repo_path, c.base_sha, wt);
    sandbox = await openSandbox(id, wt, parseProtected(c.protected_paths), c.image);
    const sh = (command: string) => sandbox!.exec(command, { cwd: wt, timeoutMs: COMMAND_TIMEOUT });
    if (c.setup_command.trim()) {
      const s = await sh(c.setup_command);
      if (s.code !== 0) return `The setup command fails at ${c.base_sha.slice(0, 8)} (exit ${s.code}), so the case can't run.`;
    }
    const t = await sh(c.test_command);
    if (t.code === 0)
      return `\`${c.test_command}\` already passes at ${c.base_sha.slice(0, 8)} (the commit the ticket's run started from), so this case can't tell an agent that solved it from one that did nothing.`;
  } finally {
    await sandbox?.close();
    await removeWorktree(c.repo_path, wt, null, dataDir());
  }
}

// A finished eval case run → its result; the eval run is done (with score and mean tokens) once every case has one.
export function recordEvalResult(runId: string, passed: boolean, turns: number) {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, any>;
  db.prepare("INSERT OR REPLACE INTO eval_results (eval_run_id, case_id, run_id, passed, turns, tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    r.eval_run_id, r.eval_case_id, runId, passed ? 1 : 0, turns, r.tokens_in + r.tokens_out, r.cost_usd, r.started_at && r.ended_at ? r.ended_at - r.started_at : 0,
  );
  const of = "FROM eval_results WHERE eval_run_id = eval_runs.id";
  db.prepare(`UPDATE eval_runs SET status = 'done', ended_at = ?, passed = (SELECT SUM(passed) ${of}), total = (SELECT COUNT(*) ${of}), mean_tokens = (SELECT AVG(tokens) ${of})
    WHERE id = ? AND (SELECT COUNT(*) ${of}) >= json_array_length(case_ids)`).run(Date.now(), r.eval_run_id);
}

// A cancelled case run is booked as failed, so an eval with one says nothing about its prompt: it never counts.
const latestEval = (promptId: string, set: string, model?: string) =>
  db.prepare(`SELECT * FROM eval_runs e WHERE prompt_id = ? AND case_ids = ? AND status = 'done' AND (? IS NULL OR model = ?)
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.eval_run_id = e.id AND r.status = 'cancelled') ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(promptId, set, model ?? null, model ?? null) as EvalRun | undefined;

// Promotion rule: the candidate's latest completed eval on the CURRENT case set must beat the active version's latest on
// the same set with the same model: strictly more cases passed, or as many with at least 10% fewer mean tokens. Always a
// human click; there is deliberately no auto-promotion (see SPEC).
export function promotion(ws: string, p: Prompt): { ok: boolean; reason: string } {
  const set = caseSet(ws);
  const n = (JSON.parse(set) as string[]).length;
  const active = activePrompt(ws);
  if (p.id === active.id) return { ok: false, reason: "This is the active version." };
  if (!n) return { ok: false, reason: "No eval cases yet: add an approved ticket to evals first." };
  const c = latestEval(p.id, set);
  if (!c) return { ok: false, reason: `Run an eval of v${p.version} on the current ${n} case${n === 1 ? "" : "s"} first.` };
  const a = latestEval(active.id, set, c.model);
  if (!a) return { ok: false, reason: `The active v${active.version} has no eval with ${c.model} on the current case set: run one to compare against.` };
  const score = (e: EvalRun, v: number) => `v${v} passed ${e.passed}/${n} with ${Math.round(e.mean_tokens ?? 0)} mean tokens`;
  const vs = `${score(c, p.version)}; active ${score(a, active.version)}.`;
  if (c.passed! > a.passed!) return { ok: true, reason: `Higher pass rate: ${vs}` };
  if (c.passed === a.passed && a.mean_tokens! > 0 && c.mean_tokens! <= 0.9 * a.mean_tokens!) return { ok: true, reason: `Same pass rate with ≥10% fewer tokens: ${vs}` };
  return { ok: false, reason: `Not better: ${vs} Promotion needs a higher pass rate, or the same with at least 10% fewer mean tokens.` };
}

export function promote(ws: string, p: Prompt) {
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE prompts SET active = 0 WHERE workspace_id = ? AND role = 'worker'").run(ws);
    db.prepare("UPDATE prompts SET active = 1 WHERE id = ?").run(p.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
