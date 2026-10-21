import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { anthropic, requestBody } from "../server/agent/providers/anthropic.ts";
import { AgentError, type Msg, type StreamEvent, type ToolDef } from "../server/agent/types.ts";

process.env.POLARIS_RETRY_BASE_MS = "1"; // retry backoff base: tests don't wait seconds
const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

// Recorded-style stream: thinking (with signature), text, tool_use with chunked input_json_delta.
const turn1 = sse([
  { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 20, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "look." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } },
  { type: "content_block_stop", index: 0 },
  { type: "ping" },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "it." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path": "a' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '.txt"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
]);
const turn2 = sse([
  { type: "message_start", message: { id: "m2", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]);

async function server(replies: { status?: number; headers?: Record<string, string>; body: string }[]) {
  const requests: { headers: Record<string, any>; body: any }[] = [];
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    const r = replies[requests.length - 1];
    res.writeHead(r.status ?? 200, { "content-type": "text/event-stream", ...r.headers });
    // Split mid-frame to exercise buffering.
    res.write(r.body.slice(0, 37));
    res.end(r.body.slice(37));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { provider: anthropic({ apiKey: "k", baseUrl }), requests, close: () => srv.close() };
}

const tools: ToolDef[] = [
  { name: "read_file", description: "r", input_schema: { type: "object" } },
  { name: "shell", description: "s", input_schema: { type: "object" } },
];
const system = [{ type: "text" as const, text: "sys" }];

test("streams a turn into Msg + Usage and sends reasoning back verbatim with cache breakpoints", async () => {
  const s = await server([{ body: turn1 }, { body: turn2 }]);
  const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const seen: StreamEvent[] = [];
  const r1 = await s.provider.stream({ system, messages, tools, model: "m" }, (e) => seen.push(e));

  const thinking = { type: "thinking", thinking: "Let me look.", signature: "c2lnbmF0dXJl" };
  assert.deepEqual(r1.message, {
    role: "assistant",
    content: [
      { type: "reasoning", provider: "anthropic", data: thinking },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
    ],
  });
  assert.deepEqual(r1.usage, { input: 100, output: 42, cache_read: 20, cache_write: 50 });
  assert.equal(r1.stopReason, "tool_use");
  assert.deepEqual(seen.map((e) => e.type), ["reasoning", "reasoning", "text", "text", "tool_use"]);

  messages.push(r1.message, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "hi", is_error: false }] });
  const r2 = await s.provider.stream({ system, messages, tools, model: "m" }, () => {});
  assert.equal(r2.stopReason, "end_turn");
  assert.deepEqual(r2.usage, { input: 5, output: 3, cache_read: 0, cache_write: 0 });

  const { headers, body } = s.requests[1];
  assert.equal(headers["x-api-key"], "k");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages[1].content[0], thinking);
  assert.deepEqual(body.messages[1].content[2], { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } });
  assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "tu_1", content: "hi", is_error: false, cache_control: { type: "ephemeral" } });
  assert.deepEqual(body.system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" });
  s.close();
});

test("HTTP errors and stream error events become ProviderError", async () => {
  const s = await server([
    { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' },
    { body: sse([{ type: "message_start", message: { usage: {} } }, { type: "error", error: { type: "invalid_request_error", message: "bad" } }]) },
  ]);
  const req = { system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }], tools, model: "m" };
  for (const pattern of [/HTTP 400/, /invalid_request_error: bad/]) {
    await assert.rejects(s.provider.stream(req, () => {}), (e) => e instanceof AgentError && e.kind === "ProviderError" && pattern.test(e.message));
  }
  s.close();
  // Nothing listening: network error.
  await assert.rejects(anthropic({ apiKey: "k", baseUrl: "http://127.0.0.1:1" }).stream(req, () => {}), (e) => (e as AgentError).kind === "ProviderError");
});

const goReq = { system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }], tools, model: "m" };

test("request body: tools, system and the last message block carry the only breakpoints; tool JSON is stable", () => {
  const messages: Msg[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "hm" }, { type: "tool_use", id: "a", name: "shell", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }, { type: "tool_result", tool_use_id: "b", content: "y" }] },
  ];
  const body = requestBody({ system, messages, tools, model: "m" });
  const json = JSON.stringify(body);
  assert.equal(json.split("cache_control").length - 1, 3); // tools, system, last message (limit is 4)
  assert.deepEqual(body.messages[2].content.map((b: any) => !!b.cache_control), [false, true]);
  assert.equal(body.messages[0].content[0].cache_control, undefined);
  assert.equal(messages[2].content[1].type === "tool_result" && "cache_control" in messages[2].content[1], false); // input untouched

  // Same tools with shuffled key order serialize identically.
  const a: ToolDef[] = [{ name: "t", description: "d", input_schema: { type: "object", properties: { b: { type: "string" }, a: { type: "integer" } }, required: ["b"] } }];
  const b: ToolDef[] = [{ input_schema: { required: ["b"], properties: { a: { type: "integer" }, b: { type: "string" } }, type: "object" }, description: "d", name: "t" }];
  assert.equal(JSON.stringify(requestBody({ system, messages, tools: a, model: "m" }).tools), JSON.stringify(requestBody({ system, messages, tools: b, model: "m" }).tools));
  // The messages of the previous request are an exact prefix of the next one, apart from the moving breakpoint.
  const next = requestBody({ system, messages: [...messages, { role: "assistant", content: [{ type: "text", text: "ok" }] }], tools, model: "m" });
  assert.equal(JSON.stringify(next.messages.slice(0, 2)), JSON.stringify(body.messages.slice(0, 2)));
});

test("retries 529 twice then succeeds, announcing each retry; retry-after is honored", async () => {
  const s = await server([
    { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
    { status: 529, body: "overloaded" },
    { status: 429, headers: { "retry-after": "0.25" }, body: "{}" },
    { body: turn2 },
  ]);
  const seen: StreamEvent[] = [];
  const t0 = Date.now();
  const r = await s.provider.stream(goReq, (e) => seen.push(e));
  assert.equal(r.stopReason, "end_turn");
  assert.equal(s.requests.length, 4);
  assert.deepEqual(seen.filter((e) => e.type === "retry").map((e: any) => e.attempt), [1, 2, 3]);
  assert.ok(Date.now() - t0 >= 240, "waited for retry-after");
  s.close();
});

test("gives up after 4 retries; non-retryable statuses are not retried", async () => {
  const over = { status: 503, body: "unavailable" };
  const s = await server([over, over, over, over, over]);
  await assert.rejects(s.provider.stream(goReq, () => {}), /HTTP 503/);
  assert.equal(s.requests.length, 5);
  s.close();
  const bad = await server([{ status: 401, body: "no" }]);
  await assert.rejects(bad.provider.stream(goReq, () => {}), /HTTP 401/);
  assert.equal(bad.requests.length, 1);
  bad.close();
});

test("a stream that fails after output was streamed is not retried", async () => {
  let n = 0;
  const srv = createServer((req, res) => {
    n++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse([
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    ]));
    setTimeout(() => res.destroy(), 50);
    req.resume();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const p = anthropic({ apiKey: "k", baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` });
  const seen: StreamEvent[] = [];
  await assert.rejects(p.stream(goReq, (e) => seen.push(e)), (e) => e instanceof AgentError && /stream failed/.test(e.message));
  assert.equal(n, 1);
  assert.deepEqual(seen.map((e) => e.type), ["text"]);
  srv.close();
});

test("truncated tool input is flagged invalid_input and never sent back", async () => {
  const cut = sse([
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_9", name: "edit_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "a.txt", "new_str' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } },
  ]);
  const s = await server([{ body: cut }, { body: turn2 }]);
  const r = await s.provider.stream(goReq, () => {});
  assert.equal(r.stopReason, "max_tokens");
  assert.deepEqual(r.message.content, [{ type: "tool_use", id: "tu_9", name: "edit_file", input: {}, invalid_input: '{"path": "a.txt", "new_str' }]);
  await s.provider.stream({ ...goReq, messages: [...goReq.messages, r.message] }, () => {});
  assert.deepEqual(s.requests[1].body.messages[1].content, [{ type: "tool_use", id: "tu_9", name: "edit_file", input: {}, cache_control: { type: "ephemeral" } }]);
  s.close();
});

test("a local model's deadline: the adapter passes its headers timeout to the fetch (Ollama gets LOCAL_MODEL_TIMEOUT)", async () => {
  const { isLocalProvider } = await import("../server/providers.ts");
  const { metered } = await import("../server/usage.ts");
  const srv = createServer(() => {}); // never answers
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const req = { system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], tools, model: "m" };
    await assert.rejects(anthropic({ apiKey: "k", baseUrl, headersTimeoutMs: 150 }).stream(req, () => {}), /no response within/);
  } finally {
    srv.close();
  }
  const rows: Parameters<typeof isLocalProvider>[0][] = [{ kind: "ollama", base_url: "https://gpu.example.com" }, { kind: "litellm", base_url: "http://127.0.0.1:4000" }, { kind: "litellm", base_url: "http://litellm:4000" },
    { kind: "litellm", base_url: "https://litellm.example.com" }, { kind: "openai", base_url: null }];
  assert.deepEqual(rows.map(isLocalProvider), [true, true, true, false, false]);
  assert.equal(metered({ local: true, stream: async () => { throw new Error("unused"); } }, { name: "x", kind: "ollama", billing: "local" }).local, true); // ask() reads it through metered
});
