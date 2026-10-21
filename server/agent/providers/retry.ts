import { randomUUID } from "node:crypto";
import { AgentError, noUsage, type ProviderResponse, type StreamEvent } from "../types.ts";
import { scrub } from "../../egress.ts";

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
  const e = new AgentError("ProviderError", `HTTP ${res.status}: ${scrub(body).slice(0, 1000)}`); // error bodies sometimes echo the key
  e.code = code;
  e.requestId = res.headers.get("x-request-id") ?? undefined;
  if (code && /subscription_sharing_usage_limit_exceeded|subscription_sharing_user_not_eligible|subscription_sharing_unsupported_capability|subscription_sharing_route_not_supported|subscription_sharing_invalid_user|chatpass_v2_/.test(code)) return e;
  return RETRY_STATUS.has(res.status) || /overloaded/i.test(body) ? retryable(e, retryAfter(res.headers.get("retry-after"))) : e;
}

// Header values of a request without the "Bearer " prefix: the secrets to scrub from what the endpoint says back.
export const secretsOf = (headers: Record<string, string>) => Object.entries(headers).filter(([k]) => /auth|key|token/i.test(k)).map(([, v]) => v.replace(/^Bearer /, ""));

// Bounds on what an endpoint may make us hold: the whole response (SSE buffer and accumulators are slices of it), the
// block/tool index it names (a sparse array is walked by .filter: index 4e8 stalled the event loop), and the cost it
// reports (a negative one would lower the spend ledger, a huge one lock the workspace out).
const RESPONSE_MAX = 32 * 1024 * 1024;
const MAX_INDEX = 1000;
export const MAX_COST_USD = 100;
export function responseBudget() {
  let n = 0;
  return (chunk: string) => {
    if ((n += chunk.length) > RESPONSE_MAX) throw new AgentError("ProviderError", `response larger than ${RESPONSE_MAX >> 20} MB: refused`);
  };
}
export function streamIndex(i: unknown) {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) > MAX_INDEX) throw new AgentError("ProviderError", `stream sent an unusable index (0 to ${MAX_INDEX} allowed)`);
  return i as number;
}
export const reportedCost = (c: unknown) => (typeof c === "number" && Number.isFinite(c) && c >= 0 ? Math.min(c, MAX_COST_USD) : undefined);

// Runs one request attempt; `once` gets an onEvent that marks the attempt as having produced output.
// `secrets` (the request's credentials) are scrubbed from the retry events emitted here, before any outer wrapper sees them.
export async function withRetry<T>(onEvent: (e: StreamEvent) => void, signal: AbortSignal | undefined, once: (on: (e: StreamEvent) => void) => Promise<T>, metering = false, secrets: string[] = []): Promise<T> {
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
      if (metering) onEvent({ type: "request_usage", request: { id, started_at, usage: r.usage ?? noUsage(), status: r.usageStatus ?? "unavailable", outcome: "completed", cost_usd: r.costUsd } });
      return result;
    } catch (e) {
      if (metering) onEvent({ type: "request_usage", request: { id, started_at, usage: e instanceof AgentError ? e.usage ?? noUsage() : noUsage(), status: e instanceof AgentError ? e.usageStatus ?? "unavailable" : "unavailable", outcome: signal?.aborted ? "cancelled" : "failed" } });
      if (started || !(e instanceof AgentError && e.retryable) || attempt >= RETRIES || signal?.aborted) throw e;
      // POLARIS_RETRY_BASE_MS: tests shrink the backoff.
      const base = Number(process.env.POLARIS_RETRY_BASE_MS ?? 1000);
      const delay = e.retryAfterMs ?? Math.min(base * 2 ** attempt, 30_000) * (1 + Math.random() * 0.25);
      onEvent({ type: "retry", attempt: attempt + 1, max: RETRIES, message: scrub(e.message, secrets), delay_ms: Math.round(delay) });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve(0)), { once: true });
      });
      if (signal?.aborted) throw e;
    }
  }
}
