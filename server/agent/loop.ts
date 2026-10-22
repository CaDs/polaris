import { usagePurpose } from "../usage.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compactedTask, CONTINUE_REQUEST, historyMarkdown, readPaths, SUMMARY_REQUEST, workState } from "./context.ts";
import { runTool, hostExec, writeScratch, type Exec, type Tool } from "./tools.ts";
import { addUsage, AgentError, noUsage, stable, type AgentEvent, type Block, type Msg, type Provider, type RunMetrics, type RunStatus, type StreamEvent, type Usage } from "./types.ts";

export type RunOptions = {
  provider: Provider;
  model: string;
  system: string;
  task: string; // the whole first user message: per-run context (environment, skills, earlier failures) ahead of the ticket
  // Continue that conversation (task is still the original, for compaction): with a new user message (the worker, after
  // review findings), or without one when it already ends with the user's turn (an attempt resumed after a restart).
  resume?: { messages: Msg[]; message?: string };
  cacheKey?: string; // passed to providers that route cache hits by key (one per ticket)
  compactAt?: number; // context tokens (input + cache read + cache write of the latest request) above which the conversation is compacted
  tools: Tool[];
  root: string;
  exec?: Exec;
  protectedPaths?: string[];
  // maxTokens counts input (incl. cache writes) + output; cache reads are not counted.
  // deadline: epoch ms wall-clock limit (minutes is only for the message: the budget the deadline came from, which a resumed run has partly used).
  budget: { maxTurns: number; maxTokens: number; deadline?: number; minutes?: number };
  now?: () => number; // clock for the deadline (tests)
  signal?: AbortSignal;
  finished?: () => boolean; // checked after each batch of tool calls: true ends the run as passed (planner: finish_round/complete_epic)
  finishHint?: string; // told to the model when 2 turns are left or the time is nearly up, so it wraps up instead of running out (a reviewer once used all 25 exploring)
  onEvent: (e: AgentEvent) => void;
  onStream?: (e: StreamEvent) => void;
};

export type RunResult = { status: RunStatus; reason?: string; turns: number; usage: Usage; messages: Msg[]; metrics: RunMetrics };

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const MAX_CONTINUES = 2;

// Stuck monitor, checked after each turn's tool calls: the first detection nudges (a [harness] note with the results), the
// next ends the run failed with `stuck: <signal> (<detail>)`. Counters restart at the nudge and per runAgent call (resume).
const STUCK = {
  window: 6, // repeat_call: turns looked back over
  repeats: 3, // repeat_call: the same call (name + input) with the same result in this many of them
  errors: 3, // repeat_error: the same tool error this many times in a row
  idle: 8, // no_progress: turns in a row of only reads, searches and failed calls (a shell call that succeeds may have written)
  explore: 20, // no_progress before the first write: only after this turn (an 11-file ticket needs the reading)
  persist: 4, // no_progress after its own nudge: this many more idle turns end the run
};
const WRITES = ["edit_file", "apply_patch", "delete_file"];
const NUDGE = {
  repeat_call: (d: string) => `You called ${d}. Calling it again will not change the result: take a different step, or finish with what you have.`,
  repeat_error: (d: string) => `You repeated ${d}. Retrying it the same way fails the same way: take a different step, or finish with what you have.`,
  no_progress: (d: string) => `No progress: ${d}. More reading will not finish the task: make the change now, or finish with what you have.`,
};
const callKey = (b: { name: string; input: unknown }) => `${b.name} ${JSON.stringify(stable(b.input))}`;

// Metrics of consecutive calls on one run (a worker and its fix rounds): counts add up, the later call's turns are offset
// by the earlier's. Percentages and tokens are the later call's (the pipeline sets its own).
export const addMetrics = (a: RunMetrics, b: RunMetrics): RunMetrics => ({
  ...b,
  turns: a.turns + b.turns, tool_calls: a.tool_calls + b.tool_calls, tool_errors: a.tool_errors + b.tool_errors,
  repeated_calls: a.repeated_calls + b.repeated_calls, repeated_reads: a.repeated_reads + b.repeated_reads, compactions: a.compactions + b.compactions,
  first_edit_turn: a.first_edit_turn ?? (b.first_edit_turn && a.turns + b.first_edit_turn), minutes: Math.round((a.minutes + b.minutes) * 10) / 10,
  model_secs: (a.model_secs ?? 0) + b.model_secs, tool_secs: (a.tool_secs ?? 0) + b.tool_secs, shell_secs: (a.shell_secs ?? 0) + b.shell_secs,
  stuck: b.stuck ? { ...b.stuck, turn: a.turns + b.stuck.turn } : a.stuck,
});

// Conversations are append-only: thinking blocks are bound to the exact history that produced them, and editing or
// reordering earlier messages busts the prompt cache. So nothing in `messages` is ever changed, and compaction does not
// shorten it: it appends a summary request, then starts a NEW conversation (fresh array) seeded with task + summary.
// Tools and system prompt never change either.
export async function runAgent(o: RunOptions): Promise<RunResult> {
  let messages: Msg[] = o.resume ? [...o.resume.messages, ...(o.resume.message ? [user(o.resume.message)] : [])] : [user(o.task)];
  const usage = noUsage();
  const ctx = { root: o.root, exec: o.exec ?? hostExec, signal: o.signal, protectedPaths: o.protectedPaths };
  let reads = new Map<string, { out: string; turn: number }>(); // read_file dedupe; belongs to the current conversation (see compact)
  const system = [{ type: "text" as const, text: o.system }];
  const histories: string[] = []; // .polaris/history/<n>.md, one per compaction
  let contextTokens = 0;
  let continues = 0;
  let turns = 0;
  let hinted = false;
  const m = { tool_calls: 0, tool_errors: 0, repeated_calls: 0, repeated_reads: 0, compactions: 0, first_edit_turn: null as number | null };
  const ms = { model: 0, tool: 0, shell: 0 }; // where the time went (RunMetrics *_secs)
  const seen = new Set(o.resume?.messages.flatMap((msg) => msg.content.flatMap((b) => (b.type === "tool_use" ? [callKey(b)] : []))));
  // Stuck monitor (see STUCK): call+result pairs of the recent turns, idle turns in a row, the same-error streak.
  let recent: string[][] = [];
  const outputs = new Map<string, string>(); // latest result per call, so a dedupe stub matches the read it points at
  let idle = 0;
  let errors = 0;
  let lastError = "";
  let wrote = false;
  let nudged: keyof typeof NUDGE | undefined;
  let stuck: RunMetrics["stuck"] = null;
  const canWrite = o.tools.some((t) => WRITES.includes(t.def.name)); // no_progress only for roles that edit (not planner, reviewer)
  const now = o.now ?? Date.now;
  const began = now();
  let status: RunStatus = "failed";
  let reason: string | undefined;

  // Provider retries surface as `error` events flagged retrying.
  const stream = (e: StreamEvent) =>
    e.type === "retry"
      ? o.onEvent({ type: "error", payload: { kind: "ProviderError", message: `${e.message} (retry ${e.attempt}/${e.max} in ${e.delay_ms} ms)`, retrying: true } })
      : o.onStream?.(e);

  function detect(): { signal: keyof typeof NUDGE; detail: string } | undefined {
    if (errors >= STUCK.errors) return { signal: "repeat_error", detail: `a call that failed ${errors} times in a row with: ${lastError.slice(0, 200)}` };
    const counts = new Map<string, number>();
    for (const t of recent) for (const p of t) counts.set(p, (counts.get(p) ?? 0) + 1);
    const rep = [...counts].find(([, n]) => n >= STUCK.repeats);
    if (rep) return { signal: "repeat_call", detail: `${rep[0].split("\0")[0].slice(0, 200)} ${rep[1]} times in the last ${recent.length} turns with the same result` };
    if (canWrite && idle >= (nudged === "no_progress" ? STUCK.persist : STUCK.idle) && (wrote || turns > STUCK.explore))
      return { signal: "no_progress", detail: `${idle} turns of only reads and searches${wrote ? " since the last edit" : ", no edit yet"}` };
  }

  // One model call: appends the reply to the current conversation and books its usage.
  async function turn(summary = false) {
    const t0 = now();
    const res = await usagePurpose(summary ? "compaction" : "", () => o.provider.stream({ system, messages, tools: o.tools.map((t) => t.def), model: o.model, cacheKey: o.cacheKey, signal: o.signal }, stream));
    ms.model += now() - t0;
    turns++;
    messages.push(res.message);
    addUsage(usage, res.usage);
    contextTokens = res.usage.input + res.usage.cache_read + res.usage.cache_write;
    o.onEvent({ type: "assistant_message", payload: { message: res.message, stop_reason: res.stopReason } });
    o.onEvent({ type: "usage", payload: { ...res.usage, ...(res.metered ? { metered: true } : {}) } });
    return res;
  }

  // Full history to a file, one summary-only turn, then a fresh conversation: task + summary + pointer to the history.
  // A resumed run (fix round) shares the worktree with the call before it: take the next free history file, and keep the
  // new user message in the fresh conversation's task.
  async function compact() {
    let n = 1;
    while (existsSync(join(o.root, `.polaris/history/${n}.md`))) n++;
    const path = `.polaris/history/${n}.md`;
    writeScratch(o.root, path, historyMarkdown(messages, n));
    const before = contextTokens;
    messages.push(user(SUMMARY_REQUEST));
    const res = await turn(true); // tools stay in the request (changing them would bust the cache); any calls it makes are ignored
    const summary = res.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() || "(the model wrote no summary)";
    writeScratch(o.root, path, `\n## Summary written at compaction\n\n${summary}\n`, true);
    histories.push(path);
    const state = await workState(ctx.exec, o.root, o.signal);
    messages = [user(compactedTask(o.resume?.message ? `${o.task}\n\n${o.resume.message}` : o.task, summary, histories, state, readPaths(messages)))];
    reads = new Map(); // the earlier outputs are no longer in the conversation
    contextTokens = 0;
    m.compactions++;
    o.onEvent({ type: "compaction", payload: { n, tokens_before: before, summary_chars: summary.length, history_path: path } });
  }

  o.onEvent({ type: "run_started", payload: { model: o.model, task: o.task, root: o.root } });
  try {
    for (;;) {
      if (o.signal?.aborted) throw new AgentError("UserAborted", "run cancelled");
      if (turns >= o.budget.maxTurns) {
        reason = `turn budget exhausted (${o.budget.maxTurns})`;
        break;
      }
      const { deadline } = o.budget;
      if (deadline !== undefined && now() >= deadline) {
        reason = `time budget exhausted (${o.budget.minutes ?? Math.round((deadline - began) / 60_000)} min)`;
        break;
      }
      const spent = usage.input + usage.cache_write + usage.output;
      if (spent >= o.budget.maxTokens) {
        reason = `token budget exhausted (${spent} >= ${o.budget.maxTokens})`;
        break;
      }
      // At least two turns per conversation, so a fresh conversation that already starts above the threshold
      // (big summary, tiny window) makes progress instead of compacting on every turn.
      if (o.compactAt && contextTokens > o.compactAt && messages.length >= 5) {
        await compact();
        continue; // budgets are checked again
      }

      const res = await turn();
      const calls = res.message.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        if (res.stopReason === "refusal") {
          reason = "ProviderError: the model refused (stop_reason refusal)";
          break;
        }
        // Cut off by the output limit is not a finished answer: ask it to continue (a couple of times).
        if (res.stopReason === "max_tokens" || res.stopReason === "max_output_tokens") {
          if (continues++ >= MAX_CONTINUES) {
            reason = `the reply was cut off by the output token limit ${MAX_CONTINUES + 1} times in a row`;
            break;
          }
          messages.push(user(CONTINUE_REQUEST));
          continue;
        }
        status = "passed";
        break;
      }
      continues = 0;
      const results: Block[] = [];
      const pairs = new Set<string>();
      let busy = false; // a write, or a shell call that may have written
      for (const call of calls) {
        o.onEvent({ type: "tool_call", payload: { id: call.id, name: call.name, input: call.input } });
        const t1 = now();
        const r = o.signal?.aborted
          ? { content: "UserAborted: run cancelled before this tool ran", is_error: true, kind: "UserAborted" as const }
          : await runTool(o.tools, call, { ...ctx, turn: turns, reads });
        ms.tool += now() - t1;
        if (call.name === "shell") ms.shell += now() - t1;
        o.onEvent({ type: "tool_result", payload: { tool_use_id: call.id, content: r.content, is_error: r.is_error, error_kind: r.kind } });
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, is_error: r.is_error, ...(call.namespace ? { namespace: call.namespace } : {}) });
        const key = callKey(call);
        if (seen.has(key)) m.repeated_calls++;
        seen.add(key);
        const unchanged = call.name === "read_file" && r.content.startsWith("[unchanged since"); // the dedupe stub: same output as before
        if (unchanged) m.repeated_reads++;
        else outputs.set(key, r.content);
        pairs.add(`${key}\0${outputs.get(key) ?? r.content}`);
        m.tool_calls++;
        if (r.is_error) m.tool_errors++;
        errors = r.is_error ? (r.content === lastError ? errors + 1 : 1) : 0;
        lastError = r.is_error ? r.content : "";
        if (!r.is_error && WRITES.includes(call.name)) (wrote = true), (m.first_edit_turn ??= turns);
        if (!r.is_error && (call.name === "shell" || WRITES.includes(call.name))) busy = true;
      }
      recent = [...recent, [...pairs]].slice(-STUCK.window);
      idle = busy ? 0 : idle + 1;
      const found = detect();
      if (found && !nudged) results.push({ type: "text", text: `[harness] ${NUDGE[found.signal](found.detail)}` });
      // Time is nearly up when under 10% of this call's window (min 2 minutes) remains; once, whichever limit comes first.
      const left = deadline === undefined ? Infinity : deadline - now();
      const lowTime = left < Math.max(120_000, ((deadline ?? 0) - began) / 10);
      if (o.finishHint && !hinted && (turns >= o.budget.maxTurns - 2 || lowTime)) {
        hinted = true;
        results.push({ type: "text", text: `[harness] ${lowTime ? `Less than ${Math.max(1, Math.ceil(left / 60_000))} minutes are` : "Only 2 turns are"} left in your budget. ${o.finishHint}` });
      }
      messages.push({ role: "user", content: results });
      if (o.finished?.()) {
        status = "passed";
        break;
      }
      if (found) {
        stuck = { turn: turns, signal: found.signal, action: nudged ? "stop" : "nudge" };
        o.onEvent({ type: "stuck", payload: { ...stuck, detail: found.detail } });
        if (nudged) {
          reason = `stuck: ${found.signal} (${found.detail})`;
          break;
        }
        [nudged, recent, idle, errors] = [found.signal, [], 0, 0];
      }
    }
  } catch (e) {
    if (o.signal?.aborted) {
      status = "cancelled";
      reason = "cancelled";
    } else {
      const kind = e instanceof AgentError ? e.kind : "Unknown";
      reason = `${kind}: ${(e as Error).message}`;
      o.onEvent({ type: "error", payload: { kind, message: (e as Error).message } });
    }
  }
  const { deadline } = o.budget;
  const metrics: RunMetrics = {
    turns, ...m, files_changed: null, turns_pct: Math.round((turns / o.budget.maxTurns) * 100),
    minutes: Math.round((now() - began) / 6_000) / 10,
    model_secs: Math.round(ms.model / 1000), tool_secs: Math.round(ms.tool / 1000), shell_secs: Math.round(ms.shell / 1000),
    minutes_pct: deadline === undefined ? null : Math.round(((now() - began) / Math.max(1, deadline - began)) * 100),
    input: usage.input, output: usage.output, cache_read: usage.cache_read, stuck,
  };
  o.onEvent({ type: "run_metrics", payload: metrics });
  o.onEvent({ type: "run_finished", payload: { status, reason, turns, usage } });
  return { status, reason, turns, usage, messages, metrics };
}
