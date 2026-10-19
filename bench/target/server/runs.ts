import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { db } from "./db.ts";
import { createRun, eventLog } from "./agent/events.ts";
import { listSkills, skillsText, type Skill } from "./agent/context.ts";
import { runAgent } from "./agent/loop.ts";
import { anthropic, DEFAULT_MODEL } from "./agent/providers/anthropic.ts";
import { demoProvider } from "./agent/providers/demo.ts";
import { parseProtected, tools, toolsFor, type ExecResult } from "./agent/tools.ts";
import { AgentError, type AgentEvent, type EventPayloads, type RunStatus, type Usage } from "./agent/types.ts";
import { adapterFor, CONTEXT_WINDOW, providerById } from "./providers.ts";
import { addDetached, addWorktree, commitAll, excludeScratch, git, inspectRepo, merge, protectedChanges, removeWorktree } from "./git.ts";
import { activePrompt, currentLessons, gateFailure, lessonsAt, promptAt, recordEvalResult, reflect, seriesDigest, type EvalCase, type Prompt } from "./improve.ts";
import { dataDir, openSandbox, removeStaleContainers, type Sandbox } from "./sandbox.ts";
import { childrenOf, finalText, handoffRequest, handoffText, MAX_ROUNDS, openChildren, PLANNER_PROMPT, plannerTask, plannerTools, type Outcome } from "./planner.ts";

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
const COMMAND_TIMEOUT = 10 * 60_000; // setup and test commands
const BUDGET = { maxTurns: 50, maxTokens: 2_000_000 };

export type Settings = {
  workspace_id: string; repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; image: string;
  default_provider_id: string | null; default_model: string | null; compact_at_tokens: number; auto_approve_children: number;
};
export const settingsFor = (workspaceId: string) =>
  db.prepare("SELECT * FROM workspace_settings WHERE workspace_id = ?").get(workspaceId) as Settings | undefined;

type TicketRow = {
  id: string; workspace_id: string; title: string; spec: string; key: string; provider_id: string | null; model: string | null; parent_id: string | null; kind: string; test_command: string | null;
};
const ticketRow = (id: string) =>
  db.prepare(`SELECT t.id, t.workspace_id, t.title, t.spec, t.provider_id, t.model, t.parent_id, t.kind, t.test_command, upper(substr(o.slug, 1, 3)) || '-' || t.number AS key
    FROM tickets t JOIN organization o ON o.id = t.workspace_id WHERE t.id = ?`).get(id) as TicketRow | undefined;
// Every ticket status change goes through here. Becoming done or failed settles a child: its planner may react (settled).
function setTicket(id: string, status: string) {
  const now = Date.now();
  const end = status === "done" || status === "failed";
  db.prepare("UPDATE tickets SET status = ?, updated_at = ?, settled_at = ? WHERE id = ?").run(status, now, end ? now : null, id);
  if (end) void settled(id).catch((e) => console.error("settling failed", e));
}

// Provider from env. Throws a user-facing message when none is configured.
function providerConfig(opts: { model?: string; baseUrl?: string }) {
  const fake = process.env.HARNESS_PROVIDER === "fake";
  const baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (baseUrl ? "ollama" : undefined);
  if (!fake && !apiKey) throw new Error("set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL for Ollama), or HARNESS_PROVIDER=fake");
  const model = opts.model ?? process.env.HARNESS_MODEL ?? (fake ? "demo" : DEFAULT_MODEL);
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

// A run compacts its conversation once the context passes min(70% of the provider's window, the workspace cap).
// HARNESS_COMPACT_AT overrides it (tests).
export function compactThreshold(capTokens: number | undefined, window: number) {
  const env = Number(process.env.HARNESS_COMPACT_AT);
  return env > 0 ? env : Math.min(Math.floor(window * 0.7), capTokens ?? 150_000);
}
const envWindow = () => (process.env.ANTHROPIC_BASE_URL ? CONTEXT_WINDOW.ollama : CONTEXT_WINDOW.anthropic); // no stored provider: env fallback

// The first user message. Everything that differs per run goes here, ahead of the ticket, never into the system prompt or
// the tools, so those stay byte-identical across runs and repos (prompt-cache prefix): environment, skills, the workspace's
// lessons, and feedback (see below).
function taskFor(t: { title: string; spec: string }, info: { sandbox: string; repo: string; base: string; protectedPaths: string[]; skills: Skill[]; lessons?: string }, feedback: string[]) {
  const parts = [
    [
      "# Environment",
      `- Sandbox: ${info.sandbox || "unknown"}; your working directory is the repository root`,
      `- Repository: ${info.repo}, branched from ${info.base}`,
      ...(info.protectedPaths.length ? [`- Read-only paths (changes there fail the run): ${info.protectedPaths.join(", ")}`] : []),
    ].join("\n"),
  ];
  if (info.skills.length) parts.push(skillsText(info.skills));
  if (info.lessons) parts.push(`# Lessons from earlier runs\n\n${info.lessons}`);
  parts.push(...feedback, `# Task\n\n${t.spec ? `# ${t.title}\n\n${t.spec}` : t.title}`);
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
    const prev = db.prepare(`SELECT e.payload FROM events e WHERE e.type = 'test_result' AND e.run_id =
      (SELECT id FROM runs WHERE ticket_id = ? AND eval_run_id IS NULL AND rowid < (SELECT rowid FROM runs WHERE id = ?) ORDER BY rowid DESC LIMIT 1)`).get(t.id, runId) as
      | { payload: string }
      | undefined;
    const p = prev && (JSON.parse(prev.payload) as EventPayloads["test_result"]);
    if (p) parts.push(`Previous attempt failed: ${gateFailure(p)}\n\`\`\`\n${p.output}\n\`\`\``);
  }
  return parts;
}

// The prompt version active at queue time is the run's (a promotion applies to runs queued after it). Planner runs use
// planner.md (not versioned) and attempt = round number.
function queue(t: TicketRow, model: string, attempt: number, providerId: string | null, planner = false) {
  const runId = createRun({
    ticketId: t.id, model, attempt, providerId, role: planner ? "planner" : "worker", promptVersion: planner ? undefined : activePrompt(t.workspace_id).version,
  });
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
export async function enqueueRun(ticketId: string, pick?: Pick): Promise<{ runId: string } | { error: string; status: 400 | 409 }> {
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
  // Re-checked after the awaits above: two clicks must not queue two runs.
  if ((db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketId) as { status: string }).status === "running")
    return { error: "ticket already has a running run", status: 409 };
  if (t.kind !== "epic") return { runId: queue(t, chosen.model, 1, chosen.provider_id) };
  const round = (db.prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM runs WHERE ticket_id = ? AND role = 'planner'").get(t.id) as { n: number }).n + 1;
  if (round > MAX_ROUNDS) return { error: `This epic has used all ${MAX_ROUNDS} planner rounds.`, status: 409 };
  return { runId: queue(t, chosen.model, round, chosen.provider_id, true) };
}

// An eval run: one queued run per case (all, or the chosen ones) with prompt version p, through the same FIFO queue and
// HARNESS_CONCURRENCY slots as ticket runs. The lessons version active now is frozen for every case. Errors are user-facing.
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

// FIFO over the whole process: start queued runs until HARNESS_CONCURRENCY (default 2) are in flight.
export function pump() {
  const limit = Number(process.env.HARNESS_CONCURRENCY ?? 2);
  while (controllers.size < limit) {
    const next = db.prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY rowid LIMIT 1").get() as { id: string } | undefined;
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
  eval_run_id: string | null; eval_case_id: string | null;
};

// Reflection on the series a run ended, with that run's provider and model, in a fresh no-tools conversation (improve.ts).
async function reflectOn(runId: string, ws: string, run: { provider_id: string | null; model: string }, final?: { status: string; reason?: string; turns: number }, note?: string, signal?: AbortSignal) {
  try {
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new Error("the run's provider was deleted");
    const provider = stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider("");
    return await reflect({ workspaceId: ws, runId, digest: seriesDigest(runId, final, note), provider, model: run.model, signal });
  } catch (e) {
    return { error: `reflection failed: ${(e as Error).message}` };
  }
}

// queued → worktree + sandbox → setup command → agent loop → test gate + protected-path check → commit.
// Pass: ticket → review. Gate failure: next attempt queued (≤ MAX_ATTEMPTS), else ticket → failed. Cancel: ticket → todo.
// When a series ends (pass, or final failure) it is reflected on before run_finished, so the transcript shows it.
// Eval case runs (M6): detached worktree at the case's base_sha with its frozen commands, the eval's prompt and lessons
// versions; no retry, commit, reflection or ticket change; worktree always removed; the result goes to eval_results.
// Children of an epic (M7) also hand off: the end of the series stores the handoff on the ticket (handoff event), and with
// the workspace's auto-approve on, a passing child is merged right away.
async function execute(runId: string) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow;
  const t = ticketRow(run.ticket_id)!;
  if (run.role === "planner") return plan(runId, run, t);
  const s = settingsFor(t.workspace_id);
  const ev = run.eval_case_id ? (db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(run.eval_case_id) as EvalCase | undefined) : undefined;
  const cfg = run.eval_run_id ? ev : s; // repo_path, setup/test command, protected paths, image
  const signal = controllers.get(runId)!.signal;
  const log = eventLog(runId);
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
    const protectedPaths = parseProtected(cfg.protected_paths);
    mkdirSync(join(dataDir(), "worktrees"), { recursive: true });
    let base_sha: string;
    if (ev) await addDetached(cfg.repo_path, (base_sha = ev.base_sha), worktree);
    else {
      branch = `harness/${t.key}-${run.attempt}-${runId.slice(0, 8)}`;
      base_sha = await addWorktree(cfg.repo_path, s!.base_branch, worktree, branch);
    }
    db.prepare("UPDATE runs SET worktree = ?, branch = ?, base_sha = ? WHERE id = ?").run(worktree, branch ?? null, base_sha, runId);
    log({ type: "setup", payload: { step: "worktree", branch: branch ?? "", base_sha } });
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
    const task = taskFor(ev ?? t, {
      sandbox: env.stdout.trim().split("\n").join(", node "), repo: basename(cfg.repo_path), base: ev ? base_sha.slice(0, 8) : s!.base_branch, protectedPaths, skills, lessons: lessons?.body,
    }, ev ? [] : feedback(t, runId, run.attempt));
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new AgentError("ProviderError", "the run's provider was deleted");
    const a = await runAgent({
      provider: stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider(task), model: run.model, system: prompt.body, task, tools: toolsFor(stored?.kind), root: worktree, exec: sandbox.exec, protectedPaths, budget: BUDGET, signal,
      cacheKey: t.id, compactAt: compactThreshold(s?.compact_at_tokens, stored?.context_window ?? envWindow()),
      onEvent: (e) => e.type !== "run_finished" && log(e), // this pipeline writes the final run_finished
    });
    ({ usage, turns, status, reason } = a);
    reply = finalText(a.messages);
    if (status !== "passed") return;

    const gate = (!ev && t.test_command) || cfg.test_command; // a ticket's own command replaces the workspace one (eval cases are frozen)
    const test = gate.trim() ? await sh(gate) : { stdout: "", stderr: "", code: 0, timedOut: false };
    abortCheck();
    const touched = await protectedChanges(worktree, base_sha, protectedPaths);
    const result = { passed: test.code === 0 && !touched.length, command: gate, code: test.code, timed_out: test.timedOut, output: tail(test), protected: touched };
    log({ type: "test_result", payload: result });
    if (!result.passed) {
      status = "failed";
      reason = gateFailure(result);
      gateOutput = result.output;
      retry = !ev && run.attempt < MAX_ATTEMPTS;
      return;
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
// No gate, commit, review, retry or reflection; the checkout is always removed. afterRound decides what the epic does next.
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
    const lessons = currentLessons(t.workspace_id);
    db.prepare("UPDATE runs SET lessons_version = ? WHERE id = ?").run(lessons?.version ?? null, runId);
    const notes = (db.prepare(`SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND e.type = 'round_finished'
      ORDER BY r.rowid, e.seq`).all(t.id) as { payload: string }[]).map((e) => JSON.parse(e.payload) as EventPayloads["round_finished"]);
    const task = plannerTask(t, {
      repo: basename(s.repo_path), base: s.base_branch, sha: base_sha, test: s.test_command, protectedPaths: parseProtected(s.protected_paths), skills,
      lessons: lessons?.body, round: run.attempt, notes, review: reviewNote(t.id), since,
    });
    const stored = run.provider_id ? providerById(run.provider_id) : undefined;
    if (run.provider_id && !stored) throw new AgentError("ProviderError", "the run's provider was deleted");
    const a = await runAgent({
      provider: stored ? adapterFor(stored) : providerConfig({ model: run.model }).provider(task), model: run.model, system: PLANNER_PROMPT, task,
      tools: plannerTools(t, outcome, since, startChild), root: worktree, budget: BUDGET, signal, cacheKey: t.id,
      compactAt: compactThreshold(s.compact_at_tokens, stored?.context_window ?? envWindow()),
      finished: () => outcome.notes !== undefined || outcome.summary !== undefined,
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
    await afterRound(t, status, reason, outcome.summary);
  }
}

// Cancelled → epic todo (Run planner starts the next round); failed → epic failed; complete_epic → review (a sub-epic
// with auto-approve on → done at once); otherwise the epic keeps waiting for children (wake).
async function afterRound(t: TicketRow, status: RunStatus, reason: string | undefined, summary?: string) {
  if (status === "cancelled") return setTicket(t.id, "todo");
  if (status !== "passed") return failEpic(t.id, `A planner round failed: ${reason}`);
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

// Starts the epic's next planner round if a child settled after the latest round started. Rounds never overlap: children
// that settle while a round is queued or running are seen by it, or by the next round, which then starts as soon as that
// one ends, so one round handles every child that settled meanwhile.
export function wake(epicId: string) {
  if ((db.prepare("SELECT status FROM tickets WHERE id = ?").get(epicId) as { status: string } | undefined)?.status !== "running") return;
  const last = db.prepare("SELECT status, started_at, attempt, model, provider_id FROM runs WHERE ticket_id = ? AND role = 'planner' ORDER BY rowid DESC LIMIT 1").get(epicId) as
    | { status: string; started_at: number | null; attempt: number; model: string; provider_id: string | null }
    | undefined;
  if (!last || last.status === "queued" || last.status === "running") return;
  const kids = childrenOf(epicId);
  if (!kids.some((k) => (k.settled_at ?? 0) > (last.started_at ?? 0))) {
    if (!openChildren(kids).length) failEpic(epicId, "The planner ended a round without complete_epic while no child ticket was open, so nothing would start another round.");
    return;
  }
  if (last.attempt >= MAX_ROUNDS) return failEpic(epicId, `Planner round limit reached (${MAX_ROUNDS} rounds) before the epic was completed.`);
  queue(ticketRow(epicId)!, last.model, last.attempt + 1, last.provider_id, true); // same provider and model as the last round
}

export function cancelRun(runId: string) {
  const ac = controllers.get(runId);
  if (ac) {
    ac.abort();
    return true;
  }
  const queued = db.prepare("SELECT ticket_id, eval_run_id FROM runs WHERE id = ? AND status = 'queued'").get(runId) as { ticket_id: string; eval_run_id: string | null } | undefined;
  if (!queued) return false;
  eventLog(runId)({ type: "run_finished", payload: { status: "cancelled", reason: "cancelled while queued", turns: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } });
  if (queued.eval_run_id) recordEvalResult(runId, false, 0); // counts as failed; the source ticket is never touched
  else setTicket(queued.ticket_id, "todo");
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
    void reflectOn(r.id, t.workspace_id, run, undefined, note).then((payload) => eventLog(r.id)({ type: "reflection", payload }));
  }
  await cleanupTicket(ticketId, t.workspace_id);
  if (!t.parent_id) return setTicket(ticketId, "todo");
  db.prepare("UPDATE tickets SET handoff = COALESCE(handoff || char(10) || char(10), '') || ? WHERE id = ?").run(`Rejected by the reviewer${note ? `: ${note}` : " (no note)"}.`, ticketId);
  setTicket(ticketId, "failed");
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

// Startup: runs left running by a dead process are failed (their worktrees and containers removed); queued runs
// stay queued and start now.
export function recoverOrphans() {
  const orphans = db.prepare(`SELECT r.id, r.ticket_id, r.role, r.worktree, r.branch, r.eval_run_id, t.workspace_id, c.repo_path AS eval_repo FROM runs r
    JOIN tickets t ON t.id = r.ticket_id LEFT JOIN eval_cases c ON c.id = r.eval_case_id WHERE r.status = 'running'`).all() as {
    id: string; ticket_id: string; role: string; worktree: string | null; branch: string | null; eval_run_id: string | null; workspace_id: string; eval_repo: string | null;
  }[];
  const dead = orphans.filter((o) => !controllers.has(o.id));
  for (const o of dead) {
    const log = eventLog(o.id);
    const message = "interrupted by server restart";
    log({ type: "error", payload: { kind: "UnexpectedEnvironment", message } });
    const r = db.prepare("SELECT tokens_in, tokens_out, tokens_cached FROM runs WHERE id = ?").get(o.id) as Record<string, number>;
    const usage = { input: r.tokens_in, output: r.tokens_out, cache_read: r.tokens_cached, cache_write: 0 };
    log({ type: "run_finished", payload: { status: "failed", reason: message, turns: 0, usage } });
    if (o.eval_run_id) {
      recordEvalResult(o.id, false, 0);
      if (o.eval_repo) void removeWorktree(o.eval_repo, o.worktree, null, dataDir());
      continue;
    }
    setTicket(o.ticket_id, "failed");
    const s = (o.branch || o.role === "planner") && settingsFor(o.workspace_id); // CLI runs have neither: their worktree is the user's dir
    if (s) void removeWorktree(s.repo_path, o.worktree, o.branch, dataDir());
  }
  void removeStaleContainers().then(pump); // sweep first, or it could remove a fresh run's container
  return dead.length;
}
