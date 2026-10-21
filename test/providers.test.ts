import { test } from "node:test";
import assert from "node:assert/strict";

// M4: encrypted provider secrets, provider API, provider/model choice per ticket and per retry.
process.env.POLARIS_RETRY_BASE_MS = "1"; // a dead provider is retried 4 times: don't wait seconds
process.env.POLARIS_CONCURRENCY = "2";
const { configure, fileTicket, call, db, listen, reply, tempRepo, until, user } = await import("./helpers.ts");
const { encrypt, decrypt, SecretKeyError } = await import("../server/secrets.ts");

const alice = await user("alice");
const bob = await user("bob");

// Mock Anthropic-compatible server (also Ollama's /api/tags). Turn 1 of a task calls the shell tool, then it answers.
// A task that mentions a previous failed attempt also creates ok.txt. mode "plain" never calls a tool.
const ollama = { models: ["mock-a", "mock-b"], plain: false, models_seen: [] as string[] };
const { srv, url: mock } = await listen(async (req, res) => {
  if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: ollama.models.map((name) => ({ name })) }));
  if (req.url!.startsWith("/api/")) return void res.writeHead(404).end(); // /api/ps, /api/show: no window info, run falls back
  let raw = "";
  for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  ollama.models_seen.push(b.model);
  const last = b.messages.at(-1).content[0];
  const task: string = b.messages[0].content[0].text;
  const tool = last.type !== "tool_result" && !ollama.plain && !!b.tools; // no tools: an M6 reflection
  const echo = tool && b.tools[0].name === "echo";
  const input = JSON.stringify({ command: task.includes("Previous attempt failed") ? "touch ok.txt" : "true" });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(reply(tool ? { tool: echo ? "echo" : "shell", input: echo ? '{"text":"ping"}' : input } : { text: "All done." }));
});

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
  const key = process.env.POLARIS_SECRET_KEY;
  process.env.POLARIS_SECRET_KEY = "ff".repeat(32);
  assert.throws(() => decrypt(c));
  delete process.env.POLARIS_SECRET_KEY;
  assert.throws(() => encrypt("x"), SecretKeyError);
  process.env.POLARIS_SECRET_KEY = key;
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

  // No POLARIS_SECRET_KEY: saving a secret is refused with a clear message; providers without secrets still work.
  const k = process.env.POLARIS_SECRET_KEY;
  delete process.env.POLARIS_SECRET_KEY;
  const refused = await call("POST", "/api/providers", alice, { name: "NoKey", kind: "openai", api_key: "sk-x" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /POLARIS_SECRET_KEY/);
  assert.equal((await call("POST", "/api/providers", alice, { name: "Local", kind: "ollama", base_url: mock })).status, 201);
  process.env.POLARIS_SECRET_KEY = k;

  // Isolation: bob sees none of alice's providers and gets 404 on all of them.
  assert.deepEqual((await call("GET", "/api/providers", bob)).body, []);
  for (const [m, p] of [["PATCH", ""], ["DELETE", ""], ["GET", "/models"], ["POST", "/test"], ["POST", "/oauth/start"]])
    assert.equal((await call(m, `/api/providers/${id}${p}`, bob, m === "PATCH" ? { name: "x" } : undefined)).status, 404, `${m} ${p}`);
  // ...and cannot point tickets or defaults at them.
  assert.equal((await fileTicket(bob, { title: "t", provider_id: id })).status, 400);
  assert.equal((await call("PUT", "/api/settings/default-provider", bob, { provider_id: id })).status, 400);
  assert.equal((await call("DELETE", `/api/providers/${id}`, alice)).status, 204);
  assert.equal((await call("GET", `/api/providers/${id}/models`, alice)).status, 404);
});

test("changing the base URL drops the stored secret", async () => {
  const id = (await call("POST", "/api/providers", alice, { name: "Moved", kind: "anthropic", api_key: "sk-ant-keep-1111" })).body.id;
  const secret = () => (db.prepare("SELECT encrypted_secret FROM providers WHERE id = ?").get(id) as any).encrypted_secret;
  assert.equal((await call("PATCH", `/api/providers/${id}`, alice, { name: "Moved", base_url: null })).body.has_secret, true, "same (empty) base URL keeps it");
  const moved = await call("PATCH", `/api/providers/${id}`, alice, { base_url: "https://attacker.example" });
  assert.deepEqual([moved.status, moved.body.has_secret, secret()], [200, false, null]);
  const rekeyed = await call("PATCH", `/api/providers/${id}`, alice, { base_url: "https://other.example", api_key: "sk-ant-new-2222" });
  assert.deepEqual([rekeyed.body.has_secret, rekeyed.body.secret_last4], [true, "2222"], "a key sent with the new URL is kept");
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
  assert.equal((await configure(alice, { repo_path: tempRepo(), setup_command: "", test_command: "test -f ok.txt" })).status, 200);
  const providers = (await call("GET", "/api/providers", alice)).body;
  const local = providers.find((p: any) => p.name === "Ollama").id;
  const claude = providers.find((p: any) => p.name === "C").id;

  const waitRuns = (ticketId: string, n: number, status: string) =>
    until(`${status} with ${n} runs`, async () => {
      const t = (await call("GET", `/api/tickets/${ticketId}`, alice)).body;
      return t.runs.length >= n && t.status === status && t;
    });

  ollama.models_seen.length = 0;
  // Ticket-level choice. Attempt 1 fails the gate (ok.txt missing), the automatic retry keeps provider and model.
  const t = (await fileTicket(alice, { title: "pick", spec: "do it", provider_id: local, model: "mock-a" })).body;
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
  const t2 = (await fileTicket(alice, { title: "default", spec: "x" })).body;
  await call("POST", `/api/tickets/${t2.id}/runs`, alice);
  const r2 = await waitRuns(t2.id, 2, "review");
  assert.deepEqual(r2.runs.map((r: any) => [r.provider_id, r.model]), [[local, "mock-b"], [local, "mock-b"]]);
  assert.equal((await call("PATCH", `/api/tickets/${t2.id}`, alice, { provider_id: local, model: "mock-a" })).body.model, "mock-a");
  await call("POST", `/api/tickets/${t2.id}/runs`, alice);
  assert.equal((await waitRuns(t2.id, 4, "review")).runs[2].model, "mock-a");

  // A provider without a model (non-Anthropic) is refused with a clear message; deleting a provider falls back.
  const t3 = (await fileTicket(alice, { title: "nomodel", provider_id: claude })).body;
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
  const { srv: s, url: base_url } = await listen((req, res) => {
    res.statusCode = o.status;
    if (req.url === "/api/ps") return void res.end(JSON.stringify({ models: o.ps }));
    if (req.url === "/api/show" && o.show) return void res.end(JSON.stringify({ model_info: o.show }));
    res.statusCode = 404;
    res.end("{}");
  });
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
