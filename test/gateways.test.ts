import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// OpenRouter and LiteLLM (M16): both speak OpenAI Chat Completions (server/agent/providers/chat.ts). A mock serves both:
// /api/v1/* is OpenRouter (POLARIS_OPENROUTER_URL), /v1/* a LiteLLM proxy that wants LITELLM_KEY.
const LITELLM_KEY = "sk-litellm-master-key-123456";
type Seen = { url: string; headers: IncomingMessage["headers"]; body: any };
const seen: Seen[] = [];
const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const srv = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  seen.push({ url: req.url!, headers: req.headers, body });
  if (req.url === "/api/v1/models")
    return void res.end(JSON.stringify({ data: [
      { id: "vendor/tool-model", name: "Vendor: Tool Model", context_length: 200_000, supported_parameters: ["tools", "max_tokens"] },
      { id: "vendor/no-tools", name: "No tools", context_length: 8000, supported_parameters: ["max_tokens"] },
    ] }));
  if (req.url!.startsWith("/v1/") && req.headers.authorization !== `Bearer ${LITELLM_KEY}`)
    return void res.writeHead(401).end(JSON.stringify({ error: { message: `Authentication Error, invalid key ${req.headers.authorization?.slice(7)}` } })); // echoes the key it got
  if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "gpt-proxy" }, { id: "claude-proxy" }] }));
  // Chat: a tool call while the conversation has none answered (echo for a connection test, shell for a worker), then text.
  res.writeHead(200, { "content-type": "text/event-stream" });
  let out = ": OPENROUTER PROCESSING\n\n";
  const names: string[] = (body.tools ?? []).map((t: any) => t.function.name);
  const tool = !body.messages.some((m: any) => m.role === "tool") ? names.find((n) => n === "echo" || n === "shell") : undefined;
  if (tool) {
    const args = tool === "echo" ? '{"text":"ping"}' : JSON.stringify({ command: "echo hi > notes.txt" });
    out += chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool, arguments: "" } }] } }] });
    out += chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] } }] });
    out += chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
    out += chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else out += chunk({ choices: [{ index: 0, delta: { content: "All " } }] }) + chunk({ choices: [{ index: 0, delta: { content: "done." }, finish_reason: "stop" }] });
  out += chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, ...(req.url!.startsWith("/api/") ? { cost: 0.0125 } : {}) } });
  res.end(`${out}data: [DONE]\n\n`);
});
await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
const mock = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
after(() => (srv.closeAllConnections(), srv.close()));
process.env.POLARIS_OPENROUTER_URL = `${mock}/api/v1`;
process.env.POLARIS_CONCURRENCY = "1";
const { call, configure, db, fileTicket, user, waitFor } = await import("./helpers.ts");
const { runWindow } = await import("../server/runs.ts");
const { providerById } = await import("../server/providers.ts");

const alice = await user("alice");
const chats = () => seen.filter((s) => s.url.endsWith("/chat/completions"));

test("OpenRouter: official endpoint only, tool-capable models, privacy routing, billed cost in the ledger, catalog context windows", async () => {
  const key = "sk-or-v1-0123456789abcdef0123456789";
  assert.match((await call("POST", "/api/providers", alice, { name: "OR", kind: "openrouter", api_key: key, base_url: "https://evil.example" })).body.error, /always/);
  const p = (await call("POST", "/api/providers", alice, { name: "OR", kind: "openrouter", api_key: key })).body;
  assert.deepEqual([p.kind, p.auth_type, p.secret_last4, p.options], ["openrouter", "api_key", "6789", {}]);
  const models = (await call("GET", `/api/providers/${p.id}/models`, alice)).body;
  assert.deepEqual(models.models, ["vendor/tool-model"]); // no tool support: not offered
  assert.deepEqual(models.model_details, [{ id: "vendor/tool-model", name: "Vendor: Tool Model" }]);

  seen.length = 0;
  const r = (await call("POST", `/api/providers/${p.id}/test`, alice, { model: "vendor/tool-model" })).body;
  assert.deepEqual([r.ok, r.tool_call], [true, true], JSON.stringify(r));
  const [first, second] = chats();
  assert.equal(first.url, "/api/v1/chat/completions");
  assert.equal(first.headers.authorization, `Bearer ${key}`);
  assert.equal(first.headers["x-title"], "Polaris");
  assert.deepEqual([first.body.stream, first.body.usage, first.body.provider], [true, { include: true }, { data_collection: "deny" }]); // privacy by default
  assert.deepEqual(first.body.tools.map((t: any) => t.function.name), ["echo"]);
  assert.equal(first.body.messages[0].role, "system");
  assert.deepEqual(second.body.messages.slice(-2).map((m: any) => [m.role, m.tool_calls?.[0]?.id ?? m.tool_call_id]), [["assistant", "call_1"], ["tool", "call_1"]]);
  const ledger = db.prepare("SELECT input, output, cache_read, cost_usd FROM usage_ledger WHERE provider_id = ?").all(p.id) as Record<string, number>[];
  assert.equal(ledger.length, 2);
  assert.deepEqual({ ...ledger[0] }, { input: 60, output: 10, cache_read: 40, cost_usd: 0.0125 }); // OpenRouter's billed cost, not a table price

  assert.deepEqual((await call("PATCH", `/api/providers/${p.id}`, alice, { options: { data_collection: "allow" } })).body.options, { data_collection: "allow" });
  assert.equal((await call("PATCH", `/api/providers/${p.id}`, alice, { options: { data_collection: "maybe" } })).status, 400);
  seen.length = 0;
  await call("POST", `/api/providers/${p.id}/test`, alice, { model: "vendor/tool-model" });
  assert.equal(chats()[0].body.provider, undefined);
  // Left at the default context window: each model's own, from the catalog.
  assert.deepEqual(await runWindow(providerById(p.id), "vendor/tool-model"), { window: 200_000, source: "OpenRouter catalog" });
});

test("LiteLLM: proxy URL required and checked, key optional and validated, proxy models; an error echoing the key never shows it", async () => {
  const base = { name: "Proxy", kind: "litellm" };
  assert.match((await call("POST", "/api/providers", alice, base)).body.error, /required/);
  assert.match((await call("POST", "/api/providers", alice, { ...base, base_url: "http://api.example.com:4000" })).body.error, /unencrypted/);
  assert.match((await call("POST", "/api/providers", alice, { ...base, base_url: "http://169.254.169.254" })).body.error, /metadata/);
  assert.match((await call("POST", "/api/providers", alice, { ...base, base_url: mock, api_key: "sk 1234" })).body.error, /printable/);
  assert.match((await call("POST", "/api/providers", alice, { ...base, base_url: mock, api_key: "sk-1\r\nX-Evil: 1" })).body.error, /printable/);
  const p = (await call("POST", "/api/providers", alice, { ...base, base_url: `${mock}/v1/`, api_key: "sk-wrong" })).body;
  assert.equal(p.secret_last4, null); // a short key would be mostly revealed
  const bad = (await call("POST", `/api/providers/${p.id}/test`, alice, { model: "gpt-proxy" })).body;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 401/);
  assert.doesNotMatch(bad.error, /sk-wrong/);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM usage_ledger").all()), /sk-wrong/);

  await call("PATCH", `/api/providers/${p.id}`, alice, { api_key: LITELLM_KEY });
  assert.deepEqual((await call("GET", `/api/providers/${p.id}/models`, alice)).body.models, ["claude-proxy", "gpt-proxy"]);
  seen.length = 0;
  assert.equal((await call("POST", `/api/providers/${p.id}/test`, alice, { model: "gpt-proxy" })).body.ok, true);
  assert.equal(chats()[0].url, "/v1/chat/completions"); // a base URL ending in /v1 is not doubled
  assert.equal(chats()[0].body.provider, undefined); // OpenRouter-only fields stay OpenRouter's
  assert.equal(((await call("POST", "/api/providers", alice, { ...base, name: "Open proxy", base_url: mock, auth_type: "none" })).body).auth_type, "none");
});

test("a worker run through LiteLLM: tool call, gate, review", async () => {
  await configure(alice, { setup_command: "", test_command: "test -f notes.txt", model_review: false, wiki: false, repo_path: (await import("./helpers.ts")).tempRepo() });
  const p = (await call("POST", "/api/providers", alice, { name: "Run proxy", kind: "litellm", base_url: mock, api_key: LITELLM_KEY })).body;
  const t = (await fileTicket(alice, { title: "Write notes", provider_id: p.id, model: "gpt-proxy" })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, alice)).status, 201);
  const done = await waitFor(alice, t.id, "review");
  assert.deepEqual([done.runs[0].model, done.runs[0].status], ["gpt-proxy", "passed"]);
  assert.ok(chats().some((c) => c.body.tools?.some((x: any) => x.function.name === "shell")));
});
