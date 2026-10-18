import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M8 model review, with the demo provider playing worker and reviewer.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host";
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "mr-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");

const origin = "http://localhost:5173";
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set || cookie };
}
const { cookie: signed } = await call("POST", "/api/auth/sign-up/email", "", { email: "mr@x.dev", password: "password-123", name: "mr" });
const me = (await call("POST", "/api/auth/organization/create", signed, { name: "Mr", slug: "mr" })).cookie;

const repo = realpathSync(mkdtempSync(join(tmpdir(), "mr-repo-")));
writeFileSync(join(repo, "README.md"), "hi\n");
execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
const settings = { repo_path: repo, setup_command: "", test_command: "test -f notes.txt" };

async function ticketRun(title: string) {
  const t = (await call("POST", "/api/tickets", me, { title })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, me)).status, 201);
  let ticket = t;
  for (const end = Date.now() + 30_000; Date.now() < end && !["review", "failed"].includes(ticket.status); await new Promise((r) => setTimeout(r, 50)))
    ticket = (await call("GET", `/api/tickets/${t.id}`, me)).body;
  return ticket;
}
const reviews = (ticketId: string) =>
  (db.prepare("SELECT r.id AS run_id, r.attempt, e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND e.type = 'model_review' ORDER BY r.rowid, e.seq").all(ticketId) as { run_id: string; attempt: number; payload: string }[])
    .map((e) => ({ ...e, ...JSON.parse(e.payload) }));

test("settings: model_review defaults on, round-trips, and is unchanged when omitted", async () => {
  assert.equal((await call("GET", "/api/settings", me)).body.model_review, 1);
  assert.equal((await call("PUT", "/api/settings", me, { ...settings, model_review: false })).body.model_review, 0);
  assert.equal((await call("GET", "/api/settings", me)).body.model_review, 0);
  assert.equal((await call("PUT", "/api/settings", me, settings)).body.model_review, 0); // omitted = unchanged
  assert.equal((await call("PUT", "/api/settings", me, { ...settings, model_review: "on" })).body.model_review, 1);
  assert.equal((await call("PUT", "/api/settings", me, settings)).body.model_review, 1);
});

test("on by default: a normal ticket gets one approving review, its usage counted in the run", async () => {
  const t = await ticketRun("plain");
  assert.equal(t.status, "review");
  const rv = reviews(t.id);
  assert.deepEqual(rv.map((r) => [r.round, r.verdict, r.findings.length]), [[1, "approve", 0]]);
  const run = t.runs[0];
  assert.equal(run.tokens_in, 4 * 100 + 2 * 60); // worker 4 turns + reviewer 2 turns
  const types = (db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY seq").all(run.id) as { type: string }[]).map((e) => e.type);
  assert.ok(types.indexOf("test_result") < types.indexOf("model_review_started") && types.indexOf("model_review") < types.indexOf("commit"));
});

test("REVIEW-ONCE: changes requested, the worker fixes in the same run, the gate re-runs, round 2 approves", async () => {
  const t = await ticketRun("REVIEW-ONCE change");
  assert.equal(t.status, "review");
  assert.equal(t.runs.length, 1);
  assert.deepEqual(reviews(t.id).map((r) => [r.round, r.verdict, r.attempt]), [[1, "request_changes", 1], [2, "approve", 1]]);
  assert.equal(reviews(t.id)[0].findings[0].file, "notes.txt");
  const gates = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'test_result'").all(t.runs[0].id) as { payload: string }[];
  assert.equal(gates.length, 2);
  const branch = (db.prepare("SELECT branch FROM runs WHERE id = ?").get(t.runs[0].id) as { branch: string }).branch;
  assert.match(execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: repo, encoding: "utf8" }), /^fixed\.txt$/m);
});

test("REVIEW-WRITES: files the reviewer writes are undone and never committed", async () => {
  const t = await ticketRun("REVIEW-WRITES change");
  assert.equal(t.status, "review");
  const run = t.runs[0];
  const errors = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'error'").all(run.id) as { payload: string }[];
  assert.match(errors.map((e) => e.payload).join(), /reviewer changed files; its changes were undone/);
  const branch = (db.prepare("SELECT branch FROM runs WHERE id = ?").get(run.id) as { branch: string }).branch;
  assert.doesNotMatch(execFileSync("git", ["ls-tree", "-r", "--name-only", branch], { cwd: repo, encoding: "utf8" }), /reviewer\.txt/);
  assert.equal(execFileSync("git", ["show", `${branch}:notes.txt`], { cwd: repo, encoding: "utf8" }), "hello from the demo agent\n");
});

test("model_review off: no review events", async () => {
  await call("PUT", "/api/settings", me, { ...settings, model_review: false });
  const t = await ticketRun("no review");
  assert.equal(t.status, "review");
  assert.equal(reviews(t.id).length, 0);
});

test("a retry is told why the previous attempt really failed: a gate failure after a review fix round is not a review failure", async () => {
  await call("PUT", "/api/settings", me, { ...settings, model_review: true, auto_split: false });
  const t = (await call("POST", "/api/tickets", me, { title: "REVIEW-ONCE then the gate breaks", test_command: "test ! -f fixed.txt" })).body;
  await call("POST", `/api/tickets/${t.id}/runs`, me);
  let ticket = t;
  for (const end = Date.now() + 40_000; Date.now() < end && ticket.status !== "failed"; await new Promise((r) => setTimeout(r, 50))) ticket = (await call("GET", `/api/tickets/${t.id}`, me)).body;
  assert.equal(ticket.runs.length, 3);
  const task = JSON.parse((db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'run_started'").get(ticket.runs[1].id) as { payload: string }).payload).task;
  assert.match(task, /Previous attempt failed: `test ! -f fixed\.txt` exited with code 1/);
  assert.doesNotMatch(task, /changes still requested/);
});

test("snapshot leaves the index alone: the reviewer's git diff shows the change, and restore undoes its writes", async () => {
  const { snapshot, restore } = await import("../server/git.ts");
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "mr-snap-")));
  const sh = (cmd: string) => execFileSync("sh", ["-c", cmd], { cwd: wt, encoding: "utf8" });
  sh("git init -q -b main && echo a > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init && echo changed > a.txt && echo new > new.txt");
  const status = sh("git status --short");
  const before = await snapshot(wt);
  assert.match(sh("git diff"), /\+changed/); // what the reviewer runs
  assert.equal(sh("git status --short"), status); // new.txt still untracked, a.txt unstaged
  sh("echo junk > reviewer.txt; echo tampered > a.txt"); // the reviewer writes
  assert.notEqual(await snapshot(wt), before);
  await restore(wt, before);
  assert.equal(sh("git status --short"), status);
  assert.equal(sh("cat a.txt"), "changed\n");
  assert.equal(await snapshot(wt), before);
});

test("the reviewer sees the worker's new file as untracked", async () => {
  await call("PUT", "/api/settings", me, { ...settings, model_review: true });
  const t = await ticketRun("untracked check");
  const id = t.runs[0].id;
  const results = (db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'tool_result' AND seq > (SELECT seq FROM events WHERE run_id = ? AND type = 'model_review_started')").all(id, id) as { payload: string }[]).map((e) => JSON.parse(e.payload).content);
  assert.match(results.join("\n"), /\?\? notes\.txt/);
});
