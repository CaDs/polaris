import { existsSync } from "node:fs";
import { join } from "node:path";
import { compactedTask, CONTINUE_REQUEST, historyMarkdown, readPaths, SUMMARY_REQUEST, workState } from "./context.ts";
import { runTool, hostExec, writeScratch, type Exec, type Tool } from "./tools.ts";
import { addUsage, AgentError, noUsage, type AgentEvent, type Block, type Msg, type Provider, type RunStatus, type StreamEvent, type Usage } from "./types.ts";

export type RunOptions = {
  provider: Provider;
  model: string;
  system: string;
  task: string; // the whole first user message: per-run context (environment, skills, earlier failures) ahead of the ticket
  resume?: { messages: Msg[]; message: string }; // continue that conversation with a new user message (the worker, after review findings); task is still the original (compaction)
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

export type RunResult = { status: RunStatus; reason?: string; turns: number; usage: Usage; messages: Msg[] };

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const MAX_CONTINUES = 2;

// Conversations are append-only: thinking blocks are bound to the exact history that produced them, and editing or
// reordering earlier messages busts the prompt cache. So nothing in `messages` is ever changed, and compaction does not
// shorten it: it appends a summary request, then starts a NEW conversation (fresh array) seeded with task + summary.
// Tools and system prompt never change either.
export async function runAgent(o: RunOptions): Promise<RunResult> {
  let messages: Msg[] = o.resume ? [...o.resume.messages, user(o.resume.message)] : [user(o.task)];
  const usage = noUsage();
  const ctx = { root: o.root, exec: o.exec ?? hostExec, signal: o.signal, protectedPaths: o.protectedPaths };
  let reads = new Map<string, { out: string; turn: number }>(); // read_file dedupe; belongs to the current conversation (see compact)
  const system = [{ type: "text" as const, text: o.system }];
  const histories: string[] = []; // .polaris/history/<n>.md, one per compaction
  let contextTokens = 0;
  let continues = 0;
  let turns = 0;
  let hinted = false;
  const now = o.now ?? Date.now;
  const began = now();
  let status: RunStatus = "failed";
  let reason: string | undefined;

  // Provider retries surface as `error` events flagged retrying.
  const stream = (e: StreamEvent) =>
    e.type === "retry"
      ? o.onEvent({ type: "error", payload: { kind: "ProviderError", message: `${e.message} (retry ${e.attempt}/${e.max} in ${e.delay_ms} ms)`, retrying: true } })
      : o.onStream?.(e);

  // One model call: appends the reply to the current conversation and books its usage.
  async function turn() {
    const res = await o.provider.stream({ system, messages, tools: o.tools.map((t) => t.def), model: o.model, cacheKey: o.cacheKey, signal: o.signal }, stream);
    turns++;
    messages.push(res.message);
    addUsage(usage, res.usage);
    contextTokens = res.usage.input + res.usage.cache_read + res.usage.cache_write;
    o.onEvent({ type: "assistant_message", payload: { message: res.message, stop_reason: res.stopReason } });
    o.onEvent({ type: "usage", payload: res.usage });
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
    const res = await turn(); // tools stay in the request (changing them would bust the cache); any calls it makes are ignored
    const summary = res.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() || "(the model wrote no summary)";
    writeScratch(o.root, path, `\n## Summary written at compaction\n\n${summary}\n`, true);
    histories.push(path);
    const state = await workState(ctx.exec, o.root, o.signal);
    messages = [user(compactedTask(o.resume ? `${o.task}\n\n${o.resume.message}` : o.task, summary, histories, state, readPaths(messages)))];
    reads = new Map(); // the earlier outputs are no longer in the conversation
    contextTokens = 0;
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
      for (const call of calls) {
        o.onEvent({ type: "tool_call", payload: { id: call.id, name: call.name, input: call.input } });
        const r = o.signal?.aborted
          ? { content: "UserAborted: run cancelled before this tool ran", is_error: true, kind: "UserAborted" as const }
          : await runTool(o.tools, call, { ...ctx, turn: turns, reads });
        o.onEvent({ type: "tool_result", payload: { tool_use_id: call.id, content: r.content, is_error: r.is_error, error_kind: r.kind } });
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, is_error: r.is_error });
      }
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
  o.onEvent({ type: "run_finished", payload: { status, reason, turns, usage } });
  return { status, reason, turns, usage, messages };
}
