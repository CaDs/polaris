import { AgentError, stable, type Block, type Provider, type ProviderRequest, type StreamEvent, type Usage } from "../types.ts";
import { httpError, responseBudget, retryable, streamIndex, withRetry } from "./retry.ts";
import { cappedText, EgressError, providerFetch, scrub } from "../../egress.ts";

// Anthropic Messages API over fetch + SSE. The same adapter talks to Ollama's
// Anthropic-compatible endpoint (baseUrl http://localhost:11434, any api key).
export const DEFAULT_MODEL = "claude-sonnet-5-5";

type ApiBlock = Record<string, any>;

function toApi(b: Block): ApiBlock | undefined {
  // Reasoning from another provider means nothing here; drop it.
  if (b.type === "reasoning") return b.provider === "anthropic" ? (b.data as ApiBlock) : undefined;
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input }; // not invalid_input
  if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error !== undefined ? { is_error: b.is_error } : {}) };
  return b;
}

function fromApi(b: ApiBlock): Block {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input, ...(b.invalid_input === undefined ? {} : { invalid_input: b.invalid_input }) };
  // thinking / redacted_thinking (and any block type we don't model) round-trip opaquely.
  return { type: "reasoning", provider: "anthropic", data: b };
}

const BREAKPOINT = { type: "ephemeral" } as const;
const cached = <T extends object>(xs: T[]) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, cache_control: BREAKPOINT } : x));

// The request body. Prefix order: tools, system, messages. At most 3 of the 4 allowed breakpoints: end of tools, end of
// system, and a moving one on the last block of the last message (so each turn reads the previous turn's prefix from cache).
// Earlier messages are sent exactly as they were, never edited.
export function requestBody(req: ProviderRequest) {
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content.map(toApi).filter((b) => b !== undefined) }));
  const last = messages.at(-1)?.content;
  if (last?.length) last[last.length - 1] = { ...last[last.length - 1], cache_control: BREAKPOINT };
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 32000,
    stream: true,
    system: cached(req.system.map(toApi).filter((b) => b !== undefined)),
    ...(req.tools.length ? { tools: cached(req.tools.map((t) => stable(t) as object)) } : {}), // sorted keys: the tools prefix must serialize identically to hit the cache; none: M6 meta calls
    messages,
  };
}

export function anthropic(opts: { apiKey: string; baseUrl?: string; headersTimeoutMs?: number }): Provider {
  const secrets = opts.apiKey === "ollama" ? [] : [opts.apiKey]; // "ollama" is a placeholder, not a secret
  const url = `${(opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  async function once(req: ProviderRequest, onEvent: (e: StreamEvent) => void) {
    let raw: Record<string, number> = {};
    const usageOf = (): Usage => ({ input: raw.input_tokens ?? 0, output: raw.output_tokens ?? 0, cache_read: raw.cache_read_input_tokens ?? 0, cache_write: raw.cache_creation_input_tokens ?? 0 });
    try {
    const body = requestBody(req);
    let res: Response;
    try {
      res = await providerFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: req.signal,
      }, opts.headersTimeoutMs);
    } catch (e) {
      if (req.signal?.aborted) throw e;
      if (e instanceof EgressError) throw new AgentError("ProviderError", e.message); // policy: a retry would be refused too
      throw retryable(new AgentError("ProviderError", `request failed: ${(e as Error).message}`));
    }
    if (!res.ok || !res.body) {
      const text = await cappedText(res);
      try { raw = { ...JSON.parse(text)?.usage }; } catch {}
      throw httpError(res, text);
    }

    const blocks: ApiBlock[] = [];
    const json: string[] = [];
    let stopReason = "";
    const handle = (e: ApiBlock) => {
      if (e.index !== undefined) streamIndex(e.index);
      switch (e.type) {
        case "message_start":
          raw = { ...e.message.usage };
          break;
        case "content_block_start":
          blocks[e.index] = { ...e.content_block };
          if (e.content_block.type === "tool_use") {
            json[e.index] = "";
            onEvent({ type: "tool_use", id: e.content_block.id, name: e.content_block.name });
          }
          break;
        case "content_block_delta": {
          const b = blocks[e.index], d = e.delta;
          if (d.type === "text_delta") {
            b.text += d.text;
            onEvent({ type: "text", text: d.text });
          } else if (d.type === "thinking_delta") {
            b.thinking += d.thinking;
            onEvent({ type: "reasoning", text: d.thinking });
          } else if (d.type === "input_json_delta") json[e.index] += d.partial_json;
          else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
          break;
        }
        case "content_block_stop":
          if (json[e.index] !== undefined) {
            // Unparseable (e.g. truncated) input: the loop answers with an InvalidArguments tool_result.
            try {
              blocks[e.index].input = json[e.index] ? JSON.parse(json[e.index]) : {};
            } catch {
              blocks[e.index].input = {};
              blocks[e.index].invalid_input = json[e.index];
            }
          }
          break;
        case "message_delta":
          // Usage here is cumulative; it overrides message_start's numbers.
          stopReason = e.delta.stop_reason ?? stopReason;
          for (const [k, v] of Object.entries(e.usage ?? {})) if (typeof v === "number") raw[k] = v;
          break;
        case "message_stop":
          break;
        case "error": {
          const err = new AgentError("ProviderError", `${e.error?.type}: ${scrub(String(e.error?.message), secrets)}`);
          throw e.error?.type === "overloaded_error" || e.error?.type === "api_error" ? retryable(err) : err;
        }
      }
    };

    try {
      let buf = "";
      const budget = responseBudget();
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        budget(chunk);
        buf += chunk.replace(/\r\n/g, "\n");
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          buf = buf.slice(i + 2);
          if (data) handle(JSON.parse(data));
        }
      }
    } catch (e) {
      if (e instanceof AgentError || req.signal?.aborted) throw e;
      throw retryable(new AgentError("ProviderError", `stream failed: ${(e as Error).message}`));
    }
    if (!stopReason) throw new AgentError("ProviderError", "stream ended before message_delta");

    const usage = usageOf();
    const usageStatus = typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number" ? "reported" as const : Object.keys(raw).length ? "partial" as const : "unavailable" as const;
    // Empty text blocks are rejected when sent back, so drop them.
    const content = blocks.filter((b) => b && !(b.type === "text" && !b.text)).map(fromApi);
    return { message: { role: "assistant" as const, content }, usage, usageStatus, stopReason };
    } catch (error) {
      const e = error instanceof AgentError ? error : new AgentError(req.signal?.aborted ? "UserAborted" : "ProviderError", (error as Error).message);
      e.usage = usageOf();
      e.usageStatus = Object.keys(raw).length ? "partial" : "unavailable";
      throw e;
    }
}
  return { stream: (req, onEvent) => withRetry(onEvent, req.signal, (on) => once(req, on), req.metering, secrets) };
}
