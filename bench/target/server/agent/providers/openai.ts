import { AgentError, type Block, type Msg, type Provider, type ProviderRequest, type StreamEvent, type Usage } from "../types.ts";
import { httpError, retryable, withRetry } from "./retry.ts";

// OpenAI Responses API over fetch + SSE (stateless: store=false). The same adapter talks to the ChatGPT Codex
// backend (ChatGPT OAuth): a different url and headers, and no max_output_tokens.
// Reasoning items (with encrypted_content) are kept opaque in `reasoning` blocks and re-sent verbatim next turn;
// dropping them costs a lot of quality.
type Item = Record<string, any>;

export function toInput(messages: Msg[]): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    let text: string[] = [];
    const flush = () => {
      if (text.length) input.push({ role: "user", content: text.map((t) => ({ type: "input_text", text: t })) });
      text = [];
    };
    for (const b of m.content) {
      if (b.type === "text" && m.role === "user") text.push(b.text);
      else if (b.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: b.text }] });
      else if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      else if (b.type === "tool_result") (flush(), input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content }));
      else if (b.type === "reasoning" && b.provider === "openai") input.push(b.data as Item);
    }
    flush();
  }
  return input;
}

function fromItem(it: Item): Block[] {
  if (it.type === "reasoning") return [{ type: "reasoning", provider: "openai", data: it }];
  if (it.type === "function_call") {
    // Unparseable (truncated) arguments: the loop answers with an InvalidArguments tool_result.
    try {
      return [{ type: "tool_use", id: it.call_id, name: it.name, input: it.arguments ? JSON.parse(it.arguments) : {} }];
    } catch {
      return [{ type: "tool_use", id: it.call_id, name: it.name, input: {}, invalid_input: it.arguments }];
    }
  }
  if (it.type === "message") {
    const text = (it.content ?? []).map((c: Item) => c.text ?? c.refusal ?? "").join("");
    return text ? [{ type: "text", text }] : [];
  }
  return [];
}

export function openai(opts: { url: string; headers: () => Promise<Record<string, string>>; codex?: boolean }): Provider {
  async function once(req: ProviderRequest, onEvent: (e: StreamEvent) => void) {
    const body = {
      model: req.model,
      instructions: req.system.map((b) => (b.type === "text" ? b.text : "")).join("\n\n"),
      input: toInput(req.messages),
      tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema })),
      tool_choice: "auto",
      stream: true,
      store: false,
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}), // same key → same cache; the prefix is tools, instructions, input
      include: ["reasoning.encrypted_content"],
      ...(req.maxTokens && !opts.codex ? { max_output_tokens: req.maxTokens } : {}),
    };
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await opts.headers()) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw retryable(new AgentError("ProviderError", `request failed: ${(e as Error).message}`));
    }
    if (!res.ok || !res.body) throw httpError(res, await res.text());

    const items: Item[] = [];
    let done: Item | undefined;
    const handle = (e: Item) => {
      switch (e.type) {
        case "response.output_item.added":
          if (e.item.type === "function_call") onEvent({ type: "tool_use", id: e.item.call_id, name: e.item.name });
          break;
        case "response.output_text.delta":
          onEvent({ type: "text", text: e.delta });
          break;
        case "response.reasoning_summary_text.delta":
          onEvent({ type: "reasoning", text: e.delta });
          break;
        case "response.output_item.done":
          items[e.output_index] = e.item;
          break;
        case "response.completed":
        case "response.incomplete":
          done = e.response;
          break;
        case "response.failed":
          throw new AgentError("ProviderError", `${e.response?.error?.code ?? "failed"}: ${e.response?.error?.message}`);
        case "error":
          throw new AgentError("ProviderError", `${e.code ?? "error"}: ${e.message}`);
      }
    };

    try {
      let buf = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk.replace(/\r\n/g, "\n");
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          buf = buf.slice(i + 2);
          if (data && data !== "[DONE]") handle(JSON.parse(data));
        }
      }
    } catch (e) {
      if (e instanceof AgentError || req.signal?.aborted) throw e;
      throw retryable(new AgentError("ProviderError", `stream failed: ${(e as Error).message}`));
    }
    if (!done) throw new AgentError("ProviderError", "stream ended before response.completed");

    const u = done.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const usage: Usage = { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cache_read: cached, cache_write: 0 };
    const content: Block[] = (items.length ? items.filter(Boolean) : (done.output ?? [])).flatMap((it: Item) => fromItem(it));
    const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : (done.incomplete_details?.reason ?? "end_turn");
    return { message: { role: "assistant" as const, content }, usage, stopReason };
}
  return { stream: (req, onEvent) => withRetry(onEvent, req.signal, (on) => once(req, on)) };
}
