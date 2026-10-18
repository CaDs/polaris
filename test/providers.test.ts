import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M4: encrypted provider secrets, provider API, provider/model choice per ticket and per retry.
process.env.HARNESS_SANDBOX = "host";
process.env.HARNESS_RETRY_BASE_MS = "1"; // a dead provider is retried 4 times: don't wait seconds
process.env.HARNESS_CONCURRENCY = "2";
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "prov-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { encrypt, decrypt, SecretKeyError } = await import("../server/secrets.ts");

const origin = "http://localhost:5173";
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, text, body: (text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null) as any, cookie: set || cookie };
}
async function user(name: string) {
  const { cookie } = await call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  return (await call("POST", "/api/auth/organization/create", cookie, { name, slug: name })).cookie;
}
const alice = await user("alice");
const bob = await user("bob");

// Mock Anthropic-compatible server (also Ollama's /api/tags). Turn 1 of a task calls the shell tool, then it answers.
// A task that mentions a previous failed attempt also creates ok.txt. mode "plain" never calls a tool.
const ollama = { models: ["mock-a", "mock-b"], plain: false, models_seen: [] as string[] };
const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const srv = createServer(async (req, res) => {
  if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: ollama.models.map((name) => ({ name })) }));
  if (req.url!.startsWith("/api/")) return void res.writeHead(404).end(); // /api/ps, /api/show: no window info, run falls back
  let raw = "";
  for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  ollama.models_seen.push(b.model);
  const last = b.messages.at(-1).content[0];
  const task: string = b.messages[0].content[0].text;
  const tool = last.type !== "tool_result" && !ollama.plain && !!b.tools; // no tools: an M6 reflection
  const input = JSON.stringify({ command: task.includes("Previous attempt failed") ? "touch ok.txt" : "true" });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...(tool
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: b.tools[0].name === "echo" ? "echo" : "shell", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: b.tools[0].name === "echo" ? '{"text":"ping"}' : input } },
          { type: "content_block_stop", index: 0 },
        ]
      : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All done." } },
          { type: "content_block_stop", index: 0 },
        ]),
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
  ]));
});
await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
const mock = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

test("encryption round-trips and detects tampering, wrong keys and a missing key", () => {
  const c = encrypt("sk-secret-1234");
  assert.ok(!c.includes("secret"));
  assert.notEqual(c, encrypt("sk-secret-1234")); // fresh IV each time
  assert.equal(decrypt(c), "sk-secret-1234");
  const raw = Buffer.from(c.slice(3), "base64");
  for (const at of [0, 13, raw.length - 1]) {
    const bad = Buffer.from(raw);
    bad[at] ^= 1;
    assert.throws(() => decrypt("v1:" + bad.toString("base64")), `byte ${at}`);
  }
  const key = process.env.HARNESS_SECRET_KEY;
  process.env.HARNESS_SECRET_KEY = "ff".repeat(32);
  assert.throws(() => decrypt(c));
  delete process.env.HARNESS_SECRET_KEY;
  assert.throws(() => encrypt("x"), SecretKeyError);
  process.env.HARNESS_SECRET_KEY = key;
});

test("provider API never returns secrets, validates input, and is isolated per workspace", async () => {
  const key = "sk-ant-SUPERSECRET-wxyz";
  const made = await call("POST", "/api/providers", alice, { name: "Claude", kind: "anthropic", auth_type: "api_key", api_key: key });
  assert.equal(made.status, 201);
  assert.equal(made.body.has_secret, true);
  assert.equal(made.body.secret_last4, "wxyz");
  const id = made.body.id;
  const stored = (db.prepare("SELECT encrypted_secret FROM providers WHERE id = ?").get(id) as any).encrypted_secret;
  assert.ok(!stored.includes("SUPERSECRET") && decrypt(stored) === key);

  const every = [made.text, (await call("GET", "/api/providers", alice)).text, (await call("PATCH", `/api/providers/${id}`, alice, { name: "Claude 2" })).text];
  for (const t of every) assert.ok(!t.includes("SUPERSECRET") && !t.includes("encrypted"), t);
  // Patch without api_key keeps the secret; with one replaces it.
  assert.equal(decrypt((db.prepare("SELECT encrypted_secret FROM providers WHERE id = ?").get(id) as any).encrypted_secret), key);
  assert.equal((await call("PATCH", `/api/providers/${id}`, alice, { api_key: "new-key-0000" })).body.secret_last4, "0000");

  for (const bad of [{}, { name: "x", kind: "bogus" }, { name: "x", kind: "ollama", auth_type: "api_key" }, { name: "x", kind: "anthropic", base_url: "ftp://x" }, { name: "", kind: "ollama" }, { name: "x", kind: "ollama", api_key: "k" }])
    assert.equal((await call("POST", "/api/providers", alice, bad)).status, 400, JSON.stringify(bad));

  // No HARNESS_SECRET_KEY: saving a secret is refused with a clear message; providers without secrets still work.
  const k = process.env.HARNESS_SECRET_KEY;
  delete process.env.HARNESS_SECRET_KEY;
  const refused = await call("POST", "/api/providers", alice, { name: "NoKey", kind: "openai", api_key: "sk-x" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /HARNESS_SECRET_KEY/);
  assert.equal((await call("POST", "/api/providers", alice, { name: "Local", kind: "ollama", base_url: mock })).status, 201);
  process.env.HARNESS_SECRET_KEY = k;

  // Isolation: bob sees none of alice's providers and gets 404 on all of them.
  assert.deepEqual((await call("GET", "/api/providers", bob)).body, []);
  for (const [m, p] of [["PATCH", ""], ["DELETE", ""], ["GET", "/models"], ["POST", "/test"], ["POST", "/oauth/start"]])
    assert.equal((await call(m, `/api/providers/${id}${p}`, bob, m === "PATCH" ? { name: "x" } : undefined)).status, 404, `${m} ${p}`);
  // ...and cannot point tickets or defaults at them.
  assert.equal((await call("POST", "/api/tickets", bob, { title: "t", provider_id: id })).status, 400);
  assert.equal((await call("PUT", "/api/settings/default-provider", bob, { provider_id: id })).status, 400);
  assert.equal((await call("DELETE", `/api/providers/${id}`, alice)).status, 204);
  assert.equal((await call("GET", `/api/providers/${id}/models`, alice)).status, 404);
});

test("models and the tool-calling smoke test", async () => {
  const claude = (await call("POST", "/api/providers", alice, { name: "C", kind: "anthropic", api_key: "k-1234" })).body.id;
  assert.deepEqual((await call("GET", `/api/providers/${claude}/models`, alice)).body.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  const local = (await call("POST", "/api/providers", alice, { name: "Ollama", kind: "ollama", base_url: mock })).body.id;
  assert.deepEqual((await call("GET", `/api/providers/${local}/models`, alice)).body.models, ["mock-a", "mock-b"]);

  const ok = (await call("POST", `/api/providers/${local}/test`, alice, { model: "mock-a" })).body;
  assert.deepEqual([ok.ok, ok.tool_call, typeof ok.latency_ms], [true, true, "number"]);
  ollama.plain = true;
  const plain = (await call("POST", `/api/providers/${local}/test`, alice, { model: "mock-b" })).body;
  assert.deepEqual([plain.ok, plain.tool_call], [true, false]);
  ollama.plain = false;
  const dead = (await call("POST", "/api/providers", alice, { name: "Dead", kind: "ollama", base_url: "http://127.0.0.1:1" })).body.id;
  const bad = (await call("POST", `/api/providers/${dead}/test`, alice, { model: "m" })).body;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /request failed/);
  assert.equal((await call("GET", `/api/providers/${dead}/models`, alice)).status, 502);
});

test("runs record the chosen provider/model; retry-with picks another; gate retries keep it", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  writeFileSync(join(repo, "README.md"), "hi\n");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
  assert.equal((await call("PUT", "/api/settings", alice, { repo_path: repo, setup_command: "", test_command: "test -f ok.txt" })).status, 200);
  const providers = (await call("GET", "/api/providers", alice)).body;
  const local = providers.find((p: any) => p.name === "Ollama").id;
  const claude = providers.find((p: any) => p.name === "C").id;

  const waitRuns = async (ticketId: string, n: number, status: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const t = (await call("GET", `/api/tickets/${ticketId}`, alice)).body;
      if (t.runs.length >= n && t.status === status) return t;
    }
    assert.fail(`ticket never reached ${status} with ${n} runs`);
  };

  ollama.models_seen.length = 0;
  // Ticket-level choice. Attempt 1 fails the gate (ok.txt missing), the automatic retry keeps provider and model.
  const t = (await call("POST", "/api/tickets", alice, { title: "pick", spec: "do it", provider_id: local, model: "mock-a" })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, alice)).status, 201);
  const done = await waitRuns(t.id, 2, "review");
  assert.deepEqual(done.runs.map((r: any) => [r.provider_id, r.model, r.status]), [[local, "mock-a", "failed"], [local, "mock-a", "passed"]]);
  assert.deepEqual(ollama.models_seen.filter((m) => m !== "mock-a"), []);
  assert.equal(done.run_model, "mock-a");

  // Retry with another model of the same provider, then with no explicit body (back to the ticket's choice).
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, alice, { provider_id: local, model: "mock-b" })).status, 201);
  const retried = await waitRuns(t.id, 4, "review");
  assert.deepEqual(retried.runs.slice(2).map((r: any) => [r.provider_id, r.model]), [[local, "mock-b"], [local, "mock-b"]]);
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, alice, { provider_id: "nope", model: "x" })).status, 400);

  // Workspace default applies to tickets without a choice of their own; the ticket's choice wins over it.
  assert.equal((await call("PUT", "/api/settings/default-provider", alice, { provider_id: local, model: "mock-b" })).body.default_model, "mock-b");
  assert.equal((await call("GET", "/api/settings", alice)).body.default_provider_id, local);
  const t2 = (await call("POST", "/api/tickets", alice, { title: "default", spec: "x" })).body;
  await call("POST", `/api/tickets/${t2.id}/runs`, alice);
  const r2 = await waitRuns(t2.id, 2, "review");
  assert.deepEqual(r2.runs.map((r: any) => [r.provider_id, r.model]), [[local, "mock-b"], [local, "mock-b"]]);
  assert.equal((await call("PATCH", `/api/tickets/${t2.id}`, alice, { provider_id: local, model: "mock-a" })).body.model, "mock-a");
  await call("POST", `/api/tickets/${t2.id}/runs`, alice);
  assert.equal((await waitRuns(t2.id, 4, "review")).runs[2].model, "mock-a");

  // A provider without a model (non-Anthropic) is refused with a clear message; deleting a provider falls back.
  const t3 = (await call("POST", "/api/tickets", alice, { title: "nomodel", provider_id: claude })).body;
  assert.equal((await call("PATCH", `/api/tickets/${t3.id}`, alice, { provider_id: local, model: null })).body.model, null);
  assert.equal((await call("PUT", "/api/settings/default-provider", alice, { provider_id: null, model: null })).status, 200);
  const none = await call("POST", `/api/tickets/${t3.id}/runs`, alice);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /choose a model/);
  assert.equal((await call("DELETE", `/api/providers/${local}`, alice)).status, 204);
  assert.equal(((await call("GET", `/api/tickets/${t.id}`, alice)).body).provider_id, null);
});

test.after(() => srv.close());

test("ollama context window: /api/ps beats /api/show, show when not loaded, setting wins, failure falls back", async () => {
  const { runWindow } = await import("../server/runs.ts");
  const o = { ps: [{ name: "m1", context_length: 262_144 }] as object[], show: { "qwen.context_length": 131_072 } as object | undefined, status: 200 };
  const s = createServer((req, res) => {
    res.statusCode = o.status;
    if (req.url === "/api/ps") return void res.end(JSON.stringify({ models: o.ps }));
    if (req.url === "/api/show" && o.show) return void res.end(JSON.stringify({ model_info: o.show }));
    res.statusCode = 404;
    res.end("{}");
  }).listen(0);
  await new Promise((r) => s.once("listening", r));
  const base_url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const row = (context_window: number) => ({ kind: "ollama", base_url, context_window }) as any;
  try {
    assert.deepEqual(await runWindow(row(32_768), "m1"), { window: 262_144, source: "ollama /api/ps" });
    assert.deepEqual(await runWindow(row(32_768), "m2"), { window: 131_072, source: "ollama /api/show" }); // not loaded
    assert.deepEqual(await runWindow(row(65_536), "m1"), { window: 65_536, source: "provider setting" }); // explicit wins
    o.show = undefined;
    assert.deepEqual(await runWindow(row(32_768), "m2"), { window: 32_768, source: "default" });
    o.status = 500;
    assert.deepEqual(await runWindow(row(32_768), "m1"), { window: 32_768, source: "default" });
    assert.deepEqual(await runWindow({ kind: "anthropic", context_window: 200_000 } as any, "x"), { window: 200_000, source: "provider setting" });
  } finally {
    s.close();
  }
});
