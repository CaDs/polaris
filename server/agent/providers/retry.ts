import { randomUUID } from "node:crypto";
import { AgentError, noUsage, type ProviderResponse, type StreamEvent } from "../types.ts";

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
  let code: string | undefined;
  try { code = JSON.parse(body)?.error?.code; } catch {}
  const e = new AgentError("ProviderError", `HTTP ${res.status}: ${body.slice(0, 1000)}`);
  e.code = code;
  e.requestId = res.headers.get("x-request-id") ?? undefined;
  if (code && /subscription_sharing_usage_limit_exceeded|subscription_sharing_user_not_eligible|subscription_sharing_unsupported_capability|subscription_sharing_route_not_supported|subscription_sharing_invalid_user|chatpass_v2_/.test(code)) return e;
  return RETRY_STATUS.has(res.status) || /overloaded/i.test(body) ? retryable(e, retryAfter(res.headers.get("retry-after"))) : e;
}

// Runs one request attempt; `once` gets an onEvent that marks the attempt as having produced output.
export async function withRetry<T>(onEvent: (e: StreamEvent) => void, signal: AbortSignal | undefined, once: (on: (e: StreamEvent) => void) => Promise<T>, metering = false): Promise<T> {
  if (signal?.aborted) {
    const e = new AgentError("UserAborted", "cancelled before the request started");
    e.requestSent = false;
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    let started = false;
    const id = randomUUID();
    const started_at = Date.now();
    try {
      const result = await once((e) => ((started = true), onEvent(e)));
      const r = result as ProviderResponse;
      if (metering) onEvent({ type: "request_usage", request: { id, started_at, usage: r.usage ?? noUsage(), status: r.usageStatus ?? "unavailable", outcome: "completed" } });
      return result;
    } catch (e) {
      if (metering) onEvent({ type: "request_usage", request: { id, started_at, usage: e instanceof AgentError ? e.usage ?? noUsage() : noUsage(), status: e instanceof AgentError ? e.usageStatus ?? "unavailable" : "unavailable", outcome: signal?.aborted ? "cancelled" : "failed" } });
      if (started || !(e instanceof AgentError && e.retryable) || attempt >= RETRIES || signal?.aborted) throw e;
      // POLARIS_RETRY_BASE_MS: tests shrink the backoff.
      const base = Number(process.env.POLARIS_RETRY_BASE_MS ?? 1000);
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
