import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M6: reflection → lessons, eval cases + eval runs, prompt versions with eval-gated promotion. HARNESS_SANDBOX=host (no docker).
process.env.HARNESS_PROVIDER = "fake";
process.env.HARNESS_SANDBOX = "host";
process.env.HARNESS_CONCURRENCY = "2";
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "improve-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { activePrompt, addPrompt, promote, promotion, REFLECT_SYSTEM, seriesDigest, LESSONS_MAX } = await import("../server/improve.ts");

const origin = "http://localhost:5173";
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const worker = readFileSync(new URL("../server/agent/prompts/worker.md", import.meta.url), "utf8");

function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  writeFileSync(join(dir, "README.md"), "hi\n");
  sh(dir, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init");
  return dir;
}
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set || cookie };
}
async function user(name: string) {
  const { cookie } = await call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  return (await call("POST", "/api/auth/organization/create", cookie, { name, slug: name })).cookie;
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = await fn();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const waitFor = (cookie: string, id: string, status: string) =>
  until(`ticket ${status}`, async () => {
    const t = (await call("GET", `/api/tickets/${id}`, cookie)).body;
    return t.status === status && t;
  });
const events = (runId: string) =>
  (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));
const wsOf = (slug: string) => (db.prepare("SELECT id FROM organization WHERE slug = ?").get(slug) as { id: string }).id;
const runRow = (id: string) => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, any>;
const evalDone = (cookie: string, id: string) =>
  until("eval run done", async () => (await call("GET", "/api/evals", cookie)).body.runs.find((r: any) => r.id === id && r.status === "done"));

// Mock Anthropic: no tools = reflection (answers mock.reflection); a task mentioning "hold" makes one shell call whose answer
// waits for mock.release(); everything else answers "done" at once. Records every request body.
const mock = { bodies: [] as any[], reflection: "- MOCK-LESSON", gate: Promise.resolve(), release: () => {} };
const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const srv = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  mock.bodies.push(b);
  const first: string = b.messages[0].content[0].text;
  const tool = b.tools && first.includes("hold") && b.messages.at(-1).content[0].type !== "tool_result";
  if (tool) await mock.gate;
  const text = b.tools ? "done" : mock.reflection;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...(tool
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "shell", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"true"}' } },
        ]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
  ]));
});
await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
const mockUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
test.after(() => srv.close());

// A workspace whose runs use the mock (repo with no setup/test command).
async function mockWorkspace(name: string) {
  const cookie = await user(name);
  await call("PUT", "/api/settings", cookie, { repo_path: tempRepo(), setup_command: "", test_command: "", model_review: false });
  const provider = (await call("POST", "/api/providers", cookie, { name: "mock", kind: "anthropic", base_url: mockUrl, api_key: "k" })).body.id;
  await call("PUT", "/api/settings/default-provider", cookie, { provider_id: provider, model: "claude-sonnet-5-5" });
  const run = async (title: string, wait = true) => {
    const t = (await call("POST", "/api/tickets", cookie, { title })).body;
    const r = (await call("POST", `/api/tickets/${t.id}/runs`, cookie)).body;
    if (wait) await waitFor(cookie, t.id, "review");
    return { ticket: t, run: r };
  };
  return { cookie, run };
}
const firstRequest = (marker: string) => mock.bodies.find((b) => b.tools && b.messages[0].content[0].text.includes(marker));

const alice = await user("alice");
const bob = await user("bob");

test("reflection: a separate no-tools conversation, capped, injected into the next run's first message, never the system prompt", async () => {
  const w = await mockWorkspace("rita");
  mock.reflection = `- MOCK-LESSON read tests/ first\n${"- filler bullet that pushes the document past the cap\n".repeat(300)}`;
  const one = await w.run("first ticket");

  const reflections = mock.bodies.filter((b) => !b.tools);
  assert.equal(reflections.length, 1);
  const rq = reflections[0];
  assert.equal(rq.messages.length, 1); // its own conversation, not the run's
  assert.equal(rq.system[0].text, REFLECT_SYSTEM);
  assert.match(rq.messages[0].content[0].text, /^<lessons>\n\(none yet\)\n<\/lessons>\n\n<digest>\nTicket: RIT-1 first ticket\nFinal status: passed after 1 attempt\n/);

  const lessons = (await call("GET", "/api/lessons", w.cookie)).body;
  assert.equal(lessons.versions.length, 1);
  const v1 = lessons.versions[0];
  assert.ok(v1.body.length <= LESSONS_MAX && v1.body.length > LESSONS_MAX - 100, String(v1.body.length));
  assert.ok(v1.body.startsWith("- MOCK-LESSON read tests/ first\n") && v1.body.endsWith("cap"));
  assert.deepEqual([v1.version, v1.source, v1.ticket_key, v1.run_attempt], [1, "reflection", "RIT-1", 1]);
  const ev = events(one.run.id);
  assert.deepEqual(ev.find((e) => e.type === "reflection")!.p, { lessons_id: v1.id, version: 1, chars: v1.body.length, unchanged: false, usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 } });
  assert.deepEqual(ev.slice(-2).map((e) => e.type), ["reflection", "run_finished"]); // before run_finished: live in the transcript
  assert.equal(runRow(one.run.id).tokens_out, 5); // the reflection is not booked on the run

  // The next run: lessons in the first user message, system prompt untouched (prompt v1 = worker.md).
  const two = await w.run("second ticket");
  const req = firstRequest("second ticket");
  assert.equal(req.system[0].text, worker);
  assert.doesNotMatch(JSON.stringify(req.system) + JSON.stringify(req.tools), /MOCK-LESSON/);
  assert.match(req.messages[0].content[0].text, /\n\n# Lessons from earlier runs\n\n- MOCK-LESSON read tests\/ first\n[\s\S]*\n\n# Task\n\nsecond ticket$/);
  assert.deepEqual([runRow(two.run.id).prompt_version, runRow(two.run.id).lessons_version], [1, 1]);
  // Same answer again → no new version.
  assert.equal(events(two.run.id).find((e) => e.type === "reflection")!.p.unchanged, true);
  assert.equal((await call("GET", "/api/lessons", w.cookie)).body.versions.length, 1);
});

test("lessons: a human edit and a restore each create a version; size cap; other workspaces see none of it", async () => {
  const lena = await user("lena");
  assert.deepEqual((await call("GET", "/api/lessons", lena)).body.versions, []);
  const v1 = await call("PUT", "/api/lessons", lena, { body: "- use pnpm\n" });
  assert.deepEqual([v1.status, v1.body.version, v1.body.source, v1.body.author, v1.body.body], [201, 1, "human", "lena@x.dev", "- use pnpm"]);
  assert.equal((await call("PUT", "/api/lessons", lena, { body: "- use pnpm" })).status, 200); // unchanged: no version
  assert.equal((await call("PUT", "/api/lessons", lena, { body: "- use npm" })).body.version, 2);
  const big = await call("PUT", "/api/lessons", lena, { body: "x".repeat(LESSONS_MAX + 1) });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /at most 8000 characters/);

  const r = await call("POST", `/api/lessons/${v1.body.id}/restore`, lena);
  assert.deepEqual([r.status, r.body.version, r.body.source, r.body.restored_from, r.body.body], [201, 3, "restore", 1, "- use pnpm"]);
  const all = (await call("GET", "/api/lessons", lena)).body.versions;
  assert.deepEqual(all.map((v: any) => v.version), [3, 2, 1]);

  assert.equal((await call("POST", `/api/lessons/${v1.body.id}/restore`, bob)).status, 404);
  assert.ok((await call("GET", "/api/lessons", bob)).body.versions.every((v: any) => v.body !== "- use pnpm"));
});

test("a reject with a note is reflected on too; the event lands after run_finished and is still replayed", async () => {
  const rex = await user("rex");
  await call("PUT", "/api/settings", rex, { repo_path: tempRepo(), setup_command: "", test_command: "", model_review: false });
  const t = (await call("POST", "/api/tickets", rex, { title: "too much" })).body;
  await call("POST", `/api/tickets/${t.id}/runs`, rex);
  const run = (await waitFor(rex, t.id, "review")).runs[0];
  await call("POST", `/api/tickets/${t.id}/reject`, rex, { note: "keep it smaller" });
  const v = await until("rejection lessons", async () => (await call("GET", "/api/lessons", rex)).body.versions.find((x: any) => x.version === 2));
  assert.equal(v.body, "- REX-1 too much: passed\n- REX-1 too much: rejected");
  assert.match(seriesDigest(run.id, undefined, "keep it smaller"), /^Ticket: REX-1 too much\nFinal status: rejected after 1 attempt\nReviewer note: keep it smaller\n/);
  const sse = await (await app.request(`/api/runs/${run.id}/events`, { headers: { cookie: rex, origin } })).text();
  const types = sse.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).type);
  assert.deepEqual(types.slice(-4), ["reflection", "run_finished", "review", "reflection"]);
});

// Shared by the eval tests below: alice's repo (gate `test -f ok.txt`) and her approved case.
let shared: { repo: string; ticket: any; caseId: string; baseSha: string; v1: string };

test("eval cases: an approved ticket that fails at base_sha is accepted, one that passes there is rejected", async () => {
  const repo = tempRepo();
  await call("PUT", "/api/settings", alice, { repo_path: repo, setup_command: "", test_command: "test -f ok.txt", model_review: false, wiki: false }); // no ingest run: the tests delete tickets and count worktrees
  const t = (await call("POST", "/api/tickets", alice, { title: "make ok", spec: "create ok.txt" })).body;
  assert.equal((await call("POST", "/api/evals/cases", alice, { ticket_id: t.id })).status, 409); // not done yet
  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  const done = await waitFor(alice, t.id, "review");
  const [r1, r2] = done.runs;

  // The digest reflection saw: both attempts, the gate failure with its output, no transcript.
  const digest = seriesDigest(r2.id);
  assert.match(digest, /^Ticket: ALI-1 make ok\nFinal status: passed after 2 attempts\n\nAttempt 1: failed \(`test -f ok.txt` exited with code 1\), 4 turns, 480 tokens, model demo\n- gate failed: `test -f ok.txt` exited with code 1\n/);
  assert.match(digest, /\nAttempt 2: passed, 4 turns, 480 tokens, model demo$/);
  assert.doesNotMatch(digest, /hello from the demo agent/);
  assert.equal(events(r1.id).some((e) => e.type === "reflection"), false); // not the end of the series: it retried
  assert.match((await call("GET", "/api/lessons", alice)).body.versions[0].body, /^- ALI-1 make ok: passed$/);

  await call("POST", `/api/tickets/${t.id}/approve`, alice);
  const c = await call("POST", "/api/evals/cases", alice, { ticket_id: t.id });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.base_sha, c.body.title, c.body.spec, c.body.test_command], [r2.base_sha, "make ok", "create ok.txt", "test -f ok.txt"]);
  assert.equal((await call("POST", "/api/evals/cases", alice, { ticket_id: t.id })).status, 409);
  assert.equal((await call("POST", "/api/evals/cases", bob, { ticket_id: t.id })).status, 404);
  const del = await call("DELETE", `/api/tickets/${t.id}`, alice);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /eval case/);
  assert.equal(sh(repo, "git worktree list").split("\n").length, 1); // validation cleaned up

  // main now has ok.txt: the next ticket passes at its base commit, so it can't be a case.
  const t2 = (await call("POST", "/api/tickets", alice, { title: "already ok" })).body;
  await call("POST", `/api/tickets/${t2.id}/runs`, alice);
  await waitFor(alice, t2.id, "review");
  await call("POST", `/api/tickets/${t2.id}/approve`, alice);
  const bad = await call("POST", "/api/evals/cases", alice, { ticket_id: t2.id });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /`test -f ok.txt` already passes at [0-9a-f]{8} .*can't tell/);
  // A ticket's own test_command is the one a case freezes (and validates at the base commit).
  const t3 = (await call("POST", "/api/tickets", alice, { title: "own gate", test_command: "test -f README.md" })).body;
  await call("POST", `/api/tickets/${t3.id}/runs`, alice);
  await waitFor(alice, t3.id, "review");
  await call("POST", `/api/tickets/${t3.id}/approve`, alice);
  assert.match((await call("POST", "/api/evals/cases", alice, { ticket_id: t3.id })).body.error, /`test -f README\.md` already passes/);
  assert.equal((await call("GET", "/api/evals", alice)).body.cases.length, 1);
  shared = { repo, ticket: t, caseId: c.body.id, baseSha: r2.base_sha, v1: (await call("GET", "/api/prompts", alice)).body.versions[0].id };
});

test("eval run: every case in a fresh worktree at base_sha; the ticket is untouched; nothing is left behind; results recorded", async () => {
  const { repo, ticket, caseId, baseSha, v1 } = shared;
  const before = (await call("GET", `/api/tickets/${ticket.id}`, alice)).body;
  const start = await call("POST", `/api/prompts/${v1}/evals`, alice);
  assert.equal(start.status, 201);
  assert.equal((await call("GET", `/api/tickets/${ticket.id}`, alice)).body.status, "done");
  const er = await evalDone(alice, start.body.id);
  assert.deepEqual([er.prompt_version, er.passed, er.total, er.mean_tokens, er.case_ids], [1, 0, 1, 480, [caseId]]);
  const res = er.results[0];
  assert.deepEqual([res.case_passed, res.turns, res.tokens_in + res.tokens_out, res.prompt_version, res.attempt], [0, 4, 480, 1, 1]);
  assert.equal(res.lessons_version, er.lessons_version);

  const ev = events(res.id);
  assert.deepEqual(ev[0].p, { step: "worktree", branch: "", base_sha: baseSha });
  assert.ok(!ev.some((e) => ["commit", "reflection"].includes(e.type)));
  assert.equal(ev.find((e) => e.type === "test_result")!.p.passed, false);
  const task = ev.find((e) => e.type === "run_started")!.p.task;
  assert.match(task, /branched from [0-9a-f]{8}\n[\s\S]*# Lessons from earlier runs\n\n- ALI-1 make ok: passed[\s\S]*# Task\n\n# make ok\n\ncreate ok.txt$/);
  assert.doesNotMatch(task, /Previous attempt failed|reviewer/);

  // Source ticket: same status, same runs, same totals. No worktree, branch or directory left.
  const after = (await call("GET", `/api/tickets/${ticket.id}`, alice)).body;
  assert.deepEqual([after.status, after.runs.length, after.tokens_in, after.run_status], [before.status, before.runs.length, before.tokens_in, before.run_status]);
  assert.equal(sh(repo, "git worktree list").split("\n").length, 1);
  assert.equal(sh(repo, "git for-each-ref refs/heads/harness"), "");
  assert.equal(existsSync(res.worktree), false);
  // Viewable like any run of the workspace.
  assert.equal((await call("GET", `/api/runs/${res.id}`, alice)).status, 200);
  assert.equal((await call("GET", `/api/runs/${res.id}`, bob)).status, 404);
  const p = (await call("GET", "/api/prompts", alice)).body.versions[0];
  assert.deepEqual([p.evals[0].passed, p.evals[0].total, p.evals[0].current], [0, 1, true]);
});

test("propose → eval → promote: the proposal wins on the evals and the next run uses it", async () => {
  const proposed = await call("POST", "/api/prompts/propose", alice);
  assert.equal(proposed.status, 201);
  const v2 = proposed.body;
  assert.deepEqual([v2.version, v2.active, v2.source, v2.author], [2, 0, "proposal", "demo"]);
  assert.equal(v2.body, `${worker}\nALWAYS-CREATE-OK`); // current prompt + "\nALWAYS-CREATE-OK"
  assert.match(v2.rationale, /ok\.txt/);

  const view = async () => (await call("GET", "/api/prompts", alice)).body.versions.find((p: any) => p.id === v2.id);
  assert.match((await view()).promotion.reason, /Run an eval of v2 on the current 1 case first/);
  assert.equal((await call("POST", `/api/prompts/${v2.id}/promote`, alice)).status, 409);
  assert.equal((await call("POST", `/api/prompts/${v2.id}/promote`, bob)).status, 404);
  assert.equal((await call("POST", `/api/prompts/${v2.id}/evals`, bob)).status, 404);

  const e = await call("POST", `/api/prompts/${v2.id}/evals`, alice);
  assert.deepEqual([(await evalDone(alice, e.body.id)).passed, (await view()).promotion.ok], [1, true]);
  assert.match((await view()).promotion.reason, /Higher pass rate: v2 passed 1\/1/);
  assert.equal((await call("POST", `/api/prompts/${v2.id}/promote`, alice)).status, 200);
  assert.equal((await view()).active, 1);

  const t = (await call("POST", "/api/tickets", alice, { title: "after promotion" })).body;
  const run = (await call("POST", `/api/tickets/${t.id}/runs`, alice)).body;
  assert.equal(run.prompt_version, 2);
  await waitFor(alice, t.id, "review");
  assert.match(events(run.id).find((x) => x.type === "assistant_message")!.p.message.content[0].text, /the system prompt says so/);
});

test("promotion rule: no eval / other case set / not better are blocked; strictly better or equal with ≥10% fewer tokens pass", async () => {
  const cookie = await user("pia");
  const ws = wsOf("pia");
  const v1 = activePrompt(ws);
  const v2 = addPrompt(ws, "prompt two", { source: "human", author: "pia@x.dev" });
  assert.equal(v2.active, 0);
  const rule = () => promotion(ws, v2);
  assert.match(rule().reason, /No eval cases yet/);
  assert.match(promotion(ws, v1).reason, /active version/);

  const ticket = async () => (await call("POST", "/api/tickets", cookie, { title: "case" })).body.id;
  const addCase = async () => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO eval_cases (id, workspace_id, ticket_id, title, spec, repo_path, base_sha, setup_command, test_command, protected_paths, image)
      VALUES (?, ?, ?, 'c', '', '/x', 'abc', '', 'true', '', 'img')`).run(id, ws, await ticket());
    return id;
  };
  let at = 0;
  const evalOf = (p: { id: string; version: number }, passed: number, mean: number, set: string[]) =>
    db.prepare("INSERT INTO eval_runs (id, workspace_id, prompt_id, prompt_version, case_ids, model, status, passed, total, mean_tokens, started_at) VALUES (?, ?, ?, ?, ?, 'm', 'done', ?, ?, ?, ?)").run(
      crypto.randomUUID(), ws, p.id, p.version, JSON.stringify([...set].sort()), passed, set.length, mean, ++at,
    );

  const c1 = await addCase();
  assert.match(rule().reason, /Run an eval of v2/);
  evalOf(v2, 1, 100, [c1]);
  assert.match(rule().reason, /active v1 has no eval on the current case set/);
  evalOf(v1, 1, 100, [c1]);
  evalOf(v2, 1, 95, [c1]);
  assert.deepEqual([rule().ok, /Not better/.test(rule().reason)], [false, true]); // only 5% fewer tokens
  evalOf(v2, 1, 90, [c1]);
  assert.deepEqual([rule().ok, /≥10% fewer tokens/.test(rule().reason)], [true, true]);
  evalOf(v2, 0, 10, [c1]);
  assert.equal(rule().ok, false); // the latest eval counts
  evalOf(v1, 0, 50, [c1]);
  evalOf(v2, 1, 500, [c1]);
  assert.deepEqual([rule().ok, /Higher pass rate/.test(rule().reason)], [true, true]); // more tokens, but passes more

  // A new case changes the set: evals on the old one no longer count, for either version.
  const c2 = await addCase();
  assert.match(rule().reason, /Run an eval of v2 on the current 2 cases/);
  evalOf(v2, 2, 100, [c1, c2]);
  assert.match(rule().reason, /active v1 has no eval/);
  evalOf(v1, 1, 100, [c1, c2]);
  assert.equal(rule().ok, true);
  // A different set of the same size (subset run) does not match either.
  evalOf(v2, 0, 100, [c1, c2]);
  evalOf(v2, 2, 1, [c2]);
  assert.equal(rule().ok, false);
});

test("a running run keeps its prompt version; runs queued after a promotion use the new one", async () => {
  const w = await mockWorkspace("hal");
  const ws = wsOf("hal");
  mock.reflection = "- ok";
  let release!: () => void;
  mock.gate = new Promise<void>((r) => (release = r));
  const held = await w.run("hold this one", false);
  await until("held run started", async () => firstRequest("hold this one"));
  const v2 = addPrompt(ws, "SECOND PROMPT", { source: "human", author: "hal@x.dev" });
  promote(ws, v2); // the rule is covered above
  const next = await w.run("after the switch", false);
  release();
  await waitFor(w.cookie, held.ticket.id, "review");
  await waitFor(w.cookie, next.ticket.id, "review");
  mock.gate = Promise.resolve();

  const heldReqs = mock.bodies.filter((b) => b.tools && b.messages[0].content[0].text.includes("hold this one"));
  assert.equal(heldReqs.length, 2);
  assert.ok(heldReqs.every((b) => b.system[0].text === worker)); // static within the run
  assert.equal(firstRequest("after the switch").system[0].text, "SECOND PROMPT");
  assert.deepEqual([runRow(held.run.id).prompt_version, runRow(next.run.id).prompt_version], [1, 2]);
});

test("workspaces are isolated: prompts, cases and eval runs", async () => {
  const mine = (await call("GET", "/api/prompts", bob)).body.versions;
  assert.deepEqual(mine.map((p: any) => [p.version, p.active, p.body === worker]), [[1, 1, true]]); // seeded, alice's v2 not visible
  const evals = (await call("GET", "/api/evals", bob)).body;
  assert.deepEqual([evals.cases, evals.runs], [[], []]);
  assert.equal((await call("DELETE", `/api/evals/cases/${shared.caseId}`, bob)).status, 404);
  assert.equal((await call("POST", `/api/prompts/${shared.v1}/evals`, bob)).status, 404);
  // Removing a case is allowed for its owner, and unblocks deleting the ticket.
  assert.equal((await call("DELETE", `/api/evals/cases/${shared.caseId}`, alice)).status, 204);
  assert.equal((await call("DELETE", `/api/tickets/${shared.ticket.id}`, alice)).status, 204);
});
