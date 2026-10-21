import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { anthropic } from "../server/agent/providers/anthropic.ts";
import { chatCompletions } from "../server/agent/providers/chat.ts";
import { openai } from "../server/agent/providers/openai.ts";
import { AgentError, type ProviderRequest } from "../server/agent/types.ts";

// POL-25: what an endpoint reports (cost, indexes, stream size) is bounded before it reaches the ledger or memory.
process.env.POLARIS_RETRY_BASE_MS = "1";
const req: ProviderRequest = { system: [], tools: [], model: "m", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] };
const data = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
async function serve(body: (write: (s: string) => void) => Promise<void> | void) {
  const srv = createServer(async (r, res) => {
    for await (const _ of r);
    res.writeHead(200, { "content-type": "text/event-stream" });
    try { await body((s) => void res.write(s)); } finally { res.end(); }
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => (srv.closeAllConnections(), srv.close()) };
}
const providerError = (e: unknown) => e instanceof AgentError && e.name !== "UserAborted" && /index|larger than/.test(e.message);
const chatBody = (cost: unknown) => (w: (s: string) => void) => {
  w(data({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }));
  w(data({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost } }));
  w("data: [DONE]\n\n");
};

test("a reported cost is used only when finite and non-negative, and capped", async () => {
  const cost = async (c: unknown) => {
    const s = await serve(chatBody(c));
    try { return (await chatCompletions({ url: `${s.url}/v1/chat/completions`, headers: {} }).stream(req, () => {})).costUsd; } finally { s.close(); }
  };
  assert.equal(await cost(-5), undefined);
  assert.equal(await cost(0.25), 0.25);
  assert.equal(await cost(1e9), 100);
  // and the ledger never takes a bad number either
  const { db } = await import("./helpers.ts");
  const { recordUsage } = await import("../server/usage.ts");
  const { randomUUID } = await import("node:crypto");
  const ws = (db.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES ('w1','w','w',0) RETURNING id").get() as { id: string }).id;
  for (const c of [-5, Number.NaN, 1e9]) recordUsage({ workspaceId: ws, purpose: "execution" }, { name: "x", kind: "litellm", billing: "api_key" }, "unpriced", { id: randomUUID(), started_at: 0, outcome: "completed", status: "reported", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, cost_usd: c });
  assert.deepEqual((db.prepare("SELECT cost_usd FROM usage_ledger ORDER BY rowid").all() as { cost_usd: number | null }[]).map((r) => r.cost_usd), [null, null, 100]);
});

test("an absurd tool index fails fast in every adapter", async () => {
  const t0 = Date.now();
  const chat = await serve((w) => void w(data({ choices: [{ delta: { tool_calls: [{ index: 4_000_000_000, id: "c", function: { name: "x", arguments: "{}" } }] } }] })));
  await assert.rejects(chatCompletions({ url: `${chat.url}/v1/chat/completions`, headers: {} }).stream(req, () => {}), providerError);
  chat.close();
  const ant = await serve((w) => void w(data({ type: "content_block_start", index: 4e8, content_block: { type: "text", text: "" } })));
  await assert.rejects(anthropic({ apiKey: "k", baseUrl: ant.url }).stream(req, () => {}), providerError);
  ant.close();
  const oa = await serve((w) => void w(data({ type: "response.output_item.done", output_index: 4e8, item: { type: "message", content: [] } })));
  await assert.rejects(openai({ url: `${oa.url}/v1/responses`, headers: async () => ({}) }).stream(req, () => {}), providerError);
  oa.close();
  assert.ok(Date.now() - t0 < 2000);
});

test("a stream with no newline is cut off at 32 MB instead of buffered", async () => {
  const s = await serve(async (w) => {
    for (let i = 0; i < 100; i++) { w("x".repeat(1024 * 1024)); await new Promise((r) => setTimeout(r, 1)); } // 100 MB, no blank line
  });
  try {
    await assert.rejects(anthropic({ apiKey: "k", baseUrl: s.url }).stream(req, () => {}), providerError);
  } finally { s.close(); }
});
