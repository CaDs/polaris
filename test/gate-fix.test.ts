import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Gate fix round, flaky re-run and the reviewer's budget, with the demo provider as worker and reviewer.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host";
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "gf-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");

const origin = "http://localhost:5173";
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set || cookie };
}
const { cookie: signed } = await call("POST", "/api/auth/sign-up/email", "", { email: "gf@x.dev", password: "password-123", name: "gf" });
const me = (await call("POST", "/api/auth/organization/create", signed, { name: "Gf", slug: "gf" })).cookie;

const repo = realpathSync(mkdtempSync(join(tmpdir(), "gf-repo-")));
writeFileSync(join(repo, "README.md"), "hi\n");
execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
const settings = (o: object = {}) => call("PUT", "/api/settings", me, { repo_path: repo, setup_command: "", test_command: "test -f ok.txt", protected_paths: "tests", model_review: false, auto_split: false, wiki: false, ...o });

async function ticketRun(title: string, test_command?: string) {
  const t = (await call("POST", "/api/tickets", me, { title, test_command })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, me)).status, 201);
  let ticket = t;
  for (const end = Date.now() + 40_000; Date.now() < end && !["review", "failed"].includes(ticket.status); await new Promise((r) => setTimeout(r, 50)))
    ticket = (await call("GET", `/api/tickets/${t.id}`, me)).body;
  return ticket;
}
const events = (runId: string, type: string) => (db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = ? ORDER BY seq").all(runId, type) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const marker = () => join(mkdtempSync(join(tmpdir(), "gf-marker-")), "m");

test("GATE-FIX-ONCE: the gate fails, the worker fixes it in the same run, the second gate passes", async () => {
  await settings();
  const t = await ticketRun("GATE-FIX-ONCE change");
  assert.equal(t.status, "review");
  assert.equal(t.runs.length, 1);
  const id = t.runs[0].id;
  assert.deepEqual(events(id, "test_result").map((g) => g.passed), [false, true]);
  assert.match(events(id, "gate_fix")[0].reason, /`test -f ok\.txt` exited with code 1/);
  const types = (db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY seq").all(id) as { type: string }[]).map((e) => e.type);
  assert.ok(types.indexOf("gate_fix") < types.lastIndexOf("test_result") && types.indexOf("test_result") < types.indexOf("gate_fix"));
  assert.equal(events(id, "run_finished")[0].turns, 4 + 2); // worker + fix round
  assert.equal(t.runs[0].tokens_in, 6 * 100);
});

test("a gate that still fails after the fix round fails the attempt; attempt 2 starts fresh with the failure fed back", async () => {
  const t = await ticketRun("plain change");
  assert.equal(t.status, "review");
  assert.deepEqual(t.runs.map((r: any) => r.attempt), [1, 2]);
  const [a1, a2] = t.runs;
  assert.deepEqual(events(a1.id, "test_result").map((g) => g.passed), [false, false]); // 1 fix round, no more
  assert.equal(events(a1.id, "gate_fix").length, 1);
  assert.equal(events(a2.id, "gate_fix").length, 0);
  assert.match(events(a2.id, "run_started")[0].task, /Previous attempt failed: `test -f ok\.txt` exited with code 1/);
});

test("a fix round that runs out of turns falls back to a fresh attempt 2, like any gate failure", async () => {
  await settings({ max_turns: 10 }); // the stalling fix round scripts 130 turns: keep the test fast
  const t = await ticketRun("GATE-FIX-STALL change");
  await settings({ max_turns: 120 });
  assert.ok(t.runs.length >= 2, "attempt 2 was queued");
  const a1 = t.runs[0];
  assert.equal(events(a1.id, "gate_fix").length, 1);
  assert.match(events(a1.id, "run_finished")[0].reason, /exited with code 1; the fix round ended: turn budget exhausted/);
});

test("flaky: a failure that passes on an immediate re-run passes the gate, flagged, with no fix round", async () => {
  const m = marker();
  await settings({ test_command: "test -f notes.txt" });
  const t = await ticketRun("flaky change", `test -f ${m} || { touch ${m}; echo first run fails; exit 3; }`);
  assert.equal(t.status, "review");
  assert.equal(t.runs.length, 1);
  const id = t.runs[0].id;
  const gates = events(id, "test_result");
  assert.equal(gates.length, 1);
  assert.deepEqual([gates[0].passed, gates[0].flaky], [true, true]);
  assert.deepEqual(gates[0].first_failure, { code: 3, timed_out: false, output: "first run fails" });
  assert.equal(events(id, "gate_fix").length, 0);
  assert.equal(events(id, "run_finished")[0].turns, 4);
});

test("a real failure runs the command twice per check; a protected-path change is not re-run and asks for a revert", async () => {
  const count = marker();
  await settings({ test_command: "test -f notes.txt" });
  const t = await ticketRun("real failure", `echo x >> ${count}; test -f nope.txt`);
  assert.equal(t.status, "failed");
  const lines = () => execFileSync("wc", ["-l", count], { encoding: "utf8" }).trim().split(" ")[0];
  assert.equal(lines(), String(3 * 2 * 2)); // 3 attempts × (gate + gate after the fix round) × (run + re-run)

  const prot = marker();
  const t2 = await ticketRun("SPLIT-ME again", `echo x >> ${prot}; test -f notes.txt`);
  assert.equal(t2.status, "failed");
  const gates = events(t2.runs[0].id, "test_result");
  assert.equal(gates.length, 2);
  assert.ok(gates.every((g) => !g.passed && g.protected.join() === "tests/broken.txt" && !g.flaky));
  assert.match(events(t2.runs[0].id, "gate_fix")[0].reason, /modified protected path tests\/broken\.txt/);
  assert.equal(execFileSync("wc", ["-l", prot], { encoding: "utf8" }).trim().split(" ")[0], String(3 * 2)); // one run per check
});

test("reviewer budget: clamp(6 + ceil(lines / 8), 8, 25) from the change's size", async () => {
  await settings({ test_command: "test -f notes.txt", model_review: true });
  const budgetFor = async (setup: string) => {
    await settings({ test_command: "test -f notes.txt", model_review: true, setup_command: setup });
    const t = await ticketRun(`review budget ${setup}`);
    assert.equal(t.status, "review");
    const { budget, lines } = events(t.runs[0].id, "model_review_started")[0];
    return [budget, lines];
  };
  assert.deepEqual(await budgetFor("true"), [8, 1]); // notes.txt: 1 line
  assert.deepEqual(await budgetFor("seq 1 40 > big.txt"), [12, 41]);
  assert.deepEqual(await budgetFor("seq 1 500 > big.txt"), [25, 501]);
});
