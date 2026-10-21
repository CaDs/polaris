import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// POL-30: the escalation model (last attempt, budget-exhausted retry) and triage on any model; POL-5: triage goes through
// providerFetch. The demo provider takes any model name: STRONG-ONLY in a ticket makes only a model named *strong pass its gate.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "2";
process.env.POLARIS_TRIAGE_TIMEOUT_MS = "1500";
const { call, db, events, idle, listen, reply, until, workspace } = await import("./helpers.ts");
const { nextAttempt, settingsFor } = await import("../server/runs.ts");

const w = await workspace("esc", { test_command: "test -f ok.txt", model_review: false, auto_split: false, wiki: false });
const put = async (path: string, body: object) => assert.equal((await call("PUT", `/api/settings/${path}`, w.cookie, body)).status, 200);
const models = (t: any) => t.runs.map((r: any) => r.model);
const ran = async (title: string, pick?: object, ticket: object = {}) => {
  const t = await w.create({ title, ...ticket });
  const r = await call("POST", `/api/tickets/${t.id}/runs`, w.cookie, pick);
  assert.equal(r.status, 201, r.text);
  return until("settled", async () => {
    const x = await w.get(t.id);
    return ["review", "failed"].includes(x.status) && x;
  });
};
const escalated = (runId: string) => events(runId).filter((e) => e.type === "escalated").map((e) => e.p);

test("settings: escalation and triage round-trip like the other phases; unknown provider is a 400; defaults are null", async () => {
  const s = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual([s.escalation_provider_id, s.escalation_model, s.triage_provider_id, s.triage_model], [null, null, null, ""]);
  for (const p of ["escalation", "triage"]) {
    assert.equal((await call("PUT", `/api/settings/${p}-provider`, w.cookie, { provider_id: "nope" })).status, 400);
    const r = await call("PUT", `/api/settings/${p}-provider`, w.cookie, { model: "m1" });
    assert.equal(r.body[`${p}_model`], "m1");
    assert.equal((await call("PUT", `/api/settings/${p}-provider`, w.cookie, { provider_id: null, model: null })).body[`${p}_model`], p === "triage" ? "" : null);
  }
});

test("the last attempt runs on the escalation model and passes; the escalation is recorded", async () => {
  await put("default-provider", { model: "demo-weak" });
  await put("escalation-provider", { model: "demo-strong" });
  const t = await ran("STRONG-ONLY change");
  assert.equal(t.status, "review");
  assert.deepEqual(models(t), ["demo-weak", "demo-weak", "demo-strong"]);
  assert.deepEqual(escalated(t.runs[2].id), [{ from: "demo-weak", to: "demo-strong", attempt: 3, reason: "attempt 3 of 3 is the last (`test -f ok.txt` exited with code 1)" }]);
  assert.deepEqual([escalated(t.runs[0].id), escalated(t.runs[1].id)], [[], []]);
  assert.equal(events(t.runs[2].id)[0].type, "escalated"); // first, before run_started
});

test("a turn-budget failure goes straight to the escalation model; with escalation off it retries on the same one", async () => {
  const ws = w.ws;
  db.prepare("UPDATE workspace_settings SET max_turns = 3 WHERE workspace_id = ?").run(ws);
  const on = await ran("Budget change");
  assert.deepEqual(models(on), ["demo-weak", "demo-strong", "demo-strong"]); // an attempt already on the escalation model stays on it
  assert.match(escalated(on.runs[1].id)[0].reason, /^attempt 1 ran out of turns \(turn budget exhausted \(3\)\)/);
  assert.deepEqual(escalated(on.runs[2].id), []);
  await put("escalation-provider", { provider_id: null, model: null });
  const off = await ran("Budget change off");
  assert.deepEqual(models(off), ["demo-weak", "demo-weak", "demo-weak"]);
  assert.ok(off.runs.every((r: any) => escalated(r.id).length === 0));
  db.prepare("UPDATE workspace_settings SET max_turns = 120 WHERE workspace_id = ?").run(ws);
});

test("a model the user picked (on the ticket or with Retry with…) is never escalated", async () => {
  await put("escalation-provider", { model: "demo-strong" });
  const own = await ran("STRONG-ONLY own model", undefined, { model: "demo-own" });
  assert.deepEqual(models(own), ["demo-own", "demo-own", "demo-own"]);
  const picked = await ran("STRONG-ONLY picked", { model: "demo-picked" });
  assert.deepEqual(models(picked), ["demo-picked", "demo-picked", "demo-picked"]);
  assert.ok([...own.runs, ...picked.runs].every((r: any) => escalated(r.id).length === 0));
  await idle(w.ws);
});

test("nextAttempt: provider, environment and spending-cap failures never escalate; a run already on the escalation model stays", async () => {
  const s = settingsFor(w.ws);
  const t = { workspace_id: w.ws, provider_id: null, model: null } as any;
  const run = (o: object = {}) => ({ model: "demo-weak", provider_id: null, attempt: 2, pinned: 0, ...o });
  const next = (reason: string, o?: object) => nextAttempt(t, s, run(o), reason).model;
  assert.equal(next("`npm test` exited with code 1"), "demo-strong");
  for (const reason of ["ProviderError: HTTP 500", "UnexpectedEnvironment: setup command failed", "SpendingCap: monthly cap reached", "modified protected path x; the fix round ended: ProviderError: HTTP 429"])
    assert.equal(next(reason), "demo-weak", reason);
  assert.equal(next("`npm test` exited with code 1", { attempt: 1 }), "demo-weak"); // not the last attempt yet
  assert.equal(next("turn budget exhausted (3)", { attempt: 1 }), "demo-strong");
  assert.equal(next("turn budget exhausted (3)", { attempt: 1, pinned: 1 }), "demo-weak");
  assert.equal(next("x", { model: "demo-strong" }), "demo-strong");
});

// A stub Ollama: /api/show says whether a model is a decision model; System One and /v1/messages (a chat model) are separate.
async function stubOllama() {
  const seen: { url: string; body: any }[] = [];
  const { srv, url } = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url!, body });
    if (req.url === "/api/show") return void res.end(JSON.stringify({ capabilities: body.model === "dm" ? ["decision"] : ["completion"] }));
    const text = body.state ?? JSON.stringify(body.messages ?? "");
    if (req.url === "/v1/systemone") return void res.end(JSON.stringify({ answers: { size: { score: text.includes("huge") ? 3.4 : 0.8 } } }));
    if (req.url !== "/v1/messages") return void res.writeHead(404).end();
    if (text.includes("boom")) return void res.writeHead(400).end("model exploded"); // not 5xx: the adapter retries those until the timeout
    if (text.includes("silent")) return; // never answers: the timeout
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply({ text: text.includes("garbled") ? "I think it is big." : JSON.stringify({ score: text.includes("huge") ? 3.4 : 0.8, reason: "Touches many files." }) }));
  });
  return { srv, url, seen };
}

test("triage: a decision model goes to System One, any other model through the adapter; bad replies, HTTP errors and timeouts run the ticket directly", async () => {
  const { srv, url, seen } = await stubOllama();
  try {
    const x = await workspace("tri2", { test_command: "true", model_review: false, auto_split: true, wiki: false });
    const p = (await call("POST", "/api/providers", x.cookie, { name: "Local", kind: "ollama", base_url: url })).body;
    await call("PUT", "/api/settings/default-provider", x.cookie, { provider_id: p.id, model: "worker" });
    const triage = async (title: string, model: string, provider_id: string | null = null) => {
      await call("PUT", "/api/settings/triage-provider", x.cookie, { provider_id, model });
      const t = await x.create({ title, model: "demo" });
      const r = (await call("POST", `/api/tickets/${t.id}/runs`, x.cookie)).body;
      return { r, event: events(r.id)[0], t };
    };
    // Decision model: System One, unchanged.
    let r = await triage("huge change", "dm");
    assert.deepEqual([r.event.type, r.event.p.split, r.event.p.score], ["triage", true, 3.4]);
    assert.ok(seen.some((s) => s.url === "/v1/systemone") && !seen.some((s) => s.url === "/v1/messages"));
    // A chat model: one request through the adapter, no tools; its score drives the split and its reason is kept.
    seen.length = 0;
    r = await triage("huge chat change", "qwen");
    assert.deepEqual(r.event.p, { model: "qwen", split: true, score: 3.4, reason: "Touches many files." });
    const asked = seen.find((s) => s.url === "/v1/messages")!.body;
    assert.deepEqual([asked.model, asked.tools ?? [], seen.some((s) => s.url === "/v1/systemone")], ["qwen", [], false]);
    assert.match(JSON.stringify(asked.system), /<number from 0 to 4>/);
    r = await triage("tiny change", "qwen");
    assert.deepEqual([r.event.p.split, r.event.p.score], [false, 0.8]);
    await x.is(r.t.id, "review");
    // The capability check is cached: qwen asked /api/show once.
    assert.equal(seen.filter((s) => s.url === "/api/show" && s.body.model === "qwen").length, 1);
    // Errors never block the run.
    for (const [title, error] of [["garbled reply", /not JSON: I think it is big/], ["boom", /400/], ["silent", /no answer within 1\.5 s/]] as const) {
      r = await triage(title, "qwen");
      assert.deepEqual([r.event.type, r.event.p.split], ["triage", false], title);
      assert.match(r.event.p.error, error, title);
      await x.is(r.t.id, "review");
    }
    // Usage is recorded for the chat model through the adapter (purpose triage).
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE workspace_id = ? AND purpose = 'triage' AND model = 'qwen'").get(x.ws) as { n: number }).n >= 3);
    await idle(x.ws);
  } finally {
    srv.close();
  }
});

test("triage on the demo provider (no provider row): the chat path answers; a malformed answer runs the ticket directly", async () => {
  const x = await workspace("tri3", { test_command: "true", model_review: false, auto_split: true, wiki: false });
  await call("PUT", "/api/settings/triage-provider", x.cookie, { model: "demo" });
  const big = await x.create({ title: "huge", model: "demo" });
  const r = (await call("POST", `/api/tickets/${big.id}/runs`, x.cookie)).body;
  assert.deepEqual([events(r.id)[0].p.split, events(r.id)[0].p.reason], [true, "Demo triage."]);
  const bad = await x.create({ title: "BAD-JSON", model: "demo" });
  const b = (await call("POST", `/api/tickets/${bad.id}/runs`, x.cookie)).body;
  assert.match(events(b.id)[0].p.error, /not JSON/);
  await idle(x.ws);
});

test("POL-5: triage refuses redirects and metadata addresses (the second server never sees a request)", async () => {
  let hits = 0;
  const target = await listen((_req, res) => (hits++, res.end("{}")));
  const redirector = await listen((_req, res) => void res.writeHead(302, { location: `${target.url}/v1/systemone` }).end());
  try {
    const x = await workspace("tri4", { test_command: "true", model_review: false, auto_split: true, wiki: false });
    const p = (await call("POST", "/api/providers", x.cookie, { name: "Redirecting", kind: "ollama", base_url: redirector.url })).body;
    await call("PUT", "/api/settings/default-provider", x.cookie, { provider_id: p.id, model: "worker" });
    await call("PUT", "/api/settings/triage-provider", x.cookie, { model: "dm" });
    const t = await x.create({ title: "huge", model: "demo" });
    const r = (await call("POST", `/api/tickets/${t.id}/runs`, x.cookie)).body;
    assert.match(events(r.id)[0].p.error, /redirect/);
    assert.equal(hits, 0);
    // A base URL that resolves to link-local space: refused before a socket opens (saved directly, past the save-time check).
    db.prepare("UPDATE providers SET base_url = 'http://169.254.169.254' WHERE id = ?").run(p.id);
    const t2 = await x.create({ title: "huge two", model: "demo" });
    const r2 = (await call("POST", `/api/tickets/${t2.id}/runs`, x.cookie)).body;
    assert.match(events(r2.id)[0].p.error, /link-local|metadata/);
    await idle(x.ws);
  } finally {
    target.srv.close();
    redirector.srv.close();
  }
});
