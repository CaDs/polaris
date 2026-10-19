import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { db } from "./db.ts";
import { createRun, eventLog } from "./agent/events.ts";
import { listSkills, skillsText, type Skill } from "./agent/context.ts";
import { runAgent } from "./agent/loop.ts";
import { anthropic, DEFAULT_MODEL } from "./agent/providers/anthropic.ts";
import { demoProvider } from "./agent/providers/demo.ts";
import { parseProtected, tools, toolsFor, wikiTools, type ExecResult } from "./agent/tools.ts";
import { AgentError, type AgentEvent, type EventPayloads, type RunStatus, type Usage } from "./agent/types.ts";
import { adapterFor, CONTEXT_WINDOW, OLLAMA_URL, ollamaWindow, providerById } from "./providers.ts";
import { addDetached, addWorktree, changedLines, commitAll, excludeScratch, git, inspectRepo, merge, protectedChanges, removeWorktree, restore, scratchPathspec, snapshot } from "./git.ts";
import { activePrompt, currentLessons, gateFailure, lessonsAt, promptAt, recordEvalResult, reflect, seriesDigest, type EvalCase, type Prompt } from "./improve.ts";
import { COMMAND_TIMEOUT, dataDir, openSandbox, removeStaleContainers, SANDBOX_IMAGE, type Sandbox } from "./sandbox.ts";
import { findingsText, MAX_REVIEW_ROUNDS, REVIEWER_PROMPT, reviewerTools, reviewTask, type Review } from "./review.ts";
import { finishCopy, headOf, materialize, openCopy, pageList, WIKI_PROMPT, WIKI_PROTECTED, wikiSection, wikiSerial, wikiTampered, wikiTask, type Finished } from "./wiki.ts";
import { ticketKey, today, trackerHeader } from "./tracker.ts";
import { childrenOf, finalText, handoffRequest, handoffText, MAX_CHILDREN, MAX_ROUNDS, openChildren, OWN_RUNS, PLANNER_PROMPT, plannerTask, plannerTools, type Outcome } from "./planner.ts";

// USD per million tokens, keyed by model. Unknown price → cost_usd stays 0 (UI shows "—"). Ollama = free.
// Anthropic prices are from the claude-api skill's model table (2026-10-06): opus-5-5 $4/$20, sonnet-5-5 $2/$10, cache reads $0.20.
// Not listed on purpose: Haiku 5.5 (cache-read price and its >100K tier unverified) and every OpenAI model (not verified from openai.com).
// ponytail: cache writes are billed at the input price here (really 1.25x); add a cache_write column when it matters.
const PRICES: Record<string, { input: number; output: number; cache_read: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 },
};

// In-flight runs. Cancel aborts the controller; the run then finishes with status "cancelled".
export const controllers = new Map<string, AbortController>();

const TICKET_STATUS: Record<RunStatus, string> = { passed: "review", failed: "failed", cancelled: "todo" };
const MAX_ATTEMPTS = 3; // gate failures retry automatically, with the failure fed back, up to this attempt
export const BUDGET = { maxTurns: 50, maxTokens: 2_000_000 }; // planner, wiki and CLI runs; workers use the workspace's max_turns / max_minutes
// FIX_ROUNDS, one rule for both kinds: a fix round resumes the worker's own conversation within the attempt, at most
// GATE_FIX_ROUNDS times after a failed gate (counted across the whole attempt) and MAX_REVIEW_ROUNDS - 1 times after
// review findings. One that ends without finishing (budget, provider) fails the attempt as "<why>; the fix round ended:
// <reason>", retried fresh like a gate failure while attempts remain; its provider/environment errors are never split.
const GATE_FIX_ROUNDS = 1;
// A reviewer reads the whole change and a few callers: its turns grow with the changed lines (it once used 25 on a 10-line diff).
const reviewBudget = (lines: number) => ({ maxTurns: Math.min(25, Math.max(8, 6 + Math.ceil(lines / 8))), maxTokens: BUDGET.maxTokens });
const WORKER_FINISH = "Wrap up now: make sure the tests pass, then end with your final reply (what is done, what is left).";

export type Settings = {
  workspace_id: string; repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; image: string;
  default_provider_id: string | null; default_model: string | null; compact_at_tokens: number; auto_approve_children: number; model_review: number;
  auto_split: number; child_size_hint: string; triage_model: string; wiki: number; max_turns: number; max_minutes: number;
};
// The one place for settings defaults (a new workspace, GET before the first save, PUT with null). The DB columns repeat them.
export const SETTINGS_DEFAULTS = {
  repo_path: "", base_branch: "", setup_command: "npm ci", test_command: "npm test", protected_paths: "tests/,evals/", image: SANDBOX_IMAGE,
  child_size_hint: "at most 3 files and about 60 changed lines, finishable in 20 agent turns", triage_model: "", // M9; "" = no hint / no triage
  compact_at_tokens: 150_000, auto_approve_children: 0, model_review: 1, auto_split: 1, wiki: 1, max_turns: 120, max_minutes: 60,
};
// Eval case runs use the default worker budget, not the workspace's: a score must not move when someone edits Settings.
const EVAL_WORKER = { max_turns: SETTINGS_DEFAULTS.max_turns, max_minutes: SETTINGS_DEFAULTS.max_minutes };
export const settingsFor = (workspaceId: string) =>
  db.prepare("SELECT * FROM workspace_settings WHERE workspace_id = ?").get(workspaceId) as Settings | undefined;

type TicketRow = {
  id: string; workspace_id: string; title: string; spec: string; key: string; provider_id: string | null; model: string | null; parent_id: string | null; kind: string; test_command: string | null;
  escalated_to: string | null;
};
const ticketRow = (id: string) =>
  db.prepare(`SELECT t.id, t.workspace_id, t.title, t.spec, t.provider_id, t.model, t.parent_id, t.kind, t.test_command, t.escalated_to, ${ticketKey()} AS key
    FROM tickets t JOIN organization o ON o.id = t.workspace_id WHERE t.id = ?`).get(id) as TicketRow | undefined;
// Every ticket status change goes through here. Becoming done or failed settles a child: its planner may react (settled).
// quiet: no reaction (a child replaced by a "Split:" epic: that epic is open in its place, nothing to wake up for).
function setTicket(id: string, status: string, quiet = false) {
  const now = Date.now();
  const end = status === "done" || status === "failed";
  db.prepare("UPDATE tickets SET status = ?, updated_at = ?, settled_at = ? WHERE id = ?").run(status, now, end ? now : null, id);
  if (end && !quiet) background(settled(id), "settling failed");
}

// Fire-and-forget work. It can outlive its ticket (deleted meanwhile: its inserts fail on the foreign key), and an
// unhandled rejection would end the process and every run in it.
const background = (p: Promise<unknown>, what: string) => void p.catch((e) => console.error(what, e));

// Provider from env. Throws a user-facing message when none is configured.
function providerConfig(opts: { model?: string; baseUrl?: string }) {
  const fake = process.env.POLARIS_PROVIDER === "fake";
  const baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (baseUrl ? "ollama" : undefined);
  if (!fake && !apiKey) throw new Error("set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL for Ollama), or POLARIS_PROVIDER=fake");
  const model = opts.model ?? process.env.POLARIS_MODEL ?? (fake ? "demo" : DEFAULT_MODEL);
  return { model, provider: (task: string) => (fake ? demoProvider(task) : anthropic({ apiKey: apiKey!, baseUrl })) };
}

function recordCost(runId: string, model: string, usage: Usage) {
  const p = PRICES[model];
  if (!p) return;
  const cost = (usage.input + usage.cache_write) * p.input + usage.output * p.output + usage.cache_read * p.cache_read;
  db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(cost / 1e6, runId);
}

const tail = (r: ExecResult, n = 4000) => {
  const s = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  return s.length > n ? `[...]\n${s.slice(-n)}` : s;
};

// A failing test command (non-zero exit or timeout) is run once more at once: passing then means a flake, not a failure.
// again is only called after a failure; the second result is the failure when it fails too.
async function rerunFlaky(first: ExecResult, again: () => Promise<ExecResult>) {
  if (first.code === 0) return { r: first };
  const second = await again();
  return second.code === 0 ? { r: second, flaky: true as const, first_failure: { code: first.code, timed_out: first.timedOut, output: tail(first) } } : { r: second };
}

// A run compacts its conversation once the context passes min(70% of the provider's window, the workspace cap).
// POLARIS_COMPACT_AT overrides it (tests).
export function compactThreshold(capTokens: number | undefined, window: number) {
  const env = Number(process.env.POLARIS_COMPACT_AT);
  return env > 0 ? env : Math.min(Math.floor(window * 0.7), capTokens ?? SETTINGS_DEFAULTS.compact_at_tokens);
}
const envWindow = () => (process.env.ANTHROPIC_BASE_URL ? CONTEXT_WINDOW.ollama : CONTEXT_WINDOW.anthropic); // no stored provider: env fallback

// The window a run assumes, and where that came from. An Ollama provider still at the default 32768 is "auto" (the
// default is a guess, and Ollama often serves far more); any other stored value is the user's choice and wins, even
// above what is detected. Detection failing falls back to the stored value.
export async function runWindow(stored: ReturnType<typeof providerById>, model: string) {
  if (!stored) return { window: envWindow(), source: "default" };
  const auto = stored.kind === "ollama" && stored.context_window === CONTEXT_WINDOW.ollama;
  return (auto && (await ollamaWindow(stored.base_url, model))) || { window: stored.context_window, source: auto ? "default" : "provider setting" };
}

// The first user message. Everything that differs per run goes here, ahead of the ticket, never into the system prompt or
// the tools, so those stay byte-identical across runs and repos (prompt-cache prefix): environment, skills, the workspace's
// lessons, the project wiki's index (M10) and feedback (see below).
function taskFor(t: { title: string; spec: string; header?: string }, info: { sandbox: string; repo: string; base: string; protectedPaths: string[]; skills: Skill[]; lessons?: string; wiki?: string }, feedback: string[]) {
  const parts = [
    [
      "# Environment",
      `- Sandbox: ${info.sandbox || "unknown"}; your working directory is the repository root`,
      `- Repository: ${info.repo}, branched from ${info.base}. It is at /work in the sandbox, which is also every shell command's working directory; tool paths are relative to it (absolute /work/... is accepted too)`,
      ...(info.protectedPaths.length ? [`- Read-only paths (changes there fail the run): ${info.protectedPaths.join(", ")}`] : []),
    ].join("\n"),
  ];
  if (info.skills.length) parts.push(skillsText(info.skills));
  if (info.lessons) parts.push(`# Lessons from earlier runs\n\n${info.lessons}`);
  if (info.wiki) parts.push(info.wiki);
  const body = [t.header, t.spec].filter(Boolean).join("\n\n"); // header: the tracker's priority, labels, project, due date (M11)
  parts.push(...feedback, `# Task\n\n${body ? `# ${t.title}\n\n${body}` : t.title}`);
  return parts.join("\n\n");
}

// The latest review decision on any run of the ticket, if it was a rejection with a note.
function reviewNote(ticketId: string) {
  const review = db.prepare(`SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id
    WHERE r.ticket_id = ? AND e.type = 'review' ORDER BY e.created_at DESC, e.seq DESC LIMIT 1`).get(ticketId) as { payload: string } | undefined;
  const rv = review && (JSON.parse(review.payload) as EventPayloads["review"]);
  return rv?.decision === "rejected" ? rv.note : undefined;
}

// The epic a child belongs to (it asks for a handoff), the latest reviewer rejection note and (on a retry) the previous
// attempt's gate failure. Not for eval cases (frozen).
function feedback(t: TicketRow, runId: string, attempt: number) {
  const parts: string[] = [];
  if (t.parent_id) parts.push(handoffRequest(ticketRow(t.parent_id)!));
  const note = reviewNote(t.id);
  if (note) parts.push(`A reviewer rejected an earlier attempt: ${note}`);
  if (attempt > 1) {
    const last = <T extends keyof EventPayloads>(type: T) => {
      const row = db.prepare(`SELECT e.payload FROM events e WHERE e.type = ? AND e.run_id =
        (SELECT id FROM runs WHERE ticket_id = ? AND eval_run_id IS NULL AND rowid < (SELECT rowid FROM runs WHERE id = ?) ORDER BY rowid DESC LIMIT 1) ORDER BY e.seq DESC LIMIT 1`).get(type, t.id, runId) as
        | { payload: string }
        | undefined;
      return row && (JSON.parse(row.payload) as EventPayloads[T]);
    };
    // The run's own reason says what failed it (a gate, the review, a fix round, a restart); the gate output and the
    // findings only back it up.
    const f = last("run_finished");
    const p = last("test_result");
    const r = last("model_review");
    if (f)
      parts.push([
        `Previous attempt failed: ${f.reason ?? f.status}`,
        ...(p && !p.passed ? [`\`\`\`\n${p.output}\n\`\`\``] : []),
        ...(r?.verdict === "request_changes" && f.reason?.startsWith("model review") ? [`The last findings:\n${findingsText(r.findings)}`] : []),
      ].join("\n"));
  }
  return parts;
}

// The prompt version active at queue time is the run's (a promotion applies to runs queued after it). Planner runs use
// planner.md (not versioned) and attempt = round number. A triage result is the run's first event (logged before it can start).
function queue(t: TicketRow, model: string, attempt: number, providerId: string | null, planner = false, triaged?: EventPayloads["triage"]) {
  const runId = createRun({
    ticketId: t.id, model, attempt, providerId, role: planner ? "planner" : "worker", promptVersion: planner ? undefined : activePrompt(t.workspace_id).version,
  });
  if (triaged) eventLog(runId)({ type: "triage", payload: triaged });
  setTicket(t.id, "running");
  pump();
  return runId;
}

export type Pick = { provider_id?: string | null; model?: string | null };

// Provider + model for a new run: the first of explicit choice → ticket → workspace default that sets either; none → env.
function choose(t: TicketRow, s: Settings, pick?: Pick): { provider_id: string | null; model: string } {
  const level = [pick, t, { provider_id: s.default_provider_id, model: s.default_model }].find((l) => l && (l.provider_id || l.model));
  if (!level?.provider_id) return { provider_id: null, model: providerConfig({ model: level?.model ?? undefined }).model };
  const p = providerById(level.provider_id);
  if (!p || p.workspace_id !== t.workspace_id) throw new Error("the chosen provider no longer exists. Pick another one.");
  const model = level.model ?? (p.kind === "anthropic" ? DEFAULT_MODEL : undefined);
  if (!model) throw new Error(`choose a model for provider "${p.name}"`);
  return { provider_id: p.id, model };
}

// Provider + model for a prompt proposal: the workspace default, else env. Throws a user-facing message.
export function metaProvider(ws: string) {
  const s = settingsFor(ws) ?? ({ default_provider_id: null, default_model: null } as Settings);
  const c = choose({ workspace_id: ws, provider_id: null, model: null } as TicketRow, s);
  return { model: c.model, provider: c.provider_id ? adapterFor(providerById(c.provider_id)!) : providerConfig({ model: c.model }).provider("") };
}

// Queues attempt 1 of a ticket (an epic: its next planner round) after checking the workspace's repo settings. Errors are user-facing.
// M9: a top-level task's first run is triaged first when the workspace has a triage model; too large → split instead (the
// returned run is the new epic's round 1, which logs the triage that split it: `triaged`).
export async function enqueueRun(ticketId: string, pick?: Pick, triaged?: EventPayloads["triage"]): Promise<{ runId: string } | { error: string; status: 400 | 409 }> {
  const t = ticketRow(ticketId);
  if (!t) return { error: "not_found", status: 400 };
  const s = settingsFor(t.workspace_id);
  if (!s) return { error: "No repository configured. Set one in Settings before running agents.", status: 400 };
  const repo = await inspectRepo(s.repo_path, s.base_branch);
  if ("error" in repo) return { error: `Repository settings are invalid: ${repo.error}. Fix them in Settings.`, status: 400 };
  let chosen: ReturnType<typeof choose>;
  try {
    chosen = choose(t, s, pick);
  } catch (e) {
    return { error: (e as Error).message, status: 400 };
  }
  // Children were sized by their planner; a ticket that ran before or was split already is not triaged again.
  const triage = t.kind === "task" && !t.parent_id && !t.escalated_to && s.auto_split && s.triage_model.trim() &&
    !db.prepare("SELECT 1 FROM runs WHERE ticket_id = ? AND eval_run_id IS NULL").get(t.id) ? await triageTicket(t, s) : undefined;
  // Re-checked after the awaits above: two clicks must not queue two runs (or split the ticket twice).
  const now = db.prepare("SELECT status, escalated_to FROM tickets WHERE id = ?").get(ticketId) as { status: string; escalated_to: string | null } | undefined;
  if (!now) return { error: "not_found", status: 400 };
  if (now.status === "running") return { error: "ticket already has a running run", status: 409 };
  if (now.escalated_to !== t.escalated_to) return { error: "ticket was just split into an epic", status: 409 };
  if (triage?.split) return split(t, `## Triage\n\nA triage model scored this ticket's size ${triage.score!.toFixed(2)} of 4 (3 = many files or several features), so it was split before any direct attempt.`, triage);
  if (t.kind !== "epic") return { runId: queue(t, chosen.model, 1, chosen.provider_id, false, triage) };
  const round = (db.prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM runs WHERE ticket_id = ? AND role = 'planner'").get(t.id) as { n: number }).n + 1;
  if (round > MAX_ROUNDS) return { error: `This epic has used all ${MAX_ROUNDS} planner rounds.`, status: 409 };
  return { runId: queue(t, chosen.model, round, chosen.provider_id, true, triaged) };
}

// --- M9 automatic splitting (see SPEC "Automatic splitting (M9)") ---

const SIZE_SPLIT = 3; // triage score (0 trivial … 4 epic) from which a ticket is split before running
const TRIAGE_QUESTIONS = {
  size: {
    type: "score", instructions: "How large is this software change for an AI coding agent?",
    criteria: ["Trivial: one small edit", "Small: one or two files", "Medium: a few files, one feature", "Large: many files or several features", "Epic: needs to be split into several tickets"],
  },
};

// Asks the workspace's System One decision model (served by its default Ollama provider) how large the ticket is. Never
// throws: an error is part of the result, and the ticket then runs directly.
async function triageTicket(t: TicketRow, s: Settings): Promise<EventPayloads["triage"]> {
  const model = s.triage_model.trim();
  try {
    const p = s.default_provider_id ? providerById(s.default_provider_id) : undefined;
    if (p?.kind !== "ollama") throw new Error("the workspace's default provider is not an Ollama provider");
    const res = await fetch(`${(p.base_url || OLLAMA_URL).replace(/\/$/, "")}/v1/systemone`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model, state: `${t.title}\n\n${t.spec}`, questions: TRIAGE_QUESTIONS }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const a = ((await res.json()) as any)?.answers?.size;
    if (typeof a?.score !== "number" || !Number.isFinite(a.score)) throw new Error("the answer has no size score");
    return { model, split: a.score >= SIZE_SPLIT, score: a.score, probabilities: a.probabilities, confidence: a.confidence };
  } catch (e) {
    return { model, split: false, error: (e as Error).message };
  }
}

// Splitting is for tasks that can still get a planner: a child of a sub-epic is at the depth limit (its epic would be a
// third level), and an epic at its child limit has no room for one more. A ticket is replaced at most once.
function canSplit(t: TicketRow) {
  if (t.kind !== "task" || t.escalated_to) return false;
  const parent = t.parent_id ? ticketRow(t.parent_id) : undefined;
  return !parent || (!parent.parent_id && childrenOf(parent.id).length < MAX_CHILDREN);
}

// Replaces task t with a new "Split:" epic (same spec + context, same parent, model choice and test command), whose planner
// starts round 1. Under an epic, t's dependents depend on the new epic instead, and t is failed without waking its planner
// (the new epic is open in its place). Returns the epic's queued round, or why it could not be queued (it fails then).
async function split(t: TicketRow, context: string, triaged?: EventPayloads["triage"]) {
  const id = randomUUID();
  // The tracker fields come along (SELECT from the original), so the epic sits where the ticket did; its children inherit as the planner's do.
  db.prepare(`INSERT INTO tickets (id, workspace_id, parent_id, kind, title, spec, provider_id, model, test_command, priority, assignee_id, estimate, due_date, project_id, milestone_id, cycle_id, cycle_added_at)
    SELECT ?, workspace_id, parent_id, 'epic', ?, ?, provider_id, model, test_command, priority, assignee_id, estimate, due_date, project_id, milestone_id, cycle_id, cycle_added_at FROM tickets WHERE id = ?`).run(
    id, `Split: ${t.title}`, `${t.spec}\n\n${context}`.trim(), t.id,
  );
  db.prepare("INSERT INTO ticket_labels (ticket_id, label_id) SELECT ?, label_id FROM ticket_labels WHERE ticket_id = ?").run(id, t.id);
  if (t.parent_id)
    for (const k of childrenOf(t.parent_id)) {
      const deps = JSON.parse(k.depends_on) as string[];
      if (deps.includes(t.id)) db.prepare("UPDATE tickets SET depends_on = ? WHERE id = ?").run(JSON.stringify(deps.map((d) => (d === t.id ? id : d))), k.id);
    }
  db.prepare("UPDATE tickets SET escalated_to = ? WHERE id = ?").run(id, t.id);
  setTicket(t.id, "failed", true);
  const r = await enqueueRun(id, undefined, triaged);
  if ("error" in r) failEpic(id, `Could not be queued: ${r.error}`);
  return r;
}

// The "Previous direct attempt" section of a split epic: why each attempt failed, the last gate output and model review
// findings, and the worker's final reply.
function previousAttempt(ticketId: string, reply: string) {
  const all = (type: string) =>
    (db.prepare(`SELECT r.attempt, e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND r.eval_run_id IS NULL AND e.type = ?
      ORDER BY r.rowid, e.seq`).all(ticketId, type) as { attempt: number; payload: string }[]).map((e) => ({ attempt: e.attempt, ...JSON.parse(e.payload) }));
  const parts = [
    "## Previous direct attempt",
    "A worker tried this as one ticket and failed, so the harness split it into this epic.",
    all("run_finished").map((f) => `- Attempt ${f.attempt}: ${f.status}${f.reason && f.reason !== f.status ? ` (${f.reason})` : ""}, ${f.turns} turns`).join("\n"),
  ];
  const gate = all("test_result").findLast((g) => !g.passed);
  if (gate) parts.push(`Last test gate failure: ${gateFailure(gate)}\n\`\`\`\n${gate.output.slice(-2000)}\n\`\`\``);
  const review = all("model_review").findLast((r) => r.verdict === "request_changes");
  if (review) parts.push(`Last model review findings:\n${findingsText(review.findings)}`);
  if (reply) parts.push(`The worker's final reply:\n${reply.length > 4000 ? `${reply.slice(0, 4000)}\n[… truncated]` : reply}`);
  return parts.join("\n\n");
}

// The epic gate, run by complete_epic: the epic's test command (its own, else the workspace's) on the base branch's current
// head, after the setup command, in a fresh detached worktree + sandbox (planner rounds have none). Logged as epic_gate.
// Returns why it failed; undefined = passed, or there is no command.
async function epicGate(s: Settings, command: string, log: ReturnType<typeof eventLog>, signal: AbortSignal) {
  if (!command.trim()) return;
  const id = `epic-gate-${randomUUID()}`;
  const wt = join(dataDir(), "worktrees", id);
  let sandbox: Sandbox | undefined;
  try {
    const sha = await git(s.repo_path, ["rev-parse", "--verify", `refs/heads/${s.base_branch}^{commit}`]);
    await addDetached(s.repo_path, sha, wt);
    sandbox = await openSandbox(id, wt, parseProtected(s.protected_paths), s.image);
    const sh = (c: string) => sandbox!.exec(c, { cwd: wt, timeoutMs: COMMAND_TIMEOUT, signal });
    const setup = s.setup_command.trim() ? await sh(s.setup_command) : undefined;
    const broken = setup && setup.code !== 0; // a failing setup command fails the gate
    const ran = broken ? s.setup_command : command;
    const { r, ...flake } = broken ? { r: setup } : await rerunFlaky(await sh(command), () => sh(command));
    log({ type: "epic_gate", payload: { passed: r.code === 0, command: ran, code: r.code, timed_out: r.timedOut, output: tail(r), sha, ...flake } });
    if (r.code === 0) return;
    return `The epic gate failed: \`${ran}\` ${r.timedOut ? "timed out" : `exited with code ${r.code}`} on ${s.base_branch} at ${sha.slice(0, 8)}. Output (tail):\n\`\`\`\n${tail(r, 2000)}\n\`\`\``;
  } finally {
    await sandbox?.close();
    await removeWorktree(s.repo_path, wt, null, dataDir());
  }
}

// An eval run: one queued run per case (all, or the chosen ones) with prompt version p, through the same FIFO queue and
// POLARIS_CONCURRENCY slots as ticket runs. The lessons version active now is frozen for every case. Errors are user-facing.
export function startEval(ws: string, p: Prompt, caseIds?: string[]): { error: string } | { id: string } {
  const all = db.prepare("SELECT * FROM eval_cases WHERE workspace_id = ? ORDER BY id").all(ws) as EvalCase[];
  const cases = caseIds ? all.filter((c) => caseIds.includes(c.id)) : all;
  if (caseIds && cases.length !== new Set(caseIds).size) return { error: "unknown eval case" };
  if (!cases.length) return { error: "No eval cases yet: add an approved ticket to evals first." };
  const s = settingsFor(ws);
  if (!s) return { error: "No repository configured. Set one in Settings before running evals." };
  let chosen: ReturnType<typeof choose>;
  try {
    chosen = choose({ workspace_id: ws, provider_id: null, model: null } as TicketRow, s); // the workspace default, then env
  } catch (e) {
    return { error: (e as Error).message };
  }
  const id = randomUUID();
  const lessons = currentLessons(ws)?.version ?? null;
  db.prepare("INSERT INTO eval_runs (id, workspace_id, prompt_id, prompt_version, lessons_version, case_ids, model) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, ws, p.id, p.version, lessons, JSON.stringify(cases.map((c) => c.id)), chosen.model,
  );
  for (const c of cases)
    createRun({ ticketId: c.ticket_id, model: chosen.model, providerId: chosen.provider_id, promptVersion: p.version, lessonsVersion: lessons, evalRunId: id, evalCaseId: c.id });
  pump();
  return { id };
}

// FIFO over the whole process: start queued runs until POLARIS_CONCURRENCY (default 2) are in flight.
// M11: ticket work (not eval cases or wiki runs) goes by ticket priority first, urgent (1) to low (4), then none (0).
// A wiki run waits queued while another of its workspace runs (it would only wait in wikiSerial, holding a slot).
export function pump() {
  const limit = Number(process.env.POLARIS_CONCURRENCY ?? 2);
  while (controllers.size < limit) {
    const next = db.prepare(`SELECT r.id FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.status = 'queued'
      AND NOT (r.role = 'wiki' AND EXISTS (SELECT 1 FROM runs w JOIN tickets wt ON wt.id = w.ticket_id WHERE w.role = 'wiki' AND w.status = 'running' AND wt.workspace_id = t.workspace_id))
      ORDER BY CASE WHEN r.eval_run_id IS NULL AND r.role <> 'wiki' AND t.priority > 0 THEN t.priority ELSE 5 END, r.rowid LIMIT 1`).get() as { id: string } | undefined;
    if (!next) return;
    controllers.set(next.id, new AbortController());
    db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), next.id);
    execute(next.id)
      .catch((e) => console.error("run crashed", e))
      .finally(() => {
        controllers.delete(next.id);
        pump();
      });
  }
}

type RunRow = {
  ticket_id: string; role: string; model: string; attempt: number; provider_id: string | null; prompt_version: number | null; lessons_version: number | null;
  eval_run_id: string | null; eval_case_id: string | null; wiki_op: string | null; base_sha: string | null;
};

// Reflection on the series a run ended, with that run's provider and model, in a fresh no-tools conversation (improve.ts).
async function reflectOn(runId: string, ws: string, run: { provider_id: string | null; model: string }, final?: { status: string; reason?: string; turns: number }, note?: string, signal?: AbortSignal) {
  try {
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new Error("the run's provider was deleted");
    const provider = stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider("");
    return await reflect({ workspaceId: ws, runId, digest: seriesDigest(runId, final, note), tools: toolsFor(stored?.kind).map((t) => t.def.name), provider, model: run.model, signal });
  } catch (e) {
    return { error: `reflection failed: ${(e as Error).message}` };
  }
}

// queued → worktree + sandbox → setup command → agent loop → test gate + protected-path check → commit.
// Pass: ticket → review. Gate failure: next attempt queued (≤ MAX_ATTEMPTS), else ticket → failed (M9: and split, with
// auto_split on). Cancel: ticket → todo.
// When a series ends (pass, or final failure) it is reflected on before run_finished, so the transcript shows it.
// Eval case runs (M6): detached worktree at the case's base_sha with its frozen commands, the eval's prompt and lessons
// versions; no retry, commit, reflection or ticket change; worktree always removed; the result goes to eval_results.
// Children of an epic (M7) also hand off: the end of the series stores the handoff on the ticket (handoff event), and with
// the workspace's auto-approve on, a passing child is merged right away.
async function execute(runId: string) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow;
  const t = ticketRow(run.ticket_id)!;
  if (run.role === "planner") return plan(runId, run, t);
  if (run.role === "wiki") return maintain(runId, run, t);
  const s = settingsFor(t.workspace_id);
  const ev = run.eval_case_id ? (db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(run.eval_case_id) as EvalCase | undefined) : undefined;
  const cfg = run.eval_run_id ? ev : s; // repo_path, setup/test command, protected paths, image
  const signal = controllers.get(runId)!.signal;
  const log = eventLog(runId);
  const attemptStart = Date.now();
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let turns = 0;
  let status: RunStatus = "failed";
  let reason: string | undefined;
  let retry = false;
  let sandbox: Sandbox | undefined;
  let branch: string | undefined;
  let reply = ""; // the agent's final text (handoff)
  let gateOutput = "";
  const worktree = join(dataDir(), "worktrees", runId);
  try {
    if (!cfg) throw new AgentError("UnexpectedEnvironment", run.eval_run_id ? "the eval case was removed" : "no repository configured for this workspace");
    // The ticket's own test_command (when set) overrides the workspace one; eval case runs use the case's frozen command.
    const testCommand = run.eval_run_id ? cfg.test_command : (t.test_command ?? cfg.test_command);
    let protectedPaths = parseProtected(cfg.protected_paths);
    mkdirSync(join(dataDir(), "worktrees"), { recursive: true });
    let base_sha: string;
    if (ev) await addDetached(cfg.repo_path, (base_sha = ev.base_sha), worktree);
    else {
      branch = `polaris/${t.key}-${run.attempt}-${runId.slice(0, 8)}`;
      base_sha = await addWorktree(cfg.repo_path, s!.base_branch, worktree, branch);
    }
    db.prepare("UPDATE runs SET worktree = ?, branch = ?, base_sha = ? WHERE id = ?").run(worktree, branch ?? null, base_sha, runId);
    log({ type: "setup", payload: { step: "worktree", branch: branch ?? "", base_sha } });
    // M10: the wiki's HEAD as a read-only snapshot (a broken wiki must not stop the work: fail-open). Not for frozen eval cases.
    let wiki = "";
    let wikiTree: Awaited<ReturnType<typeof materialize>> | undefined;
    if (s?.wiki && !ev)
      try {
        wikiTree = await materialize(t.workspace_id, worktree);
        wiki = await wikiSection(t.workspace_id, cfg.repo_path, base_sha);
        protectedPaths = [...protectedPaths, ".polaris/wiki"];
      } catch (e) {
        log({ type: "error", payload: { kind: "UnexpectedEnvironment", message: `project wiki unavailable: ${(e as Error).message}` } });
      }
    sandbox = await openSandbox(runId, worktree, protectedPaths, cfg.image);
    log({ type: "setup", payload: { step: "sandbox", sandbox: sandbox.name } });
    const sh = (command: string) => sandbox!.exec(command, { cwd: worktree, timeoutMs: COMMAND_TIMEOUT, signal });
    const abortCheck = () => {
      if (signal.aborted) throw new AgentError("UserAborted", "cancelled");
    };
    abortCheck();

    if (cfg.setup_command.trim()) {
      const r = await sh(cfg.setup_command);
      abortCheck();
      log({ type: "setup", payload: { step: "command", command: cfg.setup_command, code: r.code, output: tail(r) } });
      if (r.code !== 0) throw new AgentError("UnexpectedEnvironment", `setup command ${r.timedOut ? "timed out" : `failed with exit code ${r.code}`}`);
    }

    const env = await sh("uname -sm; node --version 2>/dev/null; true");
    abortCheck();
    const skills = listSkills(worktree);
    if (skills.length) log({ type: "setup", payload: { step: "skills", skills } });
    // Ticket runs get the lessons active now; eval case runs the version frozen at eval start.
    const lessons = run.eval_run_id ? lessonsAt(t.workspace_id, run.lessons_version) : currentLessons(t.workspace_id);
    const prompt = (run.prompt_version && promptAt(t.workspace_id, run.prompt_version)) || activePrompt(t.workspace_id);
    db.prepare("UPDATE runs SET prompt_version = ?, lessons_version = ? WHERE id = ?").run(prompt.version, lessons?.version ?? null, runId);
    const task = taskFor(ev ?? { ...t, header: trackerHeader(t.id) }, {
      sandbox: env.stdout.trim().split("\n").join(", node "), repo: basename(cfg.repo_path), base: ev ? base_sha.slice(0, 8) : s!.base_branch, protectedPaths, skills, lessons: lessons?.body, wiki,
    }, ev ? [] : feedback(t, runId, run.attempt));
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new AgentError("ProviderError", "the run's provider was deleted");
    const w = await runWindow(stored, run.model);
    const compactAt = compactThreshold(s?.compact_at_tokens, w.window);
    log({ type: "setup", payload: { step: "context", ...w, compact_at: compactAt } });
    const common = {
      model: run.model, root: worktree, exec: sandbox.exec, protectedPaths, signal, cacheKey: t.id, compactAt,
      onEvent: (e: AgentEvent) => e.type !== "run_finished" && log(e), // this pipeline writes the final run_finished
    };
    const providerFor = (task: string) => (stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider(task));
    const addUsage = (u: Usage) => (Object.keys(u) as (keyof Usage)[]).forEach((k) => (usage[k] += u[k]));
    // Turns count per agent call (initial run, each fix round); the minutes run from the attempt's start, across all of them.
    const limits = ev || !s ? EVAL_WORKER : s;
    const workerBudget = { maxTurns: limits.max_turns, maxTokens: BUDGET.maxTokens, deadline: attemptStart + limits.max_minutes * 60_000, minutes: limits.max_minutes };
    let a = await runAgent({ ...common, provider: providerFor(task), system: prompt.body, task, tools: toolsFor(stored?.kind), budget: workerBudget, finishHint: WORKER_FINISH });
    ({ usage, turns, status, reason } = a);
    reply = finalText(a.messages);
    if (status !== "passed") return;

    // Runs the tests and the protected-path check, logging test_result. A failure that is not a protected-path change is
    // re-run once at once (flaky).
    const check = async () => {
      const run = () => (testCommand.trim() ? sh(testCommand) : Promise.resolve({ stdout: "", stderr: "", code: 0, timedOut: false }));
      const first = await run();
      abortCheck();
      // git can't see .polaris/wiki (excluded), so its snapshot is compared directly.
      const touched = [...(await protectedChanges(worktree, base_sha, protectedPaths)), ...(wikiTree ? wikiTampered(worktree, wikiTree) : [])];
      const { r: test, ...flake } = touched.length ? { r: first } : await rerunFlaky(first, run);
      abortCheck();
      const result = { passed: test.code === 0 && !touched.length, command: testCommand, code: test.code, timed_out: test.timedOut, output: tail(test), protected: touched, ...flake };
      log({ type: "test_result", payload: result });
      return { result, test };
    };
    // A fix round (FIX_ROUNDS): resumes the worker's own conversation with `message`; false = it ended the attempt.
    const fixRound = async (why: string, message: string) => {
      a = await runAgent({ ...common, provider: providerFor(task), system: prompt.body, task, resume: { messages: a.messages, message }, tools: toolsFor(stored?.kind), budget: workerBudget, finishHint: WORKER_FINISH });
      addUsage(a.usage);
      turns += a.turns;
      reply = finalText(a.messages);
      if (a.status === "passed") return true;
      [status, reason] = [a.status, `${why}; the fix round ended: ${a.reason}`];
      retry = a.status === "failed" && run.attempt < MAX_ATTEMPTS;
      return false;
    };
    // Returns whether the gate passed. A failure gets the attempt's gate fix round (not for eval cases, which measure the
    // unassisted worker) and re-checks; a gate that still fails ends the attempt (and retries it).
    let gateFixes = 0;
    const gate = async () => {
      let { result, test } = await check();
      if (!result.passed && !ev && gateFixes < GATE_FIX_ROUNDS) {
        gateFixes++;
        const why = gateFailure(result);
        log({ type: "gate_fix", payload: { reason: why } });
        const message = `# Tests failed\n\nThe harness ran ${testCommand.trim() ? `\`${testCommand}\`` : "its checks"} after you finished: ${result.timed_out ? "it timed out" : `exit code ${result.code}`}.${result.protected.length ? `\nYou changed read-only (protected) paths: ${result.protected.join(", ")}. Revert these.` : ""}\nOutput (tail):\n\`\`\`\n${tail(test)}\n\`\`\`\n\nFix it and finish; the tests run again.`;
        if (!(await fixRound(why, message))) {
          gateOutput = result.output;
          return false;
        }
        ({ result, test } = await check());
      }
      if (!result.passed) {
        status = "failed";
        reason = gateFailure(result);
        gateOutput = result.output;
        retry = !ev && run.attempt < MAX_ATTEMPTS;
      }
      return result.passed;
    };
    if (!(await gate())) return;

    // M8 model review: the same model reviews the uncommitted change; findings go back to the worker in its own conversation.
    // A reviewer that errors or never submits is logged and skipped (fail-open): the human still reviews.
    for (let round = 1; !ev && s!.model_review; round++) {
      const out: { review?: Review } = {};
      const rtask = reviewTask(t, { base_sha, test: testCommand, wiki });
      const lines = await changedLines(worktree, base_sha);
      const budget = reviewBudget(lines);
      log({ type: "model_review_started", payload: { round, budget: budget.maxTurns, lines } });
      const before = await snapshot(worktree);
      const r = await runAgent({ ...common, provider: providerFor(rtask), system: REVIEWER_PROMPT, task: rtask, tools: reviewerTools(out), budget, finished: () => !!out.review, finishHint: "Call submit_review now with your verdict on what you have seen." });
      addUsage(r.usage);
      abortCheck();
      if ((await snapshot(worktree)) !== before) {
        await restore(worktree, before);
        log({ type: "error", payload: { kind: "InvalidArguments", message: "The reviewer changed files; its changes were undone." } });
      }
      const review = out.review;
      log({ type: "model_review", payload: { round, verdict: review?.verdict ?? "error", findings: review?.findings ?? [], ...(review ? {} : { message: r.reason ?? "the reviewer ended without calling submit_review" }) } });
      if (review?.verdict !== "request_changes") break;
      if (round === MAX_REVIEW_ROUNDS) {
        status = "failed";
        reason = `model review: changes still requested after ${MAX_REVIEW_ROUNDS} rounds`;
        retry = run.attempt < MAX_ATTEMPTS;
        return;
      }
      const message = `# Model review\n\nA reviewer found problems in your change:\n${findingsText(review.findings)}\n\nFix them, then finish with a short reply. The tests and the review run again.`;
      if (!(await fixRound("model review requested changes", message)) || !(await gate())) return;
    }
    if (!ev) log({ type: "commit", payload: { sha: await commitAll(worktree, `${t.key}: ${t.title}`), branch: branch! } });
  } catch (e) {
    status = "failed";
    reason = `${e instanceof AgentError ? e.kind : "UnexpectedEnvironment"}: ${(e as Error).message}`;
    if (!signal.aborted) log({ type: "error", payload: { kind: e instanceof AgentError ? e.kind : "UnexpectedEnvironment", message: (e as Error).message } });
  } finally {
    await sandbox?.close();
    if (signal.aborted) [status, reason, retry] = ["cancelled", "cancelled", false];
    if (!run.eval_run_id && s && !retry && status !== "cancelled")
      log({ type: "reflection", payload: await reflectOn(runId, t.workspace_id, run, { status, reason, turns }, undefined, signal) });
    if (t.parent_id && !run.eval_run_id && !retry && status !== "cancelled") {
      const text = handoffText(reply, status === "passed" ? undefined : `${reason}${gateOutput ? `\n\`\`\`\n${gateOutput.slice(-1000)}\n\`\`\`` : ""}`);
      db.prepare("UPDATE tickets SET handoff = ? WHERE id = ?").run(text, t.id);
      log({ type: "handoff", payload: { text } });
    }
    log({ type: "run_finished", payload: { status, reason, turns, usage } });
    recordCost(runId, run.model, usage);
    // Passing ticket runs keep worktree + branch for review; anything else is cleaned up now (output is in the event log).
    if ((status !== "passed" || run.eval_run_id) && cfg) await removeWorktree(cfg.repo_path, worktree, branch ?? null, dataDir());
    if (run.eval_run_id) recordEvalResult(runId, status === "passed", turns);
    else if (retry) queue(t, run.model, run.attempt + 1, run.provider_id); // same provider and model
    // M9: a task that failed for good is split, unless splitting can't help (provider, environment or harness errors).
    else if (status === "failed" && s?.auto_split && canSplit(t) && !/(^|the fix round ended: )(ProviderError|UnexpectedEnvironment|Unknown):/.test(reason ?? "")) await split(t, previousAttempt(t.id, reply));
    else {
      setTicket(t.id, TICKET_STATUS[status]);
      if (status === "passed" && t.parent_id && s?.auto_approve_children) await autoApprove(t.id, runId);
    }
  }
}

// Auto-approve (M7 workspace setting): the Approve button's merge path. A failed merge leaves the child in review.
async function autoApprove(ticketId: string, runId: string) {
  const r = await approve(ticketId).catch((e: Error) => ({ error: e.message }));
  if ("error" in r) eventLog(runId)({ type: "error", payload: { kind: "UnexpectedEnvironment", message: `Auto-approve failed: ${r.error}` } });
}

// A planner round (M7): a detached checkout of the base branch's current commit, read only through read_file/search on the
// host (no sandbox, no write tool), the planner.md system prompt and the planner tools; a fresh conversation per round.
// No gate, commit, review or reflection; the checkout is always removed. afterRound decides what the epic does next (a retry too).
async function plan(runId: string, run: RunRow, t: TicketRow) {
  const s = settingsFor(t.workspace_id);
  const signal = controllers.get(runId)!.signal;
  const log = eventLog(runId);
  const worktree = join(dataDir(), "worktrees", runId);
  const prev = db.prepare("SELECT started_at FROM runs WHERE ticket_id = ? AND role = 'planner' AND rowid < (SELECT rowid FROM runs WHERE id = ?) ORDER BY rowid DESC LIMIT 1").get(t.id, runId) as
    | { started_at: number | null }
    | undefined;
  const since = prev?.started_at ?? 0; // children that settled after the previous round started are new to this one
  const outcome: Outcome = {};
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let turns = 0;
  let status: RunStatus = "failed";
  let reason: string | undefined;
  let reply = "";
  try {
    if (!s) throw new AgentError("UnexpectedEnvironment", "no repository configured for this workspace");
    mkdirSync(join(dataDir(), "worktrees"), { recursive: true });
    const base_sha = await git(s.repo_path, ["rev-parse", "--verify", `refs/heads/${s.base_branch}^{commit}`]);
    await addDetached(s.repo_path, base_sha, worktree);
    db.prepare("UPDATE runs SET worktree = ?, base_sha = ? WHERE id = ?").run(worktree, base_sha, runId);
    log({ type: "setup", payload: { step: "worktree", branch: "", base_sha } });
    const skills = listSkills(worktree);
    if (skills.length) log({ type: "setup", payload: { step: "skills", skills } });
    let wiki = "";
    if (s.wiki)
      try {
        await materialize(t.workspace_id, worktree);
        wiki = await wikiSection(t.workspace_id, s.repo_path, base_sha);
      } catch (e) {
        log({ type: "error", payload: { kind: "UnexpectedEnvironment", message: `project wiki unavailable: ${(e as Error).message}` } });
      }
    const lessons = currentLessons(t.workspace_id);
    db.prepare("UPDATE runs SET lessons_version = ? WHERE id = ?").run(lessons?.version ?? null, runId);
    const notes = (db.prepare(`SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND e.type = 'round_finished'
      ORDER BY r.rowid, e.seq`).all(t.id) as { payload: string }[]).map((e) => JSON.parse(e.payload) as EventPayloads["round_finished"]);
    const gateCommand = t.test_command ?? s.test_command; // a split epic keeps the command of the ticket it replaced
    await startReady(t.id); // children moved in while the epic was not running
    const task = plannerTask(t, {
      repo: basename(s.repo_path), base: s.base_branch, sha: base_sha, gate: gateCommand, sizeHint: s.child_size_hint, autoSplit: !!s.auto_split, protectedPaths: parseProtected(s.protected_paths), skills,
      lessons: lessons?.body, wiki, round: run.attempt, notes, review: reviewNote(t.id), since,
    });
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new AgentError("ProviderError", "the run's provider was deleted");
    const w = await runWindow(stored, run.model);
    const compactAt = compactThreshold(s.compact_at_tokens, w.window);
    log({ type: "setup", payload: { step: "context", ...w, compact_at: compactAt } });
    const a = await runAgent({
      provider: stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider(task), model: run.model, system: PLANNER_PROMPT, task,
      tools: plannerTools(t, outcome, since, startChild, () => epicGate(s, gateCommand, log, signal)), root: worktree, budget: BUDGET, signal, cacheKey: t.id,
      compactAt,
      finished: () => outcome.notes !== undefined || outcome.summary !== undefined,
      finishHint: "Call finish_round (or complete_epic) now with your notes.",
      onEvent: (e) => e.type !== "run_finished" && log(e),
    });
    ({ usage, turns, status, reason } = a);
    reply = finalText(a.messages);
  } catch (e) {
    status = "failed";
    reason = `${e instanceof AgentError ? e.kind : "UnexpectedEnvironment"}: ${(e as Error).message}`;
    if (!signal.aborted) log({ type: "error", payload: { kind: e instanceof AgentError ? e.kind : "UnexpectedEnvironment", message: (e as Error).message } });
  } finally {
    if (signal.aborted) [status, reason] = ["cancelled", "cancelled"];
    if (status === "passed") log({ type: "round_finished", payload: { round: run.attempt, notes: outcome.summary ?? outcome.notes ?? reply, completed: outcome.summary !== undefined } });
    log({ type: "run_finished", payload: { status, reason, turns, usage } });
    recordCost(runId, run.model, usage);
    if (s) await removeWorktree(s.repo_path, worktree, null, dataDir());
    await afterRound(t, runId, status, reason, outcome.summary);
  }
}

// Cancelled → epic todo (Run planner starts the next round); failed (provider error, budget, crash) → a fresh round
// retries it once, then the epic fails; complete_epic → review (a sub-epic with auto-approve on → done at once);
// otherwise the epic keeps waiting for children (wake).
async function afterRound(t: TicketRow, runId: string, status: RunStatus, reason: string | undefined, summary?: string) {
  if (status === "cancelled") return setTicket(t.id, "todo");
  if (status !== "passed") {
    const [last, prev] = rounds(t.id, 2);
    if (prev?.status === "failed" || last.attempt >= MAX_ROUNDS) return failEpic(t.id, `A planner round failed${prev?.status === "failed" ? " twice in a row" : ""}: ${reason}`);
    eventLog(runId)({ type: "error", payload: { kind: "UnexpectedEnvironment", message: `The planner round failed (${reason}); retrying with a fresh round.` } });
    return void queue(t, last.model, last.attempt + 1, last.provider_id, true);
  }
  if (summary === undefined) return wake(t.id);
  db.prepare("UPDATE tickets SET handoff = ? WHERE id = ?").run(summary, t.id);
  setTicket(t.id, "review");
  if (t.parent_id && settingsFor(t.workspace_id)?.auto_approve_children) await approve(t.id);
}

// The reason is the epic's handoff: its own view shows it, and a parent planner reads it.
function failEpic(id: string, reason: string) {
  db.prepare("UPDATE tickets SET handoff = ? WHERE id = ?").run(reason, id);
  setTicket(id, "failed");
}

// Queues a child (attempt 1, or a sub-epic's round 1). One that cannot be queued fails with the reason, so its planner hears
// of it instead of waiting forever. Returns the error message, if any.
async function startChild(id: string) {
  const r = await enqueueRun(id);
  if (!("error" in r) || r.status === 409) return "error" in r ? r.error : undefined; // 409: already queued by someone else
  db.prepare("UPDATE tickets SET handoff = ? WHERE id = ?").run(`Could not be queued: ${r.error}`, id);
  setTicket(id, "failed");
  return r.error;
}

// A ticket became done or failed. If it is a child: siblings whose dependencies are now all done are queued (they branch
// from the base branch when they start, so they see the merged work), then the planner is woken. Dependents of a failed
// child are not started (blocked): the planner decides.
async function settled(id: string) {
  const t = db.prepare("SELECT parent_id, status FROM tickets WHERE id = ?").get(id) as { parent_id: string | null; status: string } | undefined;
  if (!t?.parent_id) return;
  if (t.status === "done") {
    const kids = childrenOf(t.parent_id);
    const done = new Set(kids.filter((k) => k.status === "done").map((k) => k.id));
    for (const k of kids) {
      const deps = JSON.parse(k.depends_on) as string[];
      if (k.status === "todo" && !k.run_count && deps.includes(id) && deps.every((d) => done.has(d))) await startChild(k.id);
    }
  }
  wake(t.parent_id);
}

// While an epic is running, a todo child without runs whose dependencies are all done is queued: one moved into the epic
// by hand, or one already there when a round starts.
export async function startReady(epicId: string) {
  if (!isRunning(epicId)) return;
  const kids = childrenOf(epicId);
  const done = new Set(kids.filter((k) => k.status === "done").map((k) => k.id));
  for (const k of kids) if (k.status === "todo" && !k.run_count && (JSON.parse(k.depends_on) as string[]).every((d) => done.has(d))) await startChild(k.id);
}

type Round = { status: string; started_at: number | null; attempt: number; model: string; provider_id: string | null };
const rounds = (epicId: string, n = 1) =>
  db.prepare("SELECT status, started_at, attempt, model, provider_id FROM runs WHERE ticket_id = ? AND role = 'planner' ORDER BY rowid DESC LIMIT ?").all(epicId, n) as Round[];
const isRunning = (id: string) => (db.prepare("SELECT status FROM tickets WHERE id = ?").get(id) as { status: string } | undefined)?.status === "running";

// Starts the epic's next planner round when the planner has something to act on (see MAX_ROUNDS): a child failed since
// the latest round started, or no child is open. removed: a child was deleted (its dependents are blocked now). Rounds
// never overlap: children that settle while a round is queued or running are seen by it, or by the next round, which then
// starts as soon as that one ends, so one round handles every child that settled meanwhile.
export function wake(epicId: string, removed = false) {
  if (!isRunning(epicId)) return;
  const [last] = rounds(epicId);
  if (!last || last.status === "queued" || last.status === "running") return;
  const kids = childrenOf(epicId);
  const fresh = kids.filter((k) => (k.settled_at ?? 0) > (last.started_at ?? 0));
  if (openChildren(kids).length) {
    if (!removed && !fresh.some((k) => k.status === "failed" && !k.escalated_to)) return; // done children wait for the next round
  } else if (!removed && !fresh.length)
    return failEpic(epicId, "The planner ended a round without complete_epic while no child ticket was open, so nothing would start another round.");
  if (last.attempt >= MAX_ROUNDS) return failEpic(epicId, `Planner round limit reached (${MAX_ROUNDS} rounds) before the epic was completed.`);
  queue(ticketRow(epicId)!, last.model, last.attempt + 1, last.provider_id, true); // same provider and model as the last round
}

// --- M10 project wiki (see SPEC "Project wiki (M10)") ---

const WIKI_BUDGET = { maxTurns: 30, maxTokens: BUDGET.maxTokens };
const WIKI_FIX_BUDGET = { maxTurns: 10, maxTokens: BUDGET.maxTokens };
const WIKI_FIX_ROUNDS = 2; // more conversation rounds to fix what the mechanical lint found, then the result is rejected
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// Bootstrap and lint runs belong to no ticket: they hang off one hidden ticket per workspace (ingest runs hang off the ticket they ingest).
function wikiTicket(ws: string) {
  const row = db.prepare("SELECT id FROM tickets WHERE workspace_id = ? AND hidden = 1").get(ws) as { id: string } | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare("INSERT INTO tickets (id, workspace_id, title, status, number, hidden) VALUES (?, ?, 'Project wiki', 'done', -1, 1)").run(id, ws);
  return id;
}

// The worker's last reply of a run: its newest assistant message without tool calls (a reviewer's turns end in a tool call).
function finalReply(runId: string) {
  for (const e of db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'assistant_message' ORDER BY seq DESC").iterate(runId) as Iterable<{ payload: string }>) {
    const m = (JSON.parse(e.payload) as EventPayloads["assistant_message"]).message;
    if (!m.content.some((b) => b.type === "tool_use")) return finalText([m]);
  }
  return "";
}

// Queues a wiki maintainer run through the normal FIFO queue (runs of one workspace then still go one at a time: wikiSerial).
// ingest: the merge `sha` of the approved ticket's run `run` (its provider and model are used, else the workspace default).
// bootstrap / lint: the base branch head, run for the workspace default; lint needs at least one stale page. Errors are user-facing.
export async function enqueueWiki(ws: string, op: "ingest" | "bootstrap" | "lint", from?: { ticketId: string; sha: string; run: string }): Promise<{ runId: string } | { error: string; status: 400 | 409 }> {
  const s = settingsFor(ws);
  if (!s) return { error: "No repository configured. Set one in Settings before using the wiki.", status: 400 };
  if (!s.wiki) return { error: "The project wiki is off. Turn it on in Settings.", status: 409 };
  if (!from) {
    const repo = await inspectRepo(s.repo_path, s.base_branch);
    if ("error" in repo) return { error: `Repository settings are invalid: ${repo.error}. Fix them in Settings.`, status: 400 };
    if (op === "lint" && !(await pageList(ws, { repo: s.repo_path, base: (await headOf(s))! })).pages.some((p) => p.stale)) return { error: "No page is stale.", status: 409 };
  }
  let chosen: { provider_id: string | null; model: string };
  try {
    const prev = from && (db.prepare("SELECT provider_id, model FROM runs WHERE id = ?").get(from.run) as { provider_id: string | null; model: string });
    chosen = prev && (!prev.provider_id || providerById(prev.provider_id)) ? prev : choose({ workspace_id: ws, provider_id: null, model: null } as TicketRow, s);
  } catch (e) {
    return { error: (e as Error).message, status: 400 };
  }
  const ticketId = from?.ticketId ?? wikiTicket(ws);
  const attempt = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_id = ? AND role = 'wiki'").get(ticketId) as { n: number }).n + 1;
  const runId = createRun({ ticketId, model: chosen.model, attempt, providerId: chosen.provider_id, role: "wiki", wikiOp: op, baseSha: from?.sha });
  pump();
  return { runId };
}

// A wiki maintainer run: a detached checkout of the project (code/, read-only) next to a clone of the wiki (wiki/, the only
// place edit_file may write), read_file/search/edit_file only (no shell: nothing on the host can write outside wiki/). Its
// change is committed to the wiki repo only if the mechanical lint passes; failures go back to the agent (up to
// WIKI_FIX_ROUNDS more rounds in the same conversation), then the result is rejected and nothing is committed. Runs of one
// workspace go one at a time, so each sees the previous one's commit. The ticket is never touched.
async function maintain(runId: string, run: RunRow, t: TicketRow) {
  const op = run.wiki_op as "ingest" | "bootstrap" | "lint";
  const ws = t.workspace_id;
  const s = settingsFor(ws);
  const signal = controllers.get(runId)!.signal;
  const log = eventLog(runId);
  const root = join(dataDir(), "worktrees", runId);
  const usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let turns = 0;
  let status: RunStatus = "failed";
  let reason: string | undefined;
  try {
    if (!s) throw new AgentError("UnexpectedEnvironment", "no repository configured for this workspace");
    await wikiSerial(ws, async () => {
      if (signal.aborted) throw new AgentError("UserAborted", "cancelled");
      mkdirSync(root, { recursive: true });
      const sha = op === "ingest" ? run.base_sha : await headOf(s);
      if (!sha) throw new AgentError("UnexpectedEnvironment", `base branch ${s.base_branch} not found`);
      await addDetached(s.repo_path, sha, join(root, "code"));
      db.prepare("UPDATE runs SET worktree = ?, base_sha = ? WHERE id = ?").run(root, sha, runId);
      log({ type: "setup", payload: { step: "worktree", branch: "", base_sha: sha } });
      const wiki = join(root, "wiki");
      await openCopy(ws, wiki);
      const index = readFileSync(join(wiki, "index.md"), "utf8");
      const repo = basename(s.repo_path);
      const sha8 = sha.slice(0, 8);
      let task: string;
      let message: string;
      let entry: string;
      if (op === "ingest") {
        const range = [`${sha}^1`, sha];
        const diff = await git(s.repo_path, ["diff", "--no-color", ...range, "--", ".", ...scratchPathspec]).catch((e) => `(diff unavailable: ${e.message})`);
        const files = (await git(s.repo_path, ["diff", "--name-only", ...range]).catch(() => "")).split("\n").filter(Boolean);
        const approved = reviewRun(t.id);
        task = wikiTask("ingest", { repo, sha, index, ticket: t, files, diff, reply: approved ? finalReply(approved.id) : "" });
        message = oneLine(`ingest ${t.key}: ${t.title} (merge ${sha8})`);
        entry = `## [${today()}] ingest | ${t.key} ${oneLine(t.title)} (merge ${sha8})`;
      } else if (op === "bootstrap") {
        task = wikiTask("bootstrap", { repo, sha, index });
        message = `bootstrap: ${repo} at ${s.base_branch} ${sha8}`;
        entry = `## [${today()}] ingest | bootstrap from ${s.base_branch} (${sha8})`;
      } else {
        const stale = (await pageList(ws, { repo: s.repo_path, base: sha })).pages.flatMap((p) => (p.stale ? [{ path: p.path, why: p.stale }] : []));
        if (!stale.length) {
          status = "passed"; // re-verified (or edited) since it was queued: nothing to do
          return void log({ type: "wiki", payload: { op, unchanged: true } });
        }
        task = wikiTask("lint", { repo, sha, index, stale });
        message = `lint: re-verify ${stale.length} stale page${stale.length === 1 ? "" : "s"} at ${sha8}`;
        entry = `## [${today()}] lint | re-verified ${stale.map((p) => p.path).join(", ")} at ${sha8}`;
      }
      const stored = run.provider_id ? providerById(run.provider_id) : undefined;
      if (run.provider_id && !stored) throw new AgentError("ProviderError", "the run's provider was deleted");
      const w = await runWindow(stored, run.model);
      const compactAt = compactThreshold(s.compact_at_tokens, w.window);
      log({ type: "setup", payload: { step: "context", ...w, compact_at: compactAt } });
      const common = {
        provider: stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider(task), model: run.model, root, system: WIKI_PROMPT, task, tools: wikiTools,
        protectedPaths: WIKI_PROTECTED, signal, cacheKey: ws, compactAt, onEvent: (e: AgentEvent) => e.type !== "run_finished" && log(e),
      };
      let a = await runAgent({ ...common, budget: WIKI_BUDGET });
      for (let fix = 0; ; fix++) {
        for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += a.usage[k];
        turns += a.turns;
        ({ status, reason } = a);
        if (a.status !== "passed") return;
        const r: Finished = await finishCopy(ws, wiki, message, entry, s.repo_path);
        if (!("problems" in r)) return void log({ type: "wiki", payload: { op, ...("sha" in r ? { commit: r.sha } : { unchanged: true }) } });
        if (fix === WIKI_FIX_ROUNDS) {
          status = "failed";
          reason = `the wiki check failed after ${WIKI_FIX_ROUNDS} fix rounds; nothing was committed`;
          log({ type: "wiki", payload: { op, problems: r.problems } });
          log({ type: "error", payload: { kind: "InvalidArguments", message: `${reason}:\n${r.problems.join("\n")}` } });
          return;
        }
        const resume = { messages: a.messages, message: `# Wiki check failed\n\nThe harness found these problems in your wiki changes:\n${r.problems.map((p) => `- ${p}`).join("\n")}\n\nFix them with edit_file, then reply with a short summary. The check runs again.` };
        a = await runAgent({ ...common, resume, budget: WIKI_FIX_BUDGET });
      }
    });
  } catch (e) {
    status = "failed";
    reason = `${e instanceof AgentError ? e.kind : "UnexpectedEnvironment"}: ${(e as Error).message}`;
    if (!signal.aborted) log({ type: "error", payload: { kind: e instanceof AgentError ? e.kind : "UnexpectedEnvironment", message: (e as Error).message } });
  } finally {
    if (signal.aborted) [status, reason] = ["cancelled", "cancelled"];
    log({ type: "run_finished", payload: { status, reason, turns, usage } });
    recordCost(runId, run.model, usage);
    if (s) await removeWorktree(s.repo_path, join(root, "code"), null, dataDir());
    rmSync(root, { recursive: true, force: true });
  }
}

export function cancelRun(runId: string) {
  const ac = controllers.get(runId);
  if (ac) {
    ac.abort();
    return true;
  }
  const queued = db.prepare("SELECT ticket_id, eval_run_id, role FROM runs WHERE id = ? AND status = 'queued'").get(runId) as { ticket_id: string; eval_run_id: string | null; role: string } | undefined;
  if (!queued) return false;
  eventLog(runId)({ type: "run_finished", payload: { status: "cancelled", reason: "cancelled while queued", turns: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } });
  if (queued.eval_run_id) recordEvalResult(runId, false, 0); // counts as failed; the source ticket is never touched
  else if (queued.role !== "wiki") setTicket(queued.ticket_id, "todo"); // a wiki run never changes its ticket
  return true;
}

// Latest passed run that still has its branch: what review shows and approve merges.
export const reviewRun = (ticketId: string) =>
  db.prepare("SELECT * FROM runs WHERE ticket_id = ? AND status = 'passed' AND branch IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(ticketId) as
    | { id: string; branch: string; base_sha: string; worktree: string }
    | undefined;

// Removes every worktree + branch the ticket's runs created (approve, reject, delete).
export async function cleanupTicket(ticketId: string, workspaceId: string) {
  const s = settingsFor(workspaceId);
  if (!s) return;
  const runs = db.prepare("SELECT worktree, branch FROM runs WHERE ticket_id = ? AND branch IS NOT NULL").all(ticketId) as { worktree: string; branch: string }[];
  for (const r of runs) await removeWorktree(s.repo_path, r.worktree, r.branch, dataDir());
}

// One merge at a time (auto-approved children can finish together; git locks the checkout).
let merging: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>) {
  const job = merging.then(fn);
  merging = job.catch(() => {});
  return job;
}

// An epic merges nothing (its children were merged one by one): approving it marks it done.
export async function approve(ticketId: string): Promise<{ error: string } | { merge_sha?: string }> {
  const t = ticketRow(ticketId)!;
  if (t.kind === "epic") {
    const last = db.prepare("SELECT id FROM runs WHERE ticket_id = ? ORDER BY rowid DESC LIMIT 1").get(ticketId) as { id: string } | undefined;
    if (last) eventLog(last.id)({ type: "review", payload: { decision: "approved" } });
    setTicket(ticketId, "done");
    return {};
  }
  const s = settingsFor(t.workspace_id);
  const r = reviewRun(ticketId);
  if (!s || !r) return { error: "no passed run to merge" };
  const merge_sha = await serial(() => merge(s.repo_path, s.base_branch, r.branch, `Merge ${r.branch}: ${t.key} ${t.title}`));
  eventLog(r.id)({ type: "review", payload: { decision: "approved", merge_sha } });
  await cleanupTicket(ticketId, t.workspace_id);
  setTicket(ticketId, "done");
  // M10: the wiki learns from approved work only. A failure to queue is logged on the approved run; the approval stands.
  if (s.wiki) {
    const w = await enqueueWiki(t.workspace_id, "ingest", { ticketId, sha: merge_sha, run: r.id }).catch((e: Error) => ({ error: e.message }));
    if ("error" in w) eventLog(r.id)({ type: "error", payload: { kind: "UnexpectedEnvironment", message: `wiki ingest not queued: ${w.error}` } });
  }
  return { merge_sha };
}

// The note lands in the event log; the ticket's next run reads it into its task. A note also ends the series with
// something to learn: it is reflected on in the background (the reflection event lands on the same run). Not for epics:
// their next planner round reads the note. A rejected child counts as failed for its planner (the note joins its handoff).
export async function reject(ticketId: string, note: string) {
  const t = ticketRow(ticketId)!;
  const r = reviewRun(ticketId) ?? (db.prepare("SELECT id FROM runs WHERE ticket_id = ? AND eval_run_id IS NULL ORDER BY rowid DESC LIMIT 1").get(ticketId) as { id: string } | undefined);
  if (r) eventLog(r.id)({ type: "review", payload: { decision: "rejected", note: note || undefined } });
  if (r && note && t.kind !== "epic") {
    const run = db.prepare("SELECT provider_id, model FROM runs WHERE id = ?").get(r.id) as { provider_id: string | null; model: string };
    background(reflectOn(r.id, t.workspace_id, run, undefined, note).then((payload) => eventLog(r.id)({ type: "reflection", payload })), "reflection on a reject failed");
  }
  await cleanupTicket(ticketId, t.workspace_id);
  if (!t.parent_id) return setTicket(ticketId, "todo");
  db.prepare("UPDATE tickets SET handoff = COALESCE(handoff || char(10) || char(10), '') || ? WHERE id = ?").run(`Rejected by the reviewer${note ? `: ${note}` : " (no note)"}.`, ticketId);
  setTicket(ticketId, "failed");
}

// A status change by hand (the Status select): only between the states no run owns, plus review back to todo (its
// branch is dropped, as on a reject). Running and review belong to the pipeline: Run, Cancel, Approve, Reject.
// Through setTicket, so a child settled by hand wakes its planner and dependents; one put back in todo starts again
// once its dependencies are done, as when its last dependency settled.
const MANUAL = ["todo", "done", "failed"];
export async function moveTicket(id: string, to: string) {
  const t = db.prepare("SELECT status, workspace_id, parent_id, depends_on FROM tickets WHERE id = ?").get(id) as { status: string; workspace_id: string; parent_id: string | null; depends_on: string };
  if (t.status === to) return;
  const active = db.prepare(`SELECT 1 FROM runs WHERE ticket_id = ? AND status IN ('queued', 'running') AND ${OWN_RUNS}`).get(id);
  if (active || !MANUAL.includes(to) || !(MANUAL.includes(t.status) || (t.status === "review" && to === "todo"))) return { error: "invalid_transition", from: t.status, to };
  if (t.status === "review") await cleanupTicket(id, t.workspace_id);
  setTicket(id, to);
  if (to !== "todo" || !t.parent_id) return;
  const status = (tid: string) => (db.prepare("SELECT status FROM tickets WHERE id = ?").get(tid) as { status: string } | undefined)?.status;
  if (status(t.parent_id) === "running" && (JSON.parse(t.depends_on) as string[]).every((d) => status(d) === "done")) await startChild(id);
}

export type StartOptions = {
  root: string;
  model?: string;
  baseUrl?: string;
  budget?: { maxTurns: number; maxTokens: number };
  onEvent?: (e: AgentEvent) => void;
  onStream?: Parameters<typeof runAgent>[0]["onStream"];
};

// M1 CLI path: runs the agent directly on the host in `root` — no queue, worktree, sandbox or test gate.
export function startRun(ticketId: string, opts: StartOptions) {
  const ticket = ticketRow(ticketId);
  if (!ticket) throw new Error(`ticket not found: ${ticketId}`);
  const { model, provider } = providerConfig(opts);
  const attempt = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ticket_id = ?").get(ticketId) as { n: number }).n + 1;
  const root = resolve(opts.root);
  const prompt = activePrompt(ticket.workspace_id);
  const runId = createRun({ ticketId, model, attempt, worktree: root, promptVersion: prompt.version });
  setTicket(ticketId, "running");

  const ac = new AbortController();
  controllers.set(runId, ac);
  const log = eventLog(runId);
  const skills = listSkills(root);
  const task = [skillsText(skills), ticket.spec ? `# ${ticket.title}\n\n${ticket.spec}` : ticket.title].filter(Boolean).join("\n\n");
  // Best effort: the root may not be a git repo.
  const done = excludeScratch(root).catch(() => {}).then(() => runAgent({
    provider: provider(task), model, system: prompt.body, task, tools, root, budget: opts.budget ?? BUDGET, signal: ac.signal, cacheKey: ticketId, compactAt: compactThreshold(undefined, envWindow()),
    onEvent: (e) => {
      log(e);
      opts.onEvent?.(e);
    },
    onStream: opts.onStream,
  })).then((r) => {
    recordCost(runId, model, r.usage);
    setTicket(ticketId, TICKET_STATUS[r.status]);
    return r;
  }).finally(() => controllers.delete(runId));
  return { runId, done };
}

// Startup: runs left running by a dead process fail with the reason (their worktrees and containers removed); a ticket
// attempt is retried like a gate failure while attempts remain, else its series ends failed (a child hands off, a
// planner round fails its epic). Queued runs stay queued and start now. A task left "running" with no active run (the
// process died between run_finished and the ticket's transition) gets its latest run's ticket status.
export function recoverOrphans() {
  const stuck = db.prepare(`SELECT t.id, (SELECT status FROM runs WHERE ticket_id = t.id AND ${OWN_RUNS} ORDER BY rowid DESC LIMIT 1) AS last
    FROM tickets t WHERE t.status = 'running' AND t.kind = 'task'
    AND NOT EXISTS (SELECT 1 FROM runs WHERE ticket_id = t.id AND status IN ('queued', 'running') AND ${OWN_RUNS})`).all() as { id: string; last: RunStatus | null }[];
  for (const t of stuck) setTicket(t.id, (t.last && TICKET_STATUS[t.last]) || "todo");
  const orphans = db.prepare(`SELECT r.id, r.ticket_id, r.role, r.worktree, r.branch, r.eval_run_id, r.attempt, r.model, r.provider_id, t.workspace_id, t.parent_id, c.repo_path AS eval_repo FROM runs r
    JOIN tickets t ON t.id = r.ticket_id LEFT JOIN eval_cases c ON c.id = r.eval_case_id WHERE r.status = 'running'`).all() as {
    id: string; ticket_id: string; role: string; worktree: string | null; branch: string | null; eval_run_id: string | null; attempt: number; model: string; provider_id: string | null;
    workspace_id: string; parent_id: string | null; eval_repo: string | null;
  }[];
  const dead = orphans.filter((o) => !controllers.has(o.id));
  const retries: typeof dead = [];
  for (const o of dead) {
    const log = eventLog(o.id);
    const message = "interrupted by server restart";
    log({ type: "error", payload: { kind: "UnexpectedEnvironment", message } });
    const r = db.prepare("SELECT tokens_in, tokens_out, tokens_cached FROM runs WHERE id = ?").get(o.id) as Record<string, number>;
    const usage = { input: r.tokens_in, output: r.tokens_out, cache_read: r.tokens_cached, cache_write: 0 };
    log({ type: "run_finished", payload: { status: "failed", reason: message, turns: 0, usage } });
    recordCost(o.id, o.model, usage);
    if (o.eval_run_id) {
      recordEvalResult(o.id, false, 0);
      if (o.eval_repo) background(removeWorktree(o.eval_repo, o.worktree, null, dataDir()), "orphan cleanup failed");
      continue;
    }
    if (o.role === "wiki") {
      const root = o.worktree;
      const ws = settingsFor(o.workspace_id);
      if (root?.startsWith(dataDir())) background((ws ? removeWorktree(ws.repo_path, join(root, "code"), null, dataDir()) : Promise.resolve()).then(() => rmSync(root, { recursive: true, force: true })), "orphan cleanup failed");
      continue;
    }
    const s = (o.branch || o.role === "planner") && settingsFor(o.workspace_id); // CLI runs have neither: their worktree is the user's dir
    if (s) background(removeWorktree(s.repo_path, o.worktree, o.branch, dataDir()), "orphan cleanup failed");
    if (o.role === "planner") failEpic(o.ticket_id, `A planner round failed: ${message}`);
    else if (o.branch && o.attempt < MAX_ATTEMPTS) retries.push(o); // the ticket stays running until it is queued
    else {
      if (o.parent_id) db.prepare("UPDATE tickets SET handoff = ? WHERE id = ?").run(handoffText("", message), o.ticket_id);
      setTicket(o.ticket_id, "failed");
    }
  }
  // Sweep first, or it could remove a fresh run's container.
  background(removeStaleContainers().then(() => {
    for (const o of retries) queue(ticketRow(o.ticket_id)!, o.model, o.attempt + 1, o.provider_id);
    pump();
  }), "recovery failed");
  return dead.length;
}
