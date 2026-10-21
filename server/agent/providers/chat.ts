import { AgentError, noUsage, type Block, type Msg, type Provider, type ProviderRequest, type StreamEvent, type Usage } from "../types.ts";
import { httpError, retryable, withRetry } from "./retry.ts";
import { cappedText, EgressError, providerFetch, scrub } from "../../egress.ts";

// OpenAI Chat Completions over fetch + SSE: what OpenRouter and the LiteLLM proxy (and most OpenAI-compatible servers)
// speak. `extra` adds endpoint-specific body fields (OpenRouter: provider routing, usage accounting).
type Item = Record<string, any>;

// Internal messages → chat messages. Tool results become "tool" messages ahead of the user's text in the same turn;
// reasoning blocks belong to the provider that wrote them and are dropped.
export function chatMessages(system: ProviderRequest["system"], messages: Msg[]): Item[] {
  const out: Item[] = [];
  const sys = system.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(m.role === "user" ? "\n\n" : "");
    if (m.role === "assistant") {
      const calls = m.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content });
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const STOP: Record<string, string> = { tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal", stop: "end_turn" };

function usageOf(raw?: Item): Usage {
  if (!raw) return noUsage();
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const written = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  return { input: Math.max(0, (raw.prompt_tokens ?? 0) - cached - written), output: raw.completion_tokens ?? 0, cache_read: cached, cache_write: written };
}

export function chatCompletions(opts: { url: string; headers: Record<string, string>; extra?: Item }): Provider {
  async function once(req: ProviderRequest, onEvent: (e: StreamEvent) => void) {
    let raw: Item | undefined;
    try {
      const body = {
        model: req.model, messages: chatMessages(req.system, req.messages), stream: true, stream_options: { include_usage: true },
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: "auto" } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...opts.extra,
      };
      let res: Response;
      try {
        res = await providerFetch(opts.url, { method: "POST", headers: { "content-type": "application/json", ...opts.headers }, body: JSON.stringify(body), signal: req.signal });
      } catch (e) {
        if (req.signal?.aborted) throw e;
        if (e instanceof EgressError) throw new AgentError("ProviderError", e.message); // policy: a retry would be refused too
        throw retryable(new AgentError("ProviderError", `request failed: ${(e as Error).message}`));
      }
      if (!res.ok || !res.body) {
        const text = await cappedText(res);
        try { raw = JSON.parse(text)?.usage; } catch {}
        throw httpError(res, text);
      }
      let text = "";
      let finish = "";
      const calls: { id: string; name: string; args: string }[] = [];
      const handle = (e: Item) => {
        // OpenRouter reports a failure after the 200 as an error chunk.
        if (e.error) throw new AgentError("ProviderError", `stream error: ${scrub(String(e.error.message ?? JSON.stringify(e.error)))}`);
        if (e.usage) raw = e.usage;
        for (const ch of e.choices ?? []) {
          const d = ch.delta ?? {};
          if (typeof d.content === "string" && d.content) (text += d.content), onEvent({ type: "text", text: d.content });
          const thought = d.reasoning ?? d.reasoning_content; // OpenRouter / LiteLLM
          if (typeof thought === "string" && thought) onEvent({ type: "reasoning", text: thought });
          for (const tc of d.tool_calls ?? []) {
            const i = typeof tc.index === "number" ? tc.index : calls.length;
            const c = (calls[i] ??= { id: "", name: "", args: "" });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name && !c.name) (c.name = tc.function.name), onEvent({ type: "tool_use", id: c.id || `call_${i}`, name: c.name });
            if (typeof tc.function?.arguments === "string") c.args += tc.function.arguments;
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      };
      try {
        let buf = "";
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          for (;;) {
            const match = /\r?\n\r?\n/.exec(buf);
            if (!match) break;
            // ": OPENROUTER PROCESSING" and other comment lines carry no data.
            const data = buf.slice(0, match.index).split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
            buf = buf.slice(match.index + match[0].length);
            if (data && data !== "[DONE]") handle(JSON.parse(data));
          }
        }
      } catch (e) {
        if (e instanceof AgentError || req.signal?.aborted) throw e;
        throw retryable(new AgentError("ProviderError", `stream failed: ${(e as Error).message}`));
      }
      if (!finish) throw new AgentError("ProviderError", "stream ended without a finish reason (interrupted)");
      const tools: Block[] = calls.filter(Boolean).map((c, i) => {
        const base = { type: "tool_use" as const, id: c.id || `call_${i}`, name: c.name };
        try {
          return { ...base, input: c.args ? JSON.parse(c.args) : {} };
        } catch {
          return { ...base, input: {}, invalid_input: c.args };
        }
      });
      const content: Block[] = [...(text ? [{ type: "text" as const, text }] : []), ...tools];
      const status = typeof raw?.prompt_tokens === "number" && typeof raw?.completion_tokens === "number" ? "reported" as const : raw ? "partial" as const : "unavailable" as const;
      return {
        message: { role: "assistant" as const, content }, usage: usageOf(raw), usageStatus: status,
        stopReason: tools.length ? "tool_use" : STOP[finish] ?? finish, ...(typeof raw?.cost === "number" ? { costUsd: raw.cost } : {}),
      };
    } catch (error) {
      const e = error instanceof AgentError ? error : new AgentError(req.signal?.aborted ? "UserAborted" : "ProviderError", (error as Error).message);
      e.usage = usageOf(raw);
      e.usageStatus = raw ? "partial" : "unavailable";
      throw e;
    }
  }
  return { stream: (req, onEvent) => withRetry(onEvent, req.signal, (on) => once(req, on), req.metering) };
}
