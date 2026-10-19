// Internal message format: Anthropic-style content blocks. Providers translate to/from their wire format.

export type TextBlock = { type: "text"; text: string };
// invalid_input: the raw argument text when the provider sent JSON that did not parse (truncated); input is {} then.
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; invalid_input?: string };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
// Provider-owned data (e.g. Anthropic thinking blocks with signatures). Sent back to that provider verbatim.
export type ReasoningBlock = { type: "reasoning"; provider: string; data: unknown };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export type Msg = { role: "user" | "assistant"; content: Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type Usage = { input: number; output: number; cache_read: number; cache_write: number };

// Live deltas for transcripts. The final Msg is authoritative.
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "retry"; attempt: number; max: number; message: string; delay_ms: number }; // the adapter is retrying before any output

export type ProviderRequest = {
  system: Block[];
  messages: Msg[];
  tools: ToolDef[];
  model: string;
  maxTokens?: number;
  cacheKey?: string; // routes requests of one ticket to the same provider-side cache (OpenAI prompt_cache_key)
  signal?: AbortSignal;
};
export type ProviderResponse = { message: Msg; usage: Usage; stopReason: string };

export interface Provider {
  stream(req: ProviderRequest, onEvent: (e: StreamEvent) => void): Promise<ProviderResponse>;
}

// Anything not one of these is a harness bug and reported as "Unknown".
export type ErrorKind = "InvalidArguments" | "UnexpectedEnvironment" | "ProviderError" | "Timeout" | "UserAborted" | "Unknown";

export class AgentError extends Error {
  kind: ErrorKind;
  // Provider adapters only: worth retrying if nothing was streamed yet (429/5xx/overloaded/network); retry-after in ms.
  retryable = false;
  retryAfterMs?: number;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type RunStatus = "passed" | "failed" | "cancelled";

// Event log payloads, keyed by events.type.
export type EventPayloads = {
  run_started: { model: string; task: string; root: string };
  assistant_message: { message: Msg; stop_reason: string };
  tool_call: { id: string; name: string; input: Record<string, unknown> };
  tool_result: { tool_use_id: string; content: string; is_error: boolean; error_kind?: ErrorKind };
  usage: Usage;
  error: { kind: ErrorKind; message: string; retrying?: boolean }; // retrying: a provider call failed and is being retried
  // Conversation n was summarized and replaced by a fresh one (see loop.ts).
  compaction: { n: number; tokens_before: number; summary_chars: number; history_path: string };
  run_finished: { status: RunStatus; reason?: string; turns: number; usage: Usage };
  // M3 orchestration (server/runs.ts): sandbox setup, test gate, commit of a passing run, review decision.
  setup: { step: "worktree"; branch: string; base_sha: string } /* branch "" = detached (eval) */ | { step: "sandbox"; sandbox: string } | { step: "skills"; skills: { name: string; description: string; path: string }[] } | { step: "command"; command: string; code: number | null; output: string };
  test_result: { passed: boolean; command: string; code: number | null; timed_out: boolean; output: string; protected: string[] };
  commit: { sha: string; branch: string };
  review: { decision: "approved" | "rejected"; note?: string; merge_sha?: string };
  // M6: the series this run ended was reflected on (server/improve.ts). unchanged: the model returned the same lessons.
  reflection: { lessons_id: string; version: number; chars: number; unchanged: boolean; usage: Usage } | { error: string };
  // M7: a child ticket's run series ended; text is what its planner reads (server/planner.ts).
  handoff: { text: string };
  // M7: a planner round ended: finish_round notes, or the complete_epic summary (completed).
  round_finished: { round: number; notes: string; completed: boolean };
};
export type AgentEvent = { [K in keyof EventPayloads]: { type: K; payload: EventPayloads[K] } }[keyof EventPayloads];
