import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_RETRY_BASE_MS = "1";
const { call, db, events, listen, workspace } = await import("./helpers.ts");
const { metered, withUsage, recordUsage, usageSummary, backfillUsage, checkUsageCaps, treeSpend } = await import("../server/usage.ts");
const { createRun, eventLog } = await import("../server/agent/events.ts");
const { fakeProvider } = await import("../server/agent/providers/fake.ts");
const { anthropic } = await import("../server/agent/providers/anthropic.ts");
const { openai } = await import("../server/agent/providers/openai.ts");
const { readOnlyTools } = await import("../server/agent/tools.ts");
const { runAgent } = await import("../server/agent/loop.ts");
const { AgentError } = await import("../server/agent/types.ts");
const usage = { input: 10, output: 5, cache_read: 20, cache_write: 3 };
const req = { model: "test-model", system: [], tools: [], messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }] };
const frame = (e: object) => `data: ${JSON.stringify(e)}\n\n`;

test("local, API-key and plan adapters normalize equivalent reported usage; cache and reasoning are not double counted", async () => {
  const w = await workspace("normalusage");
  const server = await listen((r, s) => {
    s.writeHead(200, { "content-type": "text/event-stream" });
    if (r.url === "/v1/messages") s.end(frame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } }) + frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
    else s.end(frame({ type: "response.completed", response: { output: [], usage: { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 4 } } } }));
  });
  try {
    for (const [kind, billing] of [["ollama", "local"], ["anthropic", "api_key"], ["openai", "api_key"], ["openai", "subscription"]] as const) {
      const p = kind === "ollama" || kind === "anthropic" ? anthropic({ apiKey: "test", baseUrl: server.url }) : openai({ url: `${server.url}/v1/responses`, headers: async () => ({}), subscription: billing === "subscription" });
      await withUsage({ workspaceId: w.ws, purpose: "connection_test", background: true }, () => metered(p, { name: billing, kind, billing }).stream(req, () => {}));
    }
    const summary = usageSummary(w.ws);
    assert.deepEqual(summary.models.map((m) => [m.input_uncached, m.tokens_out, m.tokens_cached, m.tokens_total]), Array.from({ length: 4 }, () => [10, 5, 20, 35]));
    assert.equal(summary.totals.tokens_total, 140);
    assert.equal(summary.totals.unknown_price, 2);
  } finally { server.srv.close(); }
});

test("request IDs dedupe projections; reviewer attribution, background totals, caps and replay reconcile", async () => {
  const w = await workspace("ledgercaps", { monthly_cap_tokens: 100 });
  const t = await w.create({ title: "Budget", kind: "epic", cap_tokens: 90 });
  const runId = createRun({ ticketId: t.id, model: "local-model" });
  const c = { workspaceId: w.ws, ticketId: t.id, runId, purpose: "reviewer" };
  const measurement = { id: randomUUID(), started_at: Date.now(), usage, status: "reported" as const, outcome: "completed" as const };
  const p = { id: "deleted-later", name: "GPT review", kind: "openai", billing: "subscription" as const };
  recordUsage(c, p, "gpt-review", measurement);
  recordUsage(c, p, "gpt-review", measurement);
  assert.equal((db.prepare("SELECT tokens_in+tokens_out+tokens_cached AS n FROM runs WHERE id=?").get(runId) as any).n, 38);
  recordUsage({ ...c, purpose: "reflection", background: true }, p, "gpt-review", { ...measurement, id: randomUUID() });
  const summary = usageSummary(w.ws);
  assert.equal(summary.execution.tokens_total, 38);
  assert.equal(summary.background.tokens_total, 38);
  assert.equal(summary.totals.tokens_total, 76);
  assert.equal(summary.models[0].model, "gpt-review");
  assert.equal((db.prepare("SELECT tokens_in+tokens_out+tokens_cached AS n FROM runs WHERE id=?").get(runId) as any).n, 38, "reflection must not inflate execution metrics");
  recordUsage({ ...c, purpose: "mining", background: true }, p, "gpt-review", { ...measurement, id: randomUUID(), usage: { ...usage, input: 35 } });
  assert.throws(() => checkUsageCaps(c), /SpendingCap|spending cap reached/);
  assert.equal(treeSpend(t.id).tokens, 139);
  backfillUsage(); backfillUsage();
  assert.equal(usageSummary(w.ws).totals.tokens_total, 139);
  const child = await w.create({ title: "Child", parent_id: t.id });
  recordUsage({ ...c, ticketId: child.id, purpose: "reflection", background: true }, p, "gpt-review", { ...measurement, id: randomUUID() });
  const detail = (await call("GET", `/api/tickets/${t.id}`, w.cookie)).body;
  assert.equal(detail.usage.tokens_total, 177);
  assert.equal(detail.background_usage.tokens_total, 139);
  assert.equal(detail.tokens_total, detail.usage.tokens_total, "board and epic detail use the same whole-tree total");
});

test("each HTTP retry is recorded; partial and missing usage stay visible after errors and cancellation", async () => {
  const w = await workspace("partialusage");
  let attempts = 0;
  const server = await listen((_r, s) => {
    attempts++;
    if (attempts === 1) return void s.writeHead(429).end("busy");
    s.writeHead(200, { "content-type": "text/event-stream" });
    s.end(frame({ type: "response.output_text.delta", delta: "partial" }) + frame({ type: "response.failed", response: { error: { code: "oops", message: "failed" }, usage: { input_tokens: 12, output_tokens: 2 } } }));
  });
  try {
    const p = metered(openai({ url: server.url, headers: async () => ({}) }), { name: "remote", kind: "openai", billing: "subscription" });
    await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "proposal", background: true }, () => p.stream(req, () => {})), /oops/);
    assert.equal(attempts, 2);
    const s = usageSummary(w.ws);
    assert.deepEqual([s.totals.calls, s.totals.tokens_total, s.completeness.partial, s.completeness.unavailable], [2, 14, 1, 1]);
    const controller = new AbortController();
    const fail = metered({ stream: async () => { controller.abort(); const e = new AgentError("UserAborted", "cancelled"); e.usage = usage; e.usageStatus = "partial"; throw e; } }, { name: "local", kind: "ollama", billing: "local" });
    await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "worker" }, () => fail.stream({ ...req, signal: controller.signal }, () => {})));
    assert.equal((db.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE workspace_id=? AND outcome='cancelled'").get(w.ws) as any).n, 1);
  } finally { server.srv.close(); }
});

test("compaction and worker calls share one run projection; background calls have their own purpose", async () => {
  const w = await workspace("compactusage");
  const t = await w.create({ title: "Measured" });
  const id = createRun({ ticketId: t.id, model: "fake" });
  const log = eventLog(id);
  const fake = fakeProvider([[{ type: "tool_use", id: "r", name: "read_file", input: { path: "README.md" } }], [{ type: "tool_use", id: "r2", name: "read_file", input: { path: "README.md" } }], [{ type: "text", text: "summary" }], [{ type: "text", text: "done" }]], usage);
  await withUsage({ workspaceId: w.ws, ticketId: t.id, runId: id, purpose: "worker" }, () => runAgent({ provider: metered(fake.provider, { name: "local", kind: "ollama", billing: "local" }), model: "fake", system: "test", task: "test", root: w.repo, tools: readOnlyTools, compactAt: 20, budget: { maxTurns: 5, maxTokens: 10000 }, onEvent: log }));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE run_id=?").get(id) as any).n, 4);
  assert.equal(usageSummary(w.ws).execution.tokens_total, 152);
  assert.equal(events(id).filter((e) => e.type === "usage").length, 4);
  assert.equal(events(id).filter((e) => e.type === "compaction").length, 1);
  assert.equal(usageSummary(w.ws).purposes.find((p) => p.purpose === "compaction")?.tokens_total, 38);
});

test("background calls are refused at the same workspace token cap for local and remote providers", async () => {
  const w = await workspace("backgroundcap", { monthly_cap_tokens: 38 });
  let called = 0;
  const provider = { stream: async () => { called++; return { message: { role: "assistant" as const, content: [] }, usage, stopReason: "end_turn" }; } };
  await withUsage({ workspaceId: w.ws, purpose: "reflection", background: true }, () => metered(provider, { name: "local", kind: "ollama", billing: "local" }).stream(req, () => {}));
  await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "proposal", background: true }, () => metered(provider, { name: "GPT", kind: "openai", billing: "subscription" }).stream(req, () => {})), /spending cap reached/);
  assert.equal(called, 1);
});

test("nested metering records a failed request once; authentication failures and preflight cancellation send no inference", async () => {
  const w = await workspace("nestmeter");
  const metadata = { name: "GPT", kind: "openai", billing: "subscription" as const };
  const server = await listen((_r, s) => s.writeHead(403).end('{"error":{"code":"subscription_sharing_user_not_eligible"},"usage":{"input_tokens":12,"output_tokens":2}}'));
  try {
    const transport = openai({ url: server.url, headers: async () => ({}) });
    const nested = metered(metered(transport, metadata), metadata);
    await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "reflection", background: true }, () => nested.stream(req, () => {})), /not_eligible/);
    assert.equal(usageSummary(w.ws).totals.calls, 1);
    assert.equal(usageSummary(w.ws).totals.tokens_total, 14, "error response usage is retained even before streaming starts");
    const noAuth = metered(openai({ url: server.url, headers: async () => { throw new Error("Reconnect"); } }), metadata);
    await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "reflection", background: true }, () => noAuth.stream(req, () => {})), /Reconnect/);
    await assert.rejects(withUsage({ workspaceId: w.ws, purpose: "worker" }, () => nested.stream({ ...req, signal: AbortSignal.abort() }, () => {})), /cancelled/);
    assert.equal(usageSummary(w.ws).totals.calls, 1);
  } finally { server.srv.close(); }
});

test("historical usage and reflection backfill is stable across replays without changing run counters", async () => {
  const w = await workspace("historicalledger");
  const t = await w.create({ title: "Old ticket" });
  const runId = createRun({ ticketId: t.id, model: "old-model" });
  const time = 1_700_000_000_000;
  db.prepare("UPDATE runs SET started_at=?,tokens_in=13,tokens_out=5,tokens_cached=20 WHERE id=?").run(time, runId);
  const insert = db.prepare("INSERT INTO events(run_id,seq,type,payload,created_at) VALUES (?,?,?,?,?)");
  insert.run(runId, 1, "usage", JSON.stringify(usage), time);
  insert.run(runId, 2, "reflection", JSON.stringify({ usage, version: 1, chars: 5 }), time);
  backfillUsage();
  backfillUsage();
  const s = usageSummary(w.ws);
  assert.equal(s.totals.tokens_total, 76);
  assert.equal(s.execution.tokens_total, 38);
  assert.equal(s.background.tokens_total, 38);
  assert.equal(s.completeness.historical_incomplete, true);
  assert.deepEqual(db.prepare("SELECT id FROM usage_ledger WHERE run_id=? ORDER BY id").all(runId).map((r: any) => r.id), [`event:${runId}:1`, `event:${runId}:2`]);
  assert.equal((db.prepare("SELECT tokens_in+tokens_out+tokens_cached n FROM runs WHERE id=?").get(runId) as any).n, 38);
});
