import { AgentError, noUsage, type Block, type Msg, type Provider, type ProviderRequest, type StreamEvent, type Usage } from "../types.ts";
import { httpError, responseBudget, retryable, secretsOf, streamIndex, withRetry } from "./retry.ts";
import { cappedText, EgressError, providerFetch } from "../../egress.ts";

type Item = Record<string, any>;
function toInput(messages: Msg[]): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    let text: string[] = [];
    const flush = () => { if (text.length) input.push({ role: "user", content: text.map((t) => ({ type: "input_text", text: t })) }); text = []; };
    for (const b of m.content) {
      if (b.type === "text" && m.role === "user") text.push(b.text);
      else {
        flush();
        if (b.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: b.text }] });
        else if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, ...(b.namespace ? { namespace: b.namespace } : {}), arguments: JSON.stringify(b.input) });
        else if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, ...(b.namespace ? { namespace: b.namespace } : {}), output: b.content });
        else if (b.type === "reasoning" && b.provider === "openai") input.push(b.data as Item);
      }
    }
    flush();
  }
  return input;
}
function fromItem(it: Item): Block[] {
  if (it.type === "reasoning") return [{ type: "reasoning", provider: "openai", data: it }];
  if (it.type === "function_call") {
    const base = { type: "tool_use" as const, id: it.call_id, name: it.name, ...(it.namespace ? { namespace: it.namespace } : {}) };
    try { return [{ ...base, input: it.arguments ? JSON.parse(it.arguments) : {} }]; }
    catch { return [{ ...base, input: {}, invalid_input: it.arguments }]; }
  }
  if (it.type === "message") {
    const text = (it.content ?? []).map((c: Item) => c.text ?? c.refusal ?? "").join("");
    return text ? [{ type: "text", text }] : [];
  }
  return [];
}
function usageOf(raw?: Item): Usage {
  if (!raw) return noUsage();
  const cached = raw.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (raw.input_tokens ?? 0) - cached), output: raw.output_tokens ?? 0, cache_read: cached, cache_write: 0 };
}
function responseError(code: string, message: string, requestId?: string) {
  const hints: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: "ChatGPT plan usage limit reached. Manage usage at https://chatgpt.com/settings/usage, then retry explicitly or choose Ollama.",
    subscription_sharing_user_not_eligible: "ChatGPT plan usage is unavailable for this account or workspace. Choose another provider.",
    subscription_sharing_unsupported_capability: "This request uses a capability unavailable with the ChatGPT plan.",
    subscription_sharing_invalid_user: "ChatGPT identity could not be validated. Reconnect in Settings.",
  };
  const e = new AgentError("ProviderError", `${code}: ${hints[code] ?? message}${requestId ? ` (request ${requestId})` : ""}`);
  e.code = code;
  e.requestId = requestId;
  return /unavailable$/.test(code) ? retryable(e) : e;
}
export function openai(opts: { url: string; headers: () => Promise<Record<string, string>>; subscription?: boolean; headersTimeoutMs?: number }): Provider {
  async function once(req: ProviderRequest, onEvent: (e: StreamEvent) => void, headers: Record<string, string>) {
    let rawUsage: Item | undefined;
    try {
      const functions = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, ...(opts.subscription ? { strict: false } : {}) }));
      const body = {
        model: req.model, instructions: req.system.map((b) => b.type === "text" ? b.text : "").join("\n\n"), input: toInput(req.messages),
        tools: opts.subscription && functions.length ? [{ type: "namespace", name: "polaris", description: "Polaris agent tools", tools: functions }] : functions,
        tool_choice: "auto", stream: true, store: false,
        ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}), include: ["reasoning.encrypted_content"],
        // Readable reasoning for the run view (the encrypted content is only for replay).
        // ponytail: plan only; with an API key OpenAI can require a verified organization for summaries. A provider setting if wanted.
        ...(opts.subscription ? { reasoning: { summary: "auto" } } : {}),
        ...(req.maxTokens && !opts.subscription ? { max_output_tokens: req.maxTokens } : {}),
      };
      let res: Response;
      try {
        res = await providerFetch(opts.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: req.signal }, opts.headersTimeoutMs);
      } catch (e) {
        if (req.signal?.aborted) throw e;
        if (e instanceof EgressError) throw new AgentError("ProviderError", e.message); // policy: a retry would be refused too
        throw retryable(new AgentError("ProviderError", `request failed: ${(e as Error).message}`));
      }
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if (!res.ok || !res.body) {
        const text = await cappedText(res);
        let err: Item | undefined;
        try {
          const payload = JSON.parse(text);
          err = payload?.error;
          rawUsage = payload?.usage ?? payload?.response?.usage ?? err?.usage;
        } catch {}
        if (err?.code && /^(subscription_sharing_|chatpass_v2_)/.test(err.code) && !/unavailable$/.test(err.code)) throw responseError(err.code, err.message ?? "OpenAI rejected the request", requestId);
        throw httpError(res, text);
      }
      const items: Item[] = [];
      let done: Item | undefined;
      let completed = false;
      const handle = (e: Item) => {
        if (e.response?.usage) rawUsage = e.response.usage;
        switch (e.type) {
          case "response.output_item.added":
            if (e.item.type === "function_call") onEvent({ type: "tool_use", id: e.item.call_id, name: e.item.name });
            break;
          case "response.output_text.delta": onEvent({ type: "text", text: e.delta }); break;
          case "response.reasoning_summary_text.delta": onEvent({ type: "reasoning", text: e.delta }); break;
          case "response.output_item.done": items[streamIndex(e.output_index)] = e.item; break;
          case "response.completed": done = e.response; completed = true; break;
          case "response.incomplete": done = e.response; break;
          case "response.failed": throw responseError(e.response?.error?.code ?? "failed", e.response?.error?.message ?? "OpenAI response failed", requestId);
          case "error": throw responseError(e.code ?? "error", e.message ?? "OpenAI stream failed", requestId);
        }
      };
      try {
        let buf = "";
        const budget = responseBudget();
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        budget(chunk);
          buf += chunk;
          for (;;) {
            const match = /\r?\n\r?\n/.exec(buf);
            if (!match) break;
            const data = buf.slice(0, match.index).split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
            buf = buf.slice(match.index + match[0].length);
            if (data && data !== "[DONE]") handle(JSON.parse(data));
          }
        }
      } catch (e) {
        if (e instanceof AgentError || req.signal?.aborted) throw e;
        throw retryable(new AgentError("ProviderError", `stream failed: ${(e as Error).message}`));
      }
      if (!done || (opts.subscription && !completed)) throw new AgentError("ProviderError", "stream ended before response.completed (incomplete or interrupted)");
      // Some streaming responses leave the completed envelope's output empty. Item-done events still carry the
      // authoritative call/reasoning bodies; use them only after response.completed has confirmed success.
      const content = (done.output?.length ? done.output : items.filter(Boolean)).flatMap(fromItem);
      if (opts.subscription && content.some((b: Block) => b.type === "tool_use" && (b.namespace !== "polaris" || !req.tools.some((t) => t.name === b.name)))) throw new AgentError("ProviderError", "OpenAI returned an unknown tool namespace or function");
      const refused = (done.output ?? items).some((i: Item) => i?.content?.some((c: Item) => c.type === "refusal"));
      const usageStatus = typeof rawUsage?.input_tokens === "number" && typeof rawUsage?.output_tokens === "number" ? "reported" as const : rawUsage ? "partial" as const : "unavailable" as const;
      return { message: { role: "assistant" as const, content }, usage: usageOf(rawUsage), usageStatus,
        stopReason: refused ? "refusal" : content.some((b: Block) => b.type === "tool_use") ? "tool_use" : done.incomplete_details?.reason ?? "end_turn" };
    } catch (error) {
      const e = error instanceof AgentError ? error : new AgentError(req.signal?.aborted ? "UserAborted" : "ProviderError", (error as Error).message);
      e.usage = usageOf(rawUsage);
      e.usageStatus = rawUsage ? "partial" : "unavailable";
      throw e;
    }
  }
  return { async stream(req, onEvent) {
    // Credential failures happen before an inference request; they must not fabricate usage attempts.
    let headers: Record<string, string>;
    try { headers = await opts.headers(); }
    catch (error) {
      const e = error instanceof AgentError ? error : new AgentError("ProviderError", (error as Error).message);
      e.requestSent = false;
      throw e;
    }
    return withRetry(onEvent, req.signal, (on) => once(req, on, headers), req.metering, secretsOf(headers));
  } };
}
