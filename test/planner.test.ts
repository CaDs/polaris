import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M7: epics, planner rounds, dependency scheduling, handoffs, auto-approve. POLARIS_SANDBOX=host (no docker), demo provider.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host";
process.env.POLARIS_CONCURRENCY = "2";
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "planner-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { createRun, subscribe } = await import("../server/agent/events.ts");
const { hostExec, runTool } = await import("../server/agent/tools.ts");
const { extractHandoff, handoffText, plannerTools, MAX_CHILDREN } = await import("../server/planner.ts");
const { pump, wake } = await import("../server/runs.ts");

const origin = "http://localhost:5173";
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const repos: string[] = [];

function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  writeFileSync(join(dir, "README.md"), "hi\n");
  sh(dir, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init");
  repos.push(dir);
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
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = await fn();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const events = (runId: string) =>
  (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));
const task = (runId: string) => events(runId).find((e) => e.type === "run_started")!.p.task as string;

// A workspace with a repo whose gate passes once a.txt or b.txt exists (protected paths: tests/, evals/).
async function workspace(name: string, auto = false, extra = {}) {
  const cookie = await user(name);
  const repo = tempRepo();
  await call("PUT", "/api/settings", cookie, { repo_path: repo, setup_command: "", test_command: "test -f a.txt || test -f b.txt", auto_approve_children: auto, ...extra });
  const get = async (id: string) => (await call("GET", `/api/tickets/${id}`, cookie)).body;
  const epic = async (title: string, spec = "") => {
    const e = (await call("POST", "/api/tickets", cookie, { title, spec, kind: "epic" })).body;
    assert.equal((await call("POST", `/api/tickets/${e.id}/runs`, cookie)).status, 201);
    return e;
  };
  // Waits until the epic's child with this title is in that state; returns the epic detail.
  const childIs = (epicId: string, title: string, status: string) =>
    until(`${title} ${status}`, async () => {
      const d = await get(epicId);
      return d.children.find((c: any) => c.title === title)?.status === status && d;
    });
  const is = (id: string, status: string) => until(`${status}`, async () => ((await get(id)).status === status ? get(id) : false));
  return { cookie, repo, get, epic, childIs, is };
}

const bob = await user("bob");

test("handoff: text after a Handoff heading, else the whole reply; failures appended", () => {
  assert.equal(extractHandoff("Did it.\n\n## Handoff\n- Results: x\n- Concerns: none\n"), "- Results: x\n- Concerns: none");
  assert.equal(extractHandoff("### handoff (for the planner)\nfoo"), "foo");
  assert.equal(extractHandoff("Only a summary, no heading."), "Only a summary, no heading.");
  const long = extractHandoff("x".repeat(9000));
  assert.ok(long.length < 4100 && long.endsWith("[… truncated]"));
  assert.equal(handoffText("## Handoff\nR", "bad"), "R\n\nThe run failed: bad");
  assert.equal(handoffText("", "`npm test` exited with code 1"), "The run failed: `npm test` exited with code 1");
});

let pam: { epic: any; cookie: string; rounds: string[] };

test("epic: read-only planner round, B waits for A, approve A → B from the updated base, round 2 once nothing is open, review → done", async () => {
  const w = await workspace("pam");
  const init = sh(w.repo, "git rev-parse main");
  const e = await w.epic("Two files", "Add a.txt and b.txt.");
  let d = await w.childIs(e.id, "Create a.txt", "review");
  const [A, B] = d.children;
  assert.deepEqual([A.key, A.parent_key, A.kind, B.key, B.status, B.run_count, B.label, B.depends_keys], ["PAM-2", "PAM-1", "task", "PAM-3", "todo", 0, "waiting on PAM-2", ["PAM-2"]]);
  assert.deepEqual([d.child_count, d.child_done, d.status], [2, 0, "running"]); // waiting for children

  // Round 1: a fresh conversation, read-only tools only, its checkout removed; nothing was committed to main.
  const r1 = d.runs[0];
  assert.deepEqual([r1.role, r1.attempt, r1.status, r1.prompt_version, r1.branch], ["planner", 1, "passed", null, null]);
  assert.match(task(r1.id), /# Epic\n\n# Two files\n\nAdd a\.txt and b\.txt\.\n\n# Children\n\n\(none yet\)$/);
  assert.match(task(r1.id), /Test gate for every child ticket: `test -f a.txt \|\| test -f b.txt` must exit 0, and changes under tests, evals fail it/);
  const calls = events(r1.id).filter((x) => x.type === "tool_call").map((x) => x.p.name);
  assert.deepEqual(calls, ["read_file", "create_ticket", "create_ticket", "finish_round"]);
  assert.equal(events(r1.id).find((x) => x.type === "round_finished")!.p.notes, "Created a.txt and b.txt tickets. Next: read their handoffs, then complete the epic.");
  assert.equal(existsSync(r1.worktree), false);
  assert.doesNotMatch(sh(w.repo, "git worktree list"), new RegExp(r1.id));
  assert.equal(sh(w.repo, "git status --porcelain"), "");
  assert.equal(sh(w.repo, "git rev-parse main"), init);
  const names = plannerTools(e, {}, 0, async () => undefined).map((t) => t.def.name);
  assert.deepEqual(names, ["read_file", "search", "create_ticket", "list_children", "finish_round", "complete_epic"]); // no edit_file/apply_patch/shell

  // The child's worker was told it is part of the epic and handed off.
  const a = (await w.get(A.id)).runs[0];
  assert.match(task(a.id), /one part of the epic PAM-1 "Two files"[\s\S]*"## Handoff" section/);
  const handoff = "- Results: created a.txt at the repository root.\n- Concerns: none.\n- Findings: nothing else in the repository needed to change.";
  assert.equal((await w.get(A.id)).handoff, handoff);
  assert.equal(events(a.id).find((x) => x.type === "handoff")!.p.text, handoff);

  // Approve A: B is queued and branches from main with A merged; A is done while B is open, so no round starts.
  assert.equal((await call("POST", `/api/tickets/${A.id}/approve`, w.cookie)).status, 200);
  d = await w.childIs(e.id, "Create b.txt", "review");
  const b = (await w.get(B.id)).runs[0];
  assert.equal(b.base_sha, sh(w.repo, "git rev-parse main"));
  assert.equal(sh(w.repo, `git show ${b.branch}:a.txt`), "a");
  assert.equal(d.runs.length, 1);

  // Approve B → nothing is open: round 2 reads both handoffs and completes the epic → review with the summary; approving
  // it marks it done (no merge).
  await call("POST", `/api/tickets/${B.id}/approve`, w.cookie);
  d = await w.is(e.id, "review");
  assert.match(task(d.runs[1].id), /## PAM-2 Create a\.txt — done \(new since your last round\)\nKind: task · latest run: #1 passed, demo, \d+ tokens\nHandoff:\n- Results: created a\.txt/);
  assert.match(task(d.runs[1].id), /## PAM-3 Create b\.txt — done \(new since your last round\)\nKind: task · depends on PAM-2/);
  assert.match(task(d.runs[1].id), /# Your notes from earlier rounds\n\n## Round 1\nCreated a\.txt and b\.txt tickets/);
  assert.equal(d.handoff, "Done: PAM-2 Create a.txt; PAM-3 Create b.txt.");
  assert.deepEqual(d.runs.map((r: any) => [r.attempt, r.status]), [[1, "passed"], [2, "passed"]]);
  assert.equal(events(d.runs[1].id).find((x) => x.type === "round_finished")!.p.completed, true);
  const before = sh(w.repo, "git rev-parse main");
  assert.equal((await call("GET", `/api/tickets/${e.id}/diff`, w.cookie)).status, 404);
  const ok = await call("POST", `/api/tickets/${e.id}/approve`, w.cookie);
  assert.deepEqual([ok.status, ok.body.status, ok.body.child_done], [200, "done", 2]);
  assert.equal(sh(w.repo, "git rev-parse main"), before);
  assert.deepEqual([sh(w.repo, "git show main:a.txt"), sh(w.repo, "git show main:b.txt")], ["a", "b"]);
  assert.equal(events(d.runs[1].id).at(-1)!.p.decision, "approved");
  assert.equal((await call("POST", "/api/evals/cases", w.cookie, { ticket_id: e.id })).status, 409); // epics are not eval cases
  pam = { epic: e, cookie: w.cookie, rounds: d.runs.map((r: any) => r.id) };
});

test("create_ticket validation, child limit, sub-epic depth; finish_round/complete_epic refused with the reason", async () => {
  const w = await workspace("val");
  const [e, other] = [(await call("POST", "/api/tickets", w.cookie, { title: "E", kind: "epic" })).body, (await call("POST", "/api/tickets", w.cookie, { title: "Other", kind: "epic" })).body];
  assert.equal((await call("POST", "/api/tickets", w.cookie, { title: "x", kind: "story" })).status, 400);
  const queued: string[] = [];
  const outcome: { notes?: string; summary?: string } = {};
  const use = (epic: any, name: string, input: Record<string, unknown>) =>
    runTool(plannerTools(epic, outcome, 0, async (id) => void queued.push(id)), { type: "tool_use", id: "x", name, input }, { root: w.repo, exec: hostExec });
  const otherChild = await use(other, "create_ticket", { title: "elsewhere", spec: "s" });
  assert.equal(otherChild.content, "Created VAL-3 (queued).");

  assert.match((await use(e, "create_ticket", { spec: "s" })).content, /^InvalidArguments: "title" is required/);
  assert.match((await use(e, "create_ticket", { title: "t", spec: "" })).content, /"spec" is required/);
  assert.match((await use(e, "create_ticket", { title: "t", spec: "s", kind: "story" })).content, /"kind" must be/);
  assert.match((await use(e, "create_ticket", { title: "t", spec: "s", depends_on: "VAL-3" })).content, /must be an array/);
  assert.match((await use(e, "create_ticket", { title: "t", spec: "s", depends_on: ["VAL-3"] })).content, /unknown dependency VAL-3: depends_on must name tickets of this epic \(none yet\)/);
  assert.equal((await use(e, "create_ticket", { title: "A", spec: "s" })).content, "Created VAL-4 (queued).");
  assert.equal((await use(e, "create_ticket", { title: "B", spec: "s", depends_on: ["VAL-4", "VAL-4"] })).content, "Created VAL-5. It is queued when VAL-4 is done.");
  assert.equal(queued.length, 2); // VAL-3 and VAL-4; VAL-5 waits
  const sub = (await use(e, "create_ticket", { title: "Sub", spec: "s", kind: "epic" })).content;
  assert.equal(sub, "Created VAL-6 (queued).");
  const subEpic = (await call("GET", "/api/tickets", w.cookie)).body.find((t: any) => t.key === "VAL-6");
  assert.deepEqual([subEpic.kind, subEpic.parent_key], ["epic", "VAL-1"]);
  assert.match((await use(subEpic, "create_ticket", { title: "deeper", spec: "s", kind: "epic" })).content, /sub-epics cannot create epics \(depth limit 2\)/);
  assert.equal((await use(subEpic, "create_ticket", { title: "sub task", spec: "s" })).is_error, false);

  // Nothing ran (the queue was stubbed), so everything is open.
  const refused = await use(e, "complete_epic", { summary: "done" });
  assert.match(refused.content, /children are still open: VAL-4 \(todo\), VAL-5 \(waiting on VAL-4\), VAL-6 \(todo\)\. Call finish_round/);
  assert.equal(outcome.summary, undefined);
  assert.equal((await use(e, "finish_round", { notes: "wait" })).content, "Round finished. The next round starts when a child fails or no child is open any more.");
  assert.equal(outcome.notes, "wait");

  // A failed dependency blocks its dependents: blocked children are not open.
  db.prepare("UPDATE tickets SET status = 'failed' WHERE number = 4 AND workspace_id = ?").run(e.workspace_id);
  db.prepare("UPDATE tickets SET status = 'done' WHERE number = 6 AND workspace_id = ?").run(e.workspace_id);
  const d = (await call("GET", `/api/tickets/${e.id}`, w.cookie)).body;
  assert.deepEqual(d.children.map((c: any) => [c.key, c.label]), [["VAL-4", "failed"], ["VAL-5", "blocked (dependency VAL-4 failed)"], ["VAL-6", "done"], ["VAL-7", "todo"]]);
  assert.match((await use(e, "list_children", {})).content, /## VAL-5 B — blocked \(dependency VAL-4 failed\)\nKind: task · depends on VAL-4 · latest run: none\nHandoff: \(none yet\)/);
  assert.equal((await use(e, "complete_epic", { summary: "partly" })).is_error, false);

  // Limit: 12 children per epic (in a new round: this one ended).
  delete outcome.notes;
  delete outcome.summary;
  for (let i = (await call("GET", `/api/tickets/${e.id}`, w.cookie)).body.child_count; i < MAX_CHILDREN; i++) await use(e, "create_ticket", { title: `t${i}`, spec: "s" });
  assert.equal((await call("GET", `/api/tickets/${e.id}`, w.cookie)).body.child_count, MAX_CHILDREN);
  assert.match((await use(e, "create_ticket", { title: "one too many", spec: "s" })).content, /already has 12 child tickets, the limit/);
  // No open child: finish_round would wait forever.
  const empty = (await call("POST", "/api/tickets", w.cookie, { title: "Empty", kind: "epic" })).body;
  assert.match((await use(empty, "finish_round", { notes: "?" })).content, /no child ticket is open .*nothing would start another round/);
  db.prepare("DELETE FROM tickets WHERE workspace_id = ?").run(e.workspace_id); // nothing of this workspace may ever run
});

test("rounds are batched: children that settle while a round is queued are seen by that one round", async () => {
  const w = await workspace("bat");
  const e = await w.epic("Parallel", "PARALLEL");
  await w.childIs(e.id, "Create a.txt", "review");
  const d = await w.childIs(e.id, "Create b.txt", "review");
  assert.deepEqual(d.children.map((c: any) => c.depends_keys), [[], []]);
  await until("round 1 finished", async () => (await w.get(e.id)).runs[0].status === "passed");
  process.env.POLARIS_CONCURRENCY = "0"; // hold the queue
  try {
    for (const c of d.children) assert.equal((await call("POST", `/api/tickets/${c.id}/approve`, w.cookie)).status, 200);
    const held = (await w.get(e.id)).runs;
    assert.deepEqual(held.map((r: any) => r.status), ["passed", "queued"]); // the second settle found round 2 queued
  } finally {
    process.env.POLARIS_CONCURRENCY = "2";
  }
  pump();
  const done = await w.is(e.id, "review");
  assert.equal(done.runs.length, 2);
  const t2 = task(done.runs[1].id);
  assert.match(t2, /BAT-2 Create a\.txt — done \(new since your last round\)/);
  assert.match(t2, /BAT-3 Create b\.txt — done \(new since your last round\)/);
});

test("round limit: the epic fails with the reason; Run planner refuses after the limit", async () => {
  const w = await workspace("lim");
  const e = (await call("POST", "/api/tickets", w.cookie, { title: "Endless", kind: "epic" })).body;
  for (let n = 1; n <= 8; n++) {
    const id = createRun({ ticketId: e.id, model: "demo", attempt: n, role: "planner" });
    db.prepare("UPDATE runs SET status = 'passed', started_at = ? WHERE id = ?").run(n, id);
  }
  db.prepare("INSERT INTO tickets (id, workspace_id, parent_id, title, status, settled_at) VALUES ('lim-child', ?, ?, 'c', 'done', ?)").run(e.workspace_id, e.id, Date.now());
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(e.id);
  wake(e.id);
  const d = await w.get(e.id);
  assert.equal(d.status, "failed");
  assert.match(d.handoff, /Planner round limit reached \(8 rounds\)/);
  const r = await call("POST", `/api/tickets/${e.id}/runs`, w.cookie);
  assert.deepEqual([r.status, r.body.error], [409, "This epic has used all 8 planner rounds."]);
});

test("auto-approve: passing children are merged without clicks and the epic reaches review", async () => {
  const w = await workspace("aut", true);
  assert.equal((await call("GET", "/api/settings", w.cookie)).body.auto_approve_children, 1);
  const e = await w.epic("Two files");
  const d = await w.is(e.id, "review");
  assert.deepEqual(d.children.map((c: any) => c.status), ["done", "done"]);
  for (const c of d.children) assert.equal(events((await w.get(c.id)).runs[0].id).at(-1)!.p.decision, "approved");
  assert.deepEqual([sh(w.repo, "git show main:a.txt"), sh(w.repo, "git show main:b.txt")], ["a", "b"]);
  assert.equal((await call("POST", `/api/tickets/${e.id}/approve`, w.cookie)).body.status, "done");
});

test("failure path: B fails the gate on every attempt → a round creates a follow-up → the epic completes after it", async () => {
  const w = await workspace("fal", true, { auto_split: false }); // on, B would be split instead (test/split.test.ts)
  const e = await w.epic("Two files", "FAIL-GATE");
  const d = await until("epic review", async () => ((await w.get(e.id)).status === "review" ? w.get(e.id) : false), 60_000);
  const [A, B, F] = d.children;
  assert.deepEqual(d.children.map((c: any) => [c.title, c.status]), [["Create a.txt", "done"], ["Create b.txt", "failed"], ["Follow-up: Create b.txt", "done"]]);
  assert.equal(A.handoff.startsWith("- Results: created a.txt"), true);
  const b = await w.get(B.id);
  assert.deepEqual(b.runs.map((r: any) => r.status), ["failed", "failed", "failed"]);
  assert.match(b.handoff, /^- Results: created b\.txt[\s\S]*\n\nThe run failed: modified protected path tests\/broken\.txt$/);
  assert.equal(events(b.runs[2].id).find((x) => x.type === "handoff")!.p.text, b.handoff);
  assert.equal(events(b.runs[0].id).some((x) => x.type === "handoff"), false); // only when the series ends
  assert.match(d.handoff, /FAL-3 failed and was replaced by a follow-up/);
  const followUpRound = d.runs.find((r: any) => events(r.id).some((x) => x.type === "tool_call" && x.p.input.title === "Follow-up: Create b.txt"));
  assert.match(task(followUpRound.id), /## FAL-3 Create b\.txt — failed \(new since your last round\)[\s\S]*The run failed: modified protected path/);
  assert.equal(F.depends_keys.length, 0);
  assert.equal(sh(w.repo, "git show main:b.txt"), "b");
  assert.equal(sh(w.repo, "git ls-tree -r --name-only main"), "README.md\na.txt\nb.txt");
});

test("a rejected child counts as failed: its dependents are blocked and the planner replaces it", async () => {
  const w = await workspace("rej", false, { wiki: false }); // an ingest run of an approved child would refuse the delete below
  const e = await w.epic("Two files");
  let d = await w.childIs(e.id, "Create a.txt", "review");
  const A = d.children[0];
  await until("round 1 finished", async () => (await w.get(e.id)).runs[0].status === "passed");
  assert.equal((await call("POST", `/api/tickets/${A.id}/reject`, w.cookie, { note: "wrong content" })).body.status, "failed");
  assert.match((await w.get(A.id)).handoff, /\n\nRejected by the reviewer: wrong content\.$/);
  d = await w.childIs(e.id, "Follow-up: Create a.txt", "review");
  assert.deepEqual(d.children.map((c: any) => c.label), ["failed", "blocked (dependency REJ-2 failed)", "in review (passed the gate, waiting to be merged)"]);
  await call("POST", `/api/tickets/${d.children[2].id}/approve`, w.cookie);
  d = await w.is(e.id, "review");
  assert.equal(d.runs.length, 3);
  // Deleting the epic deletes its children and their branches.
  assert.equal((await call("DELETE", `/api/tickets/${e.id}`, w.cookie)).status, 204);
  assert.equal((await call("GET", "/api/tickets", w.cookie)).body.length, 0);
});

test("rounds start when the planner has something to do: 10 children settling one by one stay within the round limit", async () => {
  const w = await workspace("ten");
  const e = (await call("POST", "/api/tickets", w.cookie, { title: "Ten", kind: "epic" })).body;
  let clock = 1000;
  db.prepare("UPDATE runs SET status = 'passed', started_at = ? WHERE id = ?").run(++clock, createRun({ ticketId: e.id, model: "demo", attempt: 1, role: "planner" }));
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(e.id);
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO tickets (id, workspace_id, parent_id, title, status) VALUES (?, ?, ?, ?, 'running')").run(`ten-${i}`, e.workspace_id, e.id, `c${i}`);
  process.env.POLARIS_CONCURRENCY = "0"; // hold the queue: a queued round is finished by hand, as if it called finish_round
  try {
    for (let i = 0; i < 10; i++) {
      db.prepare("UPDATE tickets SET status = ?, settled_at = ? WHERE id = ?").run(i === 4 ? "failed" : "done", ++clock, `ten-${i}`);
      wake(e.id);
      db.prepare("UPDATE runs SET status = 'passed', started_at = ? WHERE ticket_id = ? AND status = 'queued'").run(++clock, e.id);
    }
    const d = await w.get(e.id);
    // Round 2 for the failed child, round 3 once nothing is open; a done child with siblings still open starts none.
    assert.deepEqual([d.status, d.runs.map((r: any) => r.attempt)], ["running", [1, 2, 3]]);
  } finally {
    process.env.POLARIS_CONCURRENCY = "2";
    db.prepare("DELETE FROM tickets WHERE workspace_id = ?").run(e.workspace_id);
  }
});

const idle = (ws: string) =>
  until("no run in flight", async () => !db.prepare("SELECT 1 FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.status IN ('queued', 'running')").get(ws));

test("deleting a child: its dependents are blocked and its epic's planner replans or completes; eval cases of children block deleting the epic", async () => {
  const w = await workspace("del", false, { wiki: false, test_command: "true" });
  const e = await w.epic("Two files");
  let d = await w.childIs(e.id, "Create a.txt", "review");
  await until("round 1 finished", async () => (await w.get(e.id)).runs[0].status === "passed");
  const [A, B] = d.children;
  assert.equal((await call("DELETE", `/api/tickets/${A.id}`, w.cookie)).status, 204);
  d = await w.is(e.id, "review");
  assert.deepEqual(d.children.map((c: any) => [c.key, c.label]), [[B.key, "blocked (dependency deleted)"]]);
  assert.equal(d.runs.length, 2);
  db.prepare("INSERT INTO eval_cases (id, workspace_id, ticket_id, title, spec, repo_path, base_sha, setup_command, test_command, protected_paths, image) VALUES ('del-case', ?, ?, 'b', '', '', '', '', '', '', '')").run(e.workspace_id, B.id);
  const r = await call("DELETE", `/api/tickets/${e.id}`, w.cookie);
  assert.deepEqual([r.status, /eval case/.test(r.body.error)], [409, true]);
  db.prepare("DELETE FROM eval_cases WHERE id = 'del-case'").run();
  assert.equal((await call("DELETE", `/api/tickets/${e.id}`, w.cookie)).status, 204);
});

test("a task moved into a running epic is queued at once; into a todo epic, when its first round starts", async () => {
  const w = await workspace("mov", false, { wiki: false, test_command: "true" });
  const e = await w.epic("Two files");
  await w.childIs(e.id, "Create a.txt", "review");
  await until("round 1 finished", async () => (await w.get(e.id)).runs[0].status === "passed");
  const task = async (title: string) => (await call("POST", "/api/tickets", w.cookie, { title, spec: `${title}.` })).body;
  const c = await task("Create c.txt");
  assert.equal((await call("PATCH", `/api/tickets/${c.id}`, w.cookie, { parent_id: e.id })).status, 200);
  assert.equal((await w.is(c.id, "review")).runs.length, 1);
  const later = (await call("POST", "/api/tickets", w.cookie, { title: "Later", kind: "epic" })).body;
  const x = await task("Create x.txt");
  assert.equal((await call("PATCH", `/api/tickets/${x.id}`, w.cookie, { parent_id: later.id })).status, 200);
  const before = await w.get(x.id);
  assert.deepEqual([before.status, before.runs.length], ["todo", 0]);
  assert.equal((await call("POST", `/api/tickets/${later.id}/runs`, w.cookie)).status, 201);
  await w.is(x.id, "review");
  await idle(e.workspace_id);
  for (const id of [e.id, later.id]) assert.equal((await call("DELETE", `/api/tickets/${id}`, w.cookie)).status, 204);
});

test("create_ticket: children inherit the epic's test command, nothing is created after the round ended, wiki runs are not a child's runs", async () => {
  const w = await workspace("inh");
  const e = (await call("POST", "/api/tickets", w.cookie, { title: "E", kind: "epic", test_command: "test -f e.txt" })).body;
  const outcome: { notes?: string; summary?: string } = {};
  const use = (name: string, input: Record<string, unknown>) =>
    runTool(plannerTools(e, outcome, 0, async () => undefined), { type: "tool_use", id: "x", name, input }, { root: w.repo, exec: hostExec });
  assert.equal((await use("create_ticket", { title: "Own", spec: "s", test_command: "test -f own.txt" })).content, "Created INH-2 (queued).");
  assert.equal((await use("create_ticket", { title: "Inherited", spec: "s" })).content, "Created INH-3 (queued).");
  const kids = (await w.get(e.id)).children;
  assert.deepEqual(kids.map((k: any) => k.test_command), ["test -f own.txt", "test -f e.txt"]);

  // An approved child's wiki ingest run hangs off it, but is not its latest run.
  db.prepare("UPDATE tickets SET status = 'done' WHERE parent_id = ?").run(e.id);
  db.prepare("UPDATE runs SET status = 'passed' WHERE id = ?").run(createRun({ ticketId: kids[0].id, model: "demo" }));
  createRun({ ticketId: kids[0].id, model: "wiki-model", role: "wiki" });
  assert.match((await use("list_children", {})).content, /## INH-2 Own — done\nKind: task · test command: `test -f own\.txt` · latest run: #1 passed, demo, 0 tokens/);

  // complete_epic and create_ticket in one turn: the epic is complete, so the child is refused.
  assert.equal((await use("complete_epic", { summary: "done" })).is_error, false);
  assert.match((await use("create_ticket", { title: "Late", spec: "s" })).content, /^InvalidArguments: this round has ended/);
  assert.equal((await w.get(e.id)).children.length, 2);
  db.prepare("DELETE FROM tickets WHERE workspace_id = ?").run(e.workspace_id);
});

test("a crashed planner round is retried once with a fresh round; a second crash in a row fails the epic", async () => {
  const w = await workspace("cra", true, { wiki: false, test_command: "true" });
  const ws = (db.prepare("SELECT id FROM organization WHERE slug = 'cra'").get() as { id: string }).id;
  db.prepare("INSERT INTO providers (id, workspace_id, name, kind, auth_type) VALUES ('cra-broken', ?, 'Broken', 'anthropic', 'api_key')").run(ws); // no key: every round throws
  const epic = async (title: string) => (await call("POST", "/api/tickets", w.cookie, { title, spec: "PARALLEL", kind: "epic", provider_id: "cra-broken", model: "m" })).body;

  const e = await epic("Crashes");
  assert.equal((await call("POST", `/api/tickets/${e.id}/runs`, w.cookie)).status, 201);
  const d = await w.is(e.id, "failed");
  assert.deepEqual(d.runs.map((r: any) => [r.attempt, r.status]), [[1, "failed"], [2, "failed"]]);
  for (const r of d.runs) assert.ok(events(r.id).some((x) => x.type === "error" && /has no API key/.test(x.p.message)), r.id);
  assert.match(d.handoff, /^A planner round failed twice in a row: ProviderError: provider "Broken" has no API key/);

  // One crash: the retry goes on (here the provider works again by then).
  const f = await epic("Crashes once");
  process.env.POLARIS_CONCURRENCY = "0";
  const r1 = (await call("POST", `/api/tickets/${f.id}/runs`, w.cookie)).body;
  subscribe(r1.id, (x) => {
    if (x.type !== "run_finished") return;
    db.prepare("UPDATE runs SET provider_id = NULL, model = 'demo' WHERE id = ?").run(r1.id);
    db.prepare("UPDATE tickets SET provider_id = NULL, model = 'demo' WHERE id = ?").run(f.id); // its children inherit the choice
  });
  process.env.POLARIS_CONCURRENCY = "2";
  pump();
  const g = await w.is(f.id, "review");
  assert.deepEqual(g.runs.map((r: any) => [r.attempt, r.status]), [[1, "failed"], [2, "passed"], [3, "passed"]]);
  assert.ok(events(r1.id).some((x) => x.type === "error" && /retrying with a fresh round/.test(x.p.message)));
  await idle(ws);
});

test("other workspaces cannot see or act on an epic, its children or its planner rounds", async () => {
  const { epic, rounds } = pam;
  const d = (await call("GET", `/api/tickets/${epic.id}`, pam.cookie)).body;
  for (const [m, p] of [["GET", ""], ["POST", "/runs"], ["POST", "/approve"], ["POST", "/reject"], ["DELETE", ""]])
    assert.equal((await call(m, `/api/tickets/${epic.id}${p}`, bob)).status, 404, `${m} ${p}`);
  assert.equal((await call("GET", `/api/tickets/${d.children[0].id}`, bob)).status, 404);
  for (const id of rounds) {
    assert.equal((await call("GET", `/api/runs/${id}`, bob)).status, 404);
    assert.equal((await call("GET", `/api/runs/${id}/events`, bob)).status, 404);
  }
  assert.equal((await call("GET", "/api/tickets", bob)).body.length, 0);
});

test("every worktree and branch is cleaned up", async () => {
  await until("no run in flight", async () => !db.prepare("SELECT 1 FROM runs WHERE status IN ('queued', 'running')").get());
  for (const repo of repos) {
    assert.equal(sh(repo, "git worktree list").split("\n").length, 1, repo);
    assert.equal(sh(repo, "git for-each-ref refs/heads/polaris"), "", repo);
  }
  assert.deepEqual(readdirSync(join(process.env.POLARIS_DATA_DIR!, "worktrees")), []);
});
