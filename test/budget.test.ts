import { test } from "node:test";
import assert from "node:assert/strict";

// Worker budget settings (max_turns, max_minutes) and what uses them. POLARIS_SANDBOX=host (no docker), demo provider.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "2";
const { configure, fileTicket, call, db, events, idle, until, workspace } = await import("./helpers.ts");

test("settings: max_turns / max_minutes default, round-trip, accept form strings, validate range and integers, omitted = unchanged", async () => {
  const w = await workspace("bs", { test_command: "true" });
  let s = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual([s.max_turns, s.max_minutes], [120, 60]); // unconfigured
  const put = w.settings;
  s = (await put({})).body;
  assert.deepEqual([s.max_turns, s.max_minutes], [120, 60]);
  s = (await put({ max_turns: "200", max_minutes: 90 })).body; // the web form sends strings
  assert.deepEqual([s.max_turns, s.max_minutes], [200, 90]);
  assert.deepEqual((await call("GET", "/api/settings", w.cookie)).body.max_turns, 200);
  s = (await put({})).body;
  assert.deepEqual([s.max_turns, s.max_minutes], [200, 90]); // omitted = unchanged
  for (const [k, v] of [["max_turns", 9], ["max_turns", 501], ["max_turns", 12.5], ["max_turns", "abc"], ["max_turns", ""], ["max_turns", true], ["max_minutes", 4], ["max_minutes", 601], ["max_minutes", "1.5"], ["max_minutes", []]]) {
    const r = await put({ [k as string]: v });
    assert.equal(r.status, 400, `${k}=${JSON.stringify(v)}`);
    assert.match(r.body.error, /must be a whole number from/);
  }
  s = (await put({ max_turns: 10, max_minutes: 600 })).body; // the bounds
  assert.deepEqual([s.max_turns, s.max_minutes], [10, 600]);
  assert.deepEqual([(await put({ max_turns: 500, max_minutes: 5 })).body.max_turns, db.prepare("SELECT max_minutes FROM workspace_settings WHERE workspace_id = ?").get(s.workspace_id)!.max_minutes], [500, 5]);
  assert.equal((await put({ max_turns: null })).body.max_turns, 120); // null = default
});

test("settings PUT merges: omitted fields keep their value, null resets to the default, a GET body round-trips", async () => {
  const w = await workspace("merge", { test_command: "true" });
  const put = async (b: object) => {
    const r = await configure(w.cookie, b);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const set = { setup_command: "make", image: "img:2", child_size_hint: "tiny", compact_at_tokens: 20_000, max_turns: 200, max_minutes: 90, auto_approve_children: true, model_review: false, auto_split: false, wiki: false };
  const want = { ...set, auto_approve_children: 1, model_review: 0, auto_split: 0, wiki: 0, test_command: "true" };
  const pick = (s: any) => Object.fromEntries(Object.keys(want).map((k) => [k, s[k]]));
  assert.deepEqual(pick(await put(set)), want);
  assert.deepEqual(pick(await put({})), want); // every field class: omitted = unchanged
  const { configured, updated_at, ...back } = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual(pick(await put(back)), want); // toggles come back as 1/0
  assert.deepEqual(pick(await put({ ...back, auto_approve_children: 0, model_review: 1 })), { ...want, auto_approve_children: 0, model_review: 1 });
  const nulls = Object.fromEntries(Object.keys(want).map((k) => [k, null]));
  assert.deepEqual(pick(await put(nulls)), {
    setup_command: "npm ci", test_command: "npm test", image: "polaris-sandbox:1", child_size_hint: "at most 3 files and about 60 changed lines, finishable in 20 agent turns",
    compact_at_tokens: 150_000, max_turns: 120, max_minutes: 60, auto_approve_children: 0, model_review: 1, auto_split: 1, wiki: 1,
  });
  assert.equal((await put({})).repo_path, w.repo);
});

test("worker runs use the workspace max_turns; the planner and the reviewer keep their own budgets", async () => {
  const w = await workspace("bw", { test_command: "true", auto_split: false, model_review: true });
  const ws = (await call("GET", "/api/settings", w.cookie)).body.workspace_id;
  const finished = (runId: string) => events(runId).find((e) => e.type === "run_finished")!.p;
  // The demo worker needs 5 turns: 3 runs out, 10 does not. (Below the API's minimum, so set directly.)
  db.prepare("UPDATE workspace_settings SET max_turns = 3 WHERE workspace_id = ?").run(ws);
  const t = await w.create({ title: "Small", spec: "Do it" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const failed = await w.is(t.id, "failed");
  // Running out of budget is retried like a gate failure (a fresh attempt, the reason fed back), up to the last attempt.
  assert.deepEqual(failed.runs.map((r: any) => [r.attempt, finished(r.id).reason]), [1, 2, 3].map((n) => [n, "turn budget exhausted (3)"]));
  assert.match(events(failed.runs[1].id).find((e) => e.type === "run_started")!.p.task, /Previous attempt failed: turn budget exhausted \(3\)/);

  // The planner of an epic is not bound by it (its round takes more than 3 turns); its children are workers and are.
  const e = await w.create({ title: "Epic", spec: "x", kind: "epic" });
  await call("POST", `/api/tickets/${e.id}/runs`, w.cookie);
  const planner = (await until("planner round", async () => (await w.get(e.id)).runs.find((r: any) => r.role === "planner" && r.status !== "running" && r.status !== "queued"))) as any;
  assert.ok(finished(planner.id).turns > 3 && !/budget/.test(finished(planner.id).reason ?? ""), JSON.stringify(finished(planner.id)));
  await idle(ws);

  // The reviewer: budget 8..25 from the change size, whatever max_turns says.
  assert.equal((await configure(w.cookie, { repo_path: w.repo, setup_command: "", test_command: "true", max_turns: 10 })).status, 200);
  const r = await w.create({ title: "Reviewed", spec: "Create review.txt" });
  await call("POST", `/api/tickets/${r.id}/runs`, w.cookie);
  const done = await w.is(r.id, "review");
  assert.equal(events(done.runs[0].id).find((x) => x.type === "model_review_started")!.p.budget, 8);
  assert.equal(finished(done.runs[0].id).status, "passed");
});

test("max_tokens: a workspace setting (default 2M) the worker's budget uses; the last budget failure splits the ticket", async () => {
  const w = await workspace("bt", { test_command: "true", auto_split: true, model_review: false, wiki: false });
  assert.equal((await call("GET", "/api/settings", w.cookie)).body.max_tokens, 2_000_000);
  assert.equal((await w.settings({ max_tokens: "500000" })).body.max_tokens, 500_000); // form strings
  for (const bad of [99_999, 20_000_001, 1.5, "lots"]) assert.match((await w.settings({ max_tokens: bad })).body.error, /Max tokens per attempt must be a whole number/);
  assert.equal((await w.settings({ max_tokens: null })).body.max_tokens, 2_000_000);

  // The demo worker spends 120 tokens a turn and needs 5 turns: a 300-token budget runs out on every attempt. (Below the
  // API's minimum, so set directly.) The third failure splits the ticket into an epic instead of failing it.
  const ws = (await call("GET", "/api/settings", w.cookie)).body.workspace_id;
  db.prepare("UPDATE workspace_settings SET max_tokens = 300 WHERE workspace_id = ?").run(ws);
  const t = await w.create({ title: "Thirsty", spec: "Do it" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const split = await until("split", async () => (await w.get(t.id)).escalated_key && (await w.get(t.id)));
  assert.deepEqual(split.runs.map((r: any) => events(r.id).find((e) => e.type === "run_finished")!.p.reason.replace(/\(\d+ >= 300\)/, "")), [1, 2, 3].map(() => "token budget exhausted "));
  await idle(ws);
});
