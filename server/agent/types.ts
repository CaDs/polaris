// Internal message format: Anthropic-style content blocks. Providers translate to/from their wire format.

export type TextBlock = { type: "text"; text: string };
// invalid_input: the raw argument text when the provider sent JSON that did not parse (truncated); input is {} then.
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; namespace?: string; input: Record<string, unknown>; invalid_input?: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; namespace?: string; content: string; is_error?: boolean };
// Provider-owned data (e.g. Anthropic thinking blocks with signatures). Sent back to that provider verbatim.
type ReasoningBlock = { type: "reasoning"; provider: string; data: unknown };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export type Msg = { role: "user" | "assistant"; content: Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type Usage = { input: number; output: number; cache_read: number; cache_write: number };
export const noUsage = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
export type UsageStatus = "reported" | "partial" | "unavailable";
// cost_usd: what the provider itself billed for the request (OpenRouter reports it); absent = priced from the table.
export type RequestUsage = { id: string; usage: Usage; status: UsageStatus; outcome: "completed" | "failed" | "cancelled"; started_at: number; cost_usd?: number };
export const totalTokens = (u: Usage) => u.input + u.output + u.cache_read + u.cache_write;
// Same value, object keys sorted (canonical JSON once stringified).
export const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)])) : v;
export const addUsage = (into: Usage, u: Usage) => (Object.keys(into) as (keyof Usage)[]).forEach((k) => (into[k] += u[k]));

// Live deltas for transcripts. The final Msg is authoritative.
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "request_usage"; request: RequestUsage }
  | { type: "retry"; attempt: number; max: number; message: string; delay_ms: number }; // the adapter is retrying before any output

export type ProviderRequest = {
  system: Block[];
  messages: Msg[];
  tools: ToolDef[];
  model: string;
  maxTokens?: number;
  metering?: boolean; // transport-attempt telemetry, consumed by the accounting decorator
  cacheKey?: string; // routes requests of one ticket to the same provider-side cache (OpenAI prompt_cache_key)
  signal?: AbortSignal;
};
export type ProviderResponse = { message: Msg; usage: Usage; stopReason: string; usageStatus?: UsageStatus; metered?: boolean; costUsd?: number };

export interface Provider {
  stream(req: ProviderRequest, onEvent: (e: StreamEvent) => void): Promise<ProviderResponse>;
  // A self-hosted model (Ollama, a LiteLLM proxy on this network): it may be loading, swapping or prefilling a long prompt
  // before the first byte, so callers wait LOCAL_MODEL_TIMEOUT instead of their usual deadline.
  local?: boolean;
}

// Anything not one of these is a harness bug and reported as "Unknown".
// SpendingCap / SpendingCapWarning: the harness refused (warned about) a call over (at 80% of) a spending cap (runs.ts capCheck).
export type ErrorKind = "InvalidArguments" | "UnexpectedEnvironment" | "ProviderError" | "Timeout" | "UserAborted" | "Unknown" | "SpendingCap" | "SpendingCapWarning";

export class AgentError extends Error {
  kind: ErrorKind;
  // Provider adapters only: worth retrying if nothing was streamed yet (429/5xx/overloaded/network); retry-after in ms.
  retryable = false;
  retryAfterMs?: number;
  usage?: Usage;
  usageStatus?: UsageStatus;
  requestSent?: boolean;
  code?: string;
  requestId?: string;
  badInput = false; // InvalidArguments about the shape of the tool's input (missing or mistyped field): runTool adds the expected input
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type RunStatus = "passed" | "failed" | "cancelled";

// M12 stuck monitor (loop.ts STUCK). no_tool is reserved: text-only replies already end the run (see SPEC).
export type StuckSignal = "repeat_call" | "no_progress" | "repeat_error" | "no_tool";
// Per-run counts for failure mining, logged as run_metrics right before run_finished.
export type RunMetrics = {
  turns: number; tool_calls: number; tool_errors: number;
  repeated_calls: number; // tool calls identical (name + input) to an earlier one in the run
  repeated_reads: number; // read_file answered by the dedupe stub
  compactions: number;
  first_edit_turn: number | null; // first successful edit_file/apply_patch/delete_file, 1-based
  files_changed: number | null; // worker runs (runs.ts, from the worktree diff); null otherwise
  turns_pct: number; minutes_pct: number | null; // 0-100 of the budget; minutes_pct only with a deadline
  minutes: number; // elapsed wall-clock minutes, 1 decimal
  // Where the time went, whole seconds: waiting for the model, running tools (shell included), running shell commands.
  model_secs: number; tool_secs: number; shell_secs: number;
  input: number; output: number; cache_read: number;
  stuck: null | { turn: number; signal: StuckSignal; action: "nudge" | "stop" };
};

export type Finding = { file: string; line?: number; problem: string; fix: string };

// Event log payloads, keyed by events.type.
export type EventPayloads = {
  run_started: { model: string; task: string; root: string };
  assistant_message: { message: Msg; stop_reason: string };
  tool_call: { id: string; name: string; input: Record<string, unknown> };
  tool_result: { tool_use_id: string; content: string; is_error: boolean; error_kind?: ErrorKind };
  usage: Usage & { metered?: boolean };
  // retrying: a provider call failed and is being retried. cap: a SpendingCap(Warning)'s numbers (usd or tokens).
  error: { kind: ErrorKind; message: string; retrying?: boolean; cap?: { which: string; used: number; cap: number } };
  // Conversation n was summarized and replaced by a fresh one (see loop.ts).
  compaction: { n: number; tokens_before: number; summary_chars: number; history_path: string };
  run_finished: { status: RunStatus; reason?: string; turns: number; usage: Usage };
  // M12: the stuck monitor nudged the model, or (second time) ended the attempt.
  stuck: { turn: number; signal: StuckSignal; detail: string; action: "nudge" | "stop" };
  run_metrics: RunMetrics;
  // M3 orchestration (server/runs.ts): sandbox setup, test gate, commit of a passing run, review decision.
  setup: { step: "worktree"; branch: string; base_sha: string } /* branch "" = detached (eval) */ | { step: "sandbox"; sandbox: string } | { step: "context"; window: number; source: string; compact_at: number } | { step: "skills"; skills: { name: string; description: string; path: string }[] } | { step: "command"; command: string; code: number | null; output: string } | { step: "resumed"; from: string; turns: number };
  // flaky: the command failed, then passed on an immediate re-run (first_failure is the first run); the gate passed.
  test_result: { passed: boolean; command: string; code: number | null; timed_out: boolean; output: string; protected: string[]; nested?: string[]; clean?: true; flaky?: true; first_failure?: { code: number | null; timed_out: boolean; output: string } };
  // The test gate failed and the worker's own conversation is resumed to fix it (reason: gateFailure).
  gate_fix: { reason: string };
  commit: { sha: string; branch: string };
  review: { decision: "approved" | "rejected"; note?: string; merge_sha?: string };
  // M6: the series this run ended was reflected on (server/improve.ts). unchanged: the model returned the same lessons.
  reflection: { lessons_id: string; version: number; chars: number; unchanged: boolean; usage: Usage; accounted?: boolean } | { error: string } | { skipped: "provider_error" | "environment" };
  // M7: a child ticket's run series ended; text is what its planner reads (server/planner.ts).
  handoff: { text: string };
  // M7: a planner round ended: finish_round notes, or the complete_epic summary (completed).
  round_finished: { round: number; notes: string; completed: boolean };
  // M8: the same model reviewed the change before a human sees it (server/review.ts). error: the reviewer failed; the run went on (fail-open).
  model_review_started: { round: number; budget: number; lines: number; model: string }; // budget: the reviewer's turns, from the changed lines; model: the reviewer's
  model_review: { round: number; verdict: "approve" | "request_changes" | "error"; findings: Finding[]; message?: string };
  // M9: complete_epic first ran this command on the base branch's head (sha); failed → complete_epic was refused.
  epic_gate: { passed: boolean; command: string; code: number | null; timed_out: boolean; output: string; sha: string; flaky?: true; first_failure?: { code: number | null; timed_out: boolean; output: string } };
  // M9: the triage model scored a new ticket's size (0 trivial … 4 epic); split = it became a "Split:" epic. error: ran directly.
  // reason: a chat model's one sentence (System One gives probabilities and confidence instead).
  triage: { model: string; split: boolean; score?: number; probabilities?: Record<string, number>; confidence?: number; reason?: string; error?: string };
  // POL-30: this attempt runs on the escalation model instead of the previous attempt's (logged first, before run_started).
  escalated: { from: string; to: string; reason: string; attempt: number };
  // M10: a wiki maintainer run ended: the wiki commit it made, nothing to commit (unchanged), or the mechanical problems that rejected it.
  wiki: { op: "ingest" | "bootstrap" | "lint"; commit?: string; unchanged?: boolean; problems?: string[] }; // ingest: before the project memory
  // Project memory: what a passing run proposes to remember (the human confirms it when approving), and what an approval wrote.
  memory_proposal: { items: { kind: "decision" | "rule" | "gotcha"; title: string; body: string; supersedes?: string }[] } | { error: string };
  memory: { paths: string[]; commit: string } | { error: string };
};
export type AgentEvent = { [K in keyof EventPayloads]: { type: K; payload: EventPayloads[K] } }[keyof EventPayloads];
