import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openai } from "../server/agent/providers/openai.ts";
import { AgentError, type Msg, type StreamEvent } from "../server/agent/types.ts";

process.env.HARNESS_RETRY_BASE_MS = "1"; // retry backoff base: tests don't wait seconds
const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC==" };
const message = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Reading it." }] };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' };
const turn1 = sse([
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.output_item.done", output_index: 0, item: reasoning },
  { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
  { type: "response.output_text.delta", output_index: 1, delta: "Reading " },
  { type: "response.output_text.delta", output_index: 1, delta: "it." },
  { type: "response.output_item.done", output_index: 1, item: message },
  { type: "response.output_item.added", output_index: 2, item: { ...call, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path"' },
  { type: "response.function_call_arguments.delta", output_index: 2, delta: ':"a.txt"}' },
  { type: "response.function_call_arguments.done", output_index: 2, arguments: call.arguments },
  { type: "response.output_item.done", output_index: 2, item: call },
  { type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 42, input_tokens_details: { cached_tokens: 100 } } } },
]);
const turn2 = sse([
  { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
]);

async function server(replies: { status?: number; headers?: Record<string, string>; body: string }[]) {
  const requests: { headers: Record<string, any>; body: any }[] = [];
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    const r = replies[requests.length - 1];
    res.writeHead(r.status ?? 200, { "content-type": "text/event-stream", ...r.headers });
    res.write(r.body.slice(0, 41)); // split mid-frame
    res.end(r.body.slice(41));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/responses`;
  return { provider: openai({ url, headers: async () => ({ authorization: "Bearer k" }) }), url, requests, close: () => srv.close() };
}

const tools = [{ name: "read_file", description: "r", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
const system = [{ type: "text" as const, text: "sys" }];

test("streams a Responses turn into Msg + Usage and resends reasoning and call pairs", async () => {
  const s = await server([{ body: turn1 }, { body: turn2 }]);
  const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const seen: StreamEvent[] = [];
  const r1 = await s.provider.stream({ system, messages, tools, model: "gpt-x", cacheKey: "ticket-1" }, (e) => seen.push(e));

  assert.deepEqual(r1.message.content, [
    { type: "reasoning", provider: "openai", data: reasoning },
    { type: "text", text: "Reading it." },
    { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } },
  ]);
  assert.deepEqual(r1.usage, { input: 20, output: 42, cache_read: 100, cache_write: 0 }); // cached tokens split out of input_tokens
  assert.equal(r1.stopReason, "tool_use");
  assert.deepEqual(seen.map((e) => e.type), ["text", "text", "tool_use"]);

  messages.push(r1.message, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "hi", is_error: false }] });
  const r2 = await s.provider.stream({ system, messages, tools, model: "gpt-x" }, () => {});
  assert.equal(r2.stopReason, "end_turn");
  assert.deepEqual(r2.message.content, [{ type: "text", text: "Done." }]);

  const first = s.requests[0].body;
  assert.equal(first.stream, true);
  assert.equal(first.store, false);
  assert.equal(first.prompt_cache_key, "ticket-1");
  assert.equal(s.requests[1].body.prompt_cache_key, undefined); // only sent when the caller has a key
  assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
  assert.equal(first.instructions, "sys");
  assert.equal(first.max_output_tokens, undefined);
  assert.deepEqual(first.tools, [{ type: "function", name: "read_file", description: "r", parameters: tools[0].input_schema }]);
  assert.deepEqual(first.input, [{ role: "user", content: [{ type: "input_text", text: "go" }] }]);
  assert.equal(s.requests[1].headers.authorization, "Bearer k");
  assert.deepEqual(s.requests[1].body.input, [
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    reasoning, // verbatim, encrypted_content included
    { role: "assistant", content: [{ type: "output_text", text: "Reading it." }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_1", output: "hi" },
  ]);
  s.close();
});

test("HTTP errors and failed/error events become ProviderError", async () => {
  const s = await server([
    { status: 401, body: '{"error":{"message":"bad key"}}' },
    { body: sse([{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }]) },
    { body: sse([{ type: "error", code: "rate_limit_exceeded", message: "too fast" }]) },
    { body: sse([{ type: "response.output_text.delta", delta: "x" }]) },
  ]);
  const req = { system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }], tools, model: "m" };
  for (const pattern of [/HTTP 401/, /server_error: boom/, /rate_limit_exceeded: too fast/, /before response.completed/])
    await assert.rejects(s.provider.stream(req, () => {}), (e) => e instanceof AgentError && e.kind === "ProviderError" && pattern.test(e.message));
  s.close();
  await assert.rejects(openai({ url: "http://127.0.0.1:1/x", headers: async () => ({}) }).stream(req, () => {}), (e) => (e as AgentError).kind === "ProviderError");
});

test("retries 429/503 before any output, honoring retry-after; truncated arguments are flagged", async () => {
  const cut = sse([
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command": "ec' } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  const s = await server([{ status: 429, headers: { "retry-after": "0.2" }, body: "{}" }, { status: 503, body: "busy" }, { body: cut }]);
  const seen: StreamEvent[] = [];
  const t0 = Date.now();
  const r = await s.provider.stream({ system, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools, model: "m" }, (e) => seen.push(e));
  assert.ok(Date.now() - t0 >= 190);
  assert.equal(s.requests.length, 3);
  assert.deepEqual(seen.filter((e) => e.type === "retry").length, 2);
  assert.deepEqual(r.message.content, [{ type: "tool_use", id: "c1", name: "shell", input: {}, invalid_input: '{"command": "ec' }]);
  s.close();
});
