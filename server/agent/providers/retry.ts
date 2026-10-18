import { AgentError, type StreamEvent } from "../types.ts";

// Provider retries: HTTP 429/500/502/503/504/529, "overloaded" and network errors are retried up to RETRIES times with
// exponential backoff + jitter (or the server's retry-after), but only while nothing was streamed to the caller yet:
// after partial output a retry would duplicate it.
const RETRIES = 4;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_DELAY = 60_000;

// "Retry-After: 2", "0.5" or an HTTP date → milliseconds.
function retryAfter(h: string | null) {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isNaN(secs) ? Date.parse(h) - Date.now() : secs * 1000;
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), MAX_DELAY);
}

export function retryable(e: AgentError, afterMs?: number) {
  e.retryable = true;
  e.retryAfterMs = afterMs;
  return e;
}

// ProviderError for a non-2xx response, flagged retryable when the status (or an "overloaded" body) says so.
export function httpError(res: Response, body: string) {
  const e = new AgentError("ProviderError", `HTTP ${res.status}: ${body.slice(0, 1000)}`);
  return RETRY_STATUS.has(res.status) || /overloaded/i.test(body) ? retryable(e, retryAfter(res.headers.get("retry-after"))) : e;
}

// Runs one request attempt; `once` gets an onEvent that marks the attempt as having produced output.
export async function withRetry<T>(onEvent: (e: StreamEvent) => void, signal: AbortSignal | undefined, once: (on: (e: StreamEvent) => void) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return await once((e) => ((started = true), onEvent(e)));
    } catch (e) {
      if (started || !(e instanceof AgentError && e.retryable) || attempt >= RETRIES || signal?.aborted) throw e;
      // HARNESS_RETRY_BASE_MS: tests shrink the backoff.
      const base = Number(process.env.HARNESS_RETRY_BASE_MS ?? 1000);
      const delay = e.retryAfterMs ?? Math.min(base * 2 ** attempt, 30_000) * (1 + Math.random() * 0.25);
      onEvent({ type: "retry", attempt: attempt + 1, max: RETRIES, message: e.message, delay_ms: Math.round(delay) });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve(0)), { once: true });
      });
      if (signal?.aborted) throw e;
    }
  }
}
