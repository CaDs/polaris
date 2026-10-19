import { test } from "node:test";
import assert from "node:assert/strict";

// Spending caps per workspace (monthly) and per epic (its whole tree). POLARIS_SANDBOX=host, demo provider (130 tokens a
// turn, model "demo": no price). Earlier usage is inserted as runs rows; a priced model name there gives a USD figure.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "2";
const { call, db, events, idle, workspace } = await import("./helpers.ts");

const monthStart = Date.parse(`${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`);
// A finished run of `model` with these tokens, on a fresh ticket of workspace ws.
function spent(ws: string, model: string, tokens_in: number, started = Date.now(), tokens_out = 0, tokens_cached = 0) {
  const t = `t${Math.random()}`;
  db.prepare("INSERT INTO tickets (id, workspace_id, title, status) VALUES (?, ?, 'earlier work', 'done')").run(t, ws);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status, tokens_in, tokens_out, tokens_cached, started_at) VALUES (?, ?, ?, 'passed', ?, ?, ?, ?)").run(`r${Math.random()}`, t, model, tokens_in, tokens_out, tokens_cached, started);
}
const errors = (runId: string, kind: string) => events(runId).filter((e) => e.type === "error" && e.p.kind === kind).map((e) => e.p);
const finished = (runId: string) => events(runId).find((e) => e.type === "run_finished")!.p;

test("settings: monthly caps default to null, round-trip, accept form strings, validate, omitted keeps, null and empty clear", async () => {
  const w = await workspace("capset", { test_command: "true" });
  let s = (await w.settings()).body;
  assert.deepEqual([s.monthly_cap_usd, s.monthly_cap_tokens], [null, null]);
  s = (await w.settings({ monthly_cap_usd: "12.5", monthly_cap_tokens: 1_000_000 })).body;
  assert.deepEqual([s.monthly_cap_usd, s.monthly_cap_tokens], [12.5, 1_000_000]);
  s = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual([s.monthly_cap_usd, s.monthly_cap_tokens], [12.5, 1_000_000]);
  s = (await w.settings({})).body;
  assert.deepEqual([s.monthly_cap_usd, s.monthly_cap_tokens], [12.5, 1_000_000]); // omitted = unchanged
  for (const [k, v] of [["monthly_cap_usd", -1], ["monthly_cap_usd", "abc"], ["monthly_cap_usd", true], ["monthly_cap_tokens", 1.5], ["monthly_cap_tokens", -5], ["monthly_cap_tokens", []]]) {
    const r = await w.settings({ [k as string]: v });
    assert.equal(r.status, 400, `${k}=${JSON.stringify(v)}`);
    assert.match(r.body.error, /must be a non-negative/);
  }
  assert.equal((await w.settings({ monthly_cap_usd: 0 })).body.monthly_cap_usd, 0); // 0 = nothing may run
  s = (await w.settings({ monthly_cap_usd: null, monthly_cap_tokens: "" })).body; // null resets, an empty form field clears
  assert.deepEqual([s.monthly_cap_usd, s.monthly_cap_tokens], [null, null]);

  // A ticket's cap: PATCH (and POST) take the same values.
  const t = await w.create({ title: "Epic", kind: "epic", cap_usd: 2 });
  assert.deepEqual([t.cap_usd, t.cap_tokens], [2, null]);
  let p = await call("PATCH", `/api/tickets/${t.id}`, w.cookie, { cap_tokens: "5000" });
  assert.deepEqual([p.body.cap_usd, p.body.cap_tokens], [2, 5000]);
  assert.match((await call("PATCH", `/api/tickets/${t.id}`, w.cookie, { cap_usd: -0.5 })).body.error, /Cap \(USD\) must be a non-negative number/);
  p = await call("PATCH", `/api/tickets/${t.id}`, w.cookie, { cap_usd: null, title: "Epic 2" });
  assert.deepEqual([p.body.cap_usd, p.body.cap_tokens, p.body.title], [null, 5000, "Epic 2"]);
});

test("workspace cap reached: the next run fails before it starts, with the reason and a SpendingCap event; last month and unpriced models", async () => {
  const w = await workspace("capws", { test_command: "true", model_review: false });
  spent(w.ws, "claude-sonnet-5-5", 1_000_000); // $2 at $2/M input
  spent(w.ws, "demo", 500); // no price: $0, but its tokens count
  spent(w.ws, "claude-sonnet-5-5", 50_000_000, monthStart - 1); // last month: not counted
  await w.settings({ monthly_cap_usd: 1.5 });
  let u = (await call("GET", "/api/usage", w.cookie)).body.cap;
  assert.deepEqual(u, { usd: 1.5, tokens: null, used_usd: 2, used_tokens: 1_000_500, month: new Date().toISOString().slice(0, 7) });

  const t = await w.create({ title: "Blocked", spec: "Do it" });
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, w.cookie)).status, 201);
  const failed = await w.is(t.id, "failed");
  assert.equal(failed.runs.length, 1); // not retried, not split (auto_split is on)
  const run = failed.runs[0];
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(finished(run.id).reason, `SpendingCap: spending cap reached: workspace ${month} cost $2/$1.5`);
  assert.deepEqual([finished(run.id).turns, run.tokens_in, run.worktree], [0, 0, null]); // no worktree, no model call
  assert.deepEqual(errors(run.id, "SpendingCap"), [{ kind: "SpendingCap", message: `spending cap reached: workspace ${month} cost $2/$1.5`, cap: { which: `workspace ${month} cost`, used: 2, cap: 1.5 } }]);
  assert.equal(events(run.id).filter((e) => e.type === "reflection").length, 0); // reflecting would be another call

  // A token cap counts the unpriced model too; clearing the caps lets the ticket run again.
  await w.settings({ monthly_cap_usd: null, monthly_cap_tokens: 1_000_000 });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const again = await w.is(t.id, "failed");
  assert.match(finished(again.runs.at(-1).id).reason, new RegExp(`tokens 1000500/1000000$`));
  await w.settings({ monthly_cap_tokens: null });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  await w.is(t.id, "review");
  u = (await call("GET", "/api/usage", w.cookie)).body.cap;
  assert.deepEqual([u.usd, u.tokens, u.used_tokens], [null, null, 1_000_500 + 4 * 130]);
});

test("fix round refused at the boundary: the call in flight finishes, the run fails with the reason; 80% warns once per run", async () => {
  const w = await workspace("capfix", { test_command: "test -f ok.txt", model_review: false });
  spent(w.ws, "demo", 2400);
  // 2400 of 2800 (86%) at the start: a warning. The first call adds 520 (2920): the gate fix round is refused.
  await w.settings({ monthly_cap_tokens: 2800 });
  const t = await w.create({ title: "Fix me", spec: "GATE-FIX-ONCE" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const failed = await w.is(t.id, "failed");
  assert.equal(failed.runs.length, 1); // not retried, not split
  const run = failed.runs[0];
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(finished(run.id).reason, `SpendingCap: spending cap reached: workspace ${month} tokens 2920/2800`);
  assert.deepEqual([finished(run.id).turns, run.tokens_in + run.tokens_out + run.tokens_cached], [4, 520]); // the first call ran to its end
  assert.ok(events(run.id).some((e) => e.type === "test_result" && !e.p.passed));
  assert.ok(events(run.id).some((e) => e.type === "gate_fix")); // it got as far as the fix round
  assert.deepEqual(errors(run.id, "SpendingCapWarning").map((e) => e.cap), [{ which: `workspace ${month} tokens`, used: 2400, cap: 2800 }]);
  assert.equal(errors(run.id, "SpendingCap").length, 1);

  // 2920 of 3700 (79%) at the start: no warning; after the first call 3440 (93%): one warning at the fix round, which runs.
  await w.settings({ monthly_cap_tokens: 3700 });
  const ok = await w.create({ title: "Fix me too", spec: "GATE-FIX-ONCE" });
  await call("POST", `/api/tickets/${ok.id}/runs`, w.cookie);
  const passed = await w.is(ok.id, "review");
  assert.equal(errors(passed.runs[0].id, "SpendingCapWarning").length, 1);
  assert.equal(errors(passed.runs[0].id, "SpendingCap").length, 0);

  // Above 80% at every check of a run: still one warning.
  await w.settings({ monthly_cap_tokens: 4400 }); // 3700 of 4400 (84%), then 4220 (96%)
  const once = await w.create({ title: "Third", spec: "GATE-FIX-ONCE" });
  await call("POST", `/api/tickets/${once.id}/runs`, w.cookie);
  const third = await w.is(once.id, "review");
  assert.ok(events(third.runs[0].id).some((e) => e.type === "gate_fix")); // two checks: start and the fix round
  assert.equal(errors(third.runs[0].id, "SpendingCapWarning").length, 1);
});

test("epic cap covers the whole tree: planner round + child spend stop the next child, then the epic fails", async () => {
  const w = await workspace("capepic", { test_command: "true", model_review: false, auto_approve_children: true, auto_split: false });
  // Round 1 (4 turns, 520 tokens: under the cap alone) starts A (2 turns, 260) mid-round; B waits for A. When A is done
  // the tree is at 650 (round 1 still on its last turn) or 780: over the cap only with the child counted.
  const e = await w.create({ title: "Capped", spec: "Two files", kind: "epic", cap_tokens: 600 });
  await call("POST", `/api/tickets/${e.id}/runs`, w.cookie);
  const failed = await w.is(e.id, "failed");
  await idle(w.ws);
  const kids = (await w.get(e.id)).children;
  const [a, b] = ["Create a.txt", "Create b.txt"].map((title) => kids.find((k: any) => k.title === title));
  assert.equal(a.status, "done");
  assert.equal(b.status, "failed");
  const bRuns = (await w.get(b.id)).runs;
  assert.equal(bRuns.length, 1);
  assert.match(finished(bRuns[0].id).reason, new RegExp(`^SpendingCap: spending cap reached: ${e.key} tokens (650|780)/600$`));
  assert.match(b.handoff, /spending cap reached/);
  // B's failure woke the planner: its round 2 is refused at the start, and the epic fails without another retry.
  const rounds = failed.runs.filter((r: any) => r.role === "planner");
  assert.deepEqual(rounds.map((r: any) => r.status), ["passed", "failed"]);
  assert.equal(finished(rounds[1].id).turns, 0);
  assert.equal(failed.handoff, `SpendingCap: spending cap reached: ${e.key} tokens 780/600`);
  const detail = await w.get(e.id);
  assert.deepEqual(detail.spent, { usd: 0, tokens: 780 });
  assert.deepEqual([detail.cap_tokens, detail.cap_usd], [600, null]);
});
