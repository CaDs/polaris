import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M9 automatic splitting: escalation of failed tasks into "Split:" epics, per-child test commands, the epic gate, triage.
// POLARIS_SANDBOX=host (no docker), demo provider (SPLIT-ME, SPLIT-CHILD, EPIC-GATE-FAIL).
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host";
process.env.POLARIS_CONCURRENCY = "2";
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "split-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { hostExec, runTool } = await import("../server/agent/tools.ts");
const { plannerTools } = await import("../server/planner.ts");

const origin = "http://localhost:5173";
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();

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
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = await fn();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
const events = (runId: string) =>
  (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));
const task = (runId: string) => events(runId).find((e) => e.type === "run_started")!.p.task as string;
const idle = (ws: string) =>
  until("no run in flight", async () => !db.prepare("SELECT 1 FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.status IN ('queued', 'running')").get(ws));

async function workspace(name: string, settings: Record<string, unknown>) {
  const { cookie: signed } = await call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  const cookie = (await call("POST", "/api/auth/organization/create", signed, { name, slug: name })).cookie;
  const repo = tempRepo();
  assert.equal((await call("PUT", "/api/settings", cookie, { repo_path: repo, setup_command: "", ...settings })).status, 200);
  const get = async (id: string) => (await call("GET", `/api/tickets/${id}`, cookie)).body;
  const byKey = async (key: string) => (await call("GET", "/api/tickets", cookie)).body.find((t: any) => t.key === key);
  const is = (id: string, status: string) => until(`${status}`, async () => ((await get(id)).status === status ? get(id) : false));
  const create = async (body: Record<string, unknown>) => (await call("POST", "/api/tickets", cookie, body)).body;
  return { cookie, repo, get, byKey, is, create };
}

test("settings: auto_split defaults on and round-trips; size hint and triage model are stored and validated", async () => {
  const w = await workspace("set", { test_command: "true" });
  const d = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual([d.auto_split, d.child_size_hint, d.triage_model], [1, "at most 3 files and about 60 changed lines, finishable in 20 agent turns", ""]);
  const base = { repo_path: w.repo, setup_command: "", test_command: "true" };
  const put = async (b: object) => (await call("PUT", "/api/settings", w.cookie, { ...base, ...b })).body;
  await put({ auto_split: false, child_size_hint: " one file ", triage_model: "d1" });
  let s = (await call("GET", "/api/settings", w.cookie)).body;
  assert.deepEqual([s.auto_split, s.child_size_hint, s.triage_model], [0, "one file", "d1"]);
  assert.equal((await put({})).auto_split, 0); // omitted = unchanged
  assert.equal((await put({ auto_split: "on" })).auto_split, 1);
  s = await put({ auto_split: true });
  assert.deepEqual([s.child_size_hint, s.triage_model], ["one file", "d1"]); // omitted = unchanged, like every field
  s = await put({ child_size_hint: null, triage_model: null });
  assert.deepEqual([s.child_size_hint, s.triage_model], ["at most 3 files and about 60 changed lines, finishable in 20 agent turns", ""]); // null = default
  assert.equal((await call("PUT", "/api/settings", w.cookie, { ...base, child_size_hint: "x".repeat(2001) })).status, 400);
  assert.equal((await call("PUT", "/api/settings", w.cookie, { ...base, triage_model: 5 })).status, 400);
});

test("create_ticket test_command: validated like the API, stored on the child, shown to the planner", async () => {
  const w = await workspace("ctc", { test_command: "true" });
  const e = await w.create({ title: "E", kind: "epic" });
  const use = (input: Record<string, unknown>) =>
    runTool(plannerTools(e, {}, 0, async () => undefined), { type: "tool_use", id: "x", name: "create_ticket", input }, { root: w.repo, exec: hostExec });
  assert.match((await use({ title: "t", spec: "s", test_command: 5 })).content, /^InvalidArguments: "test_command" must be a string of at most 2000 chars/);
  assert.match((await use({ title: "t", spec: "s", test_command: "x".repeat(2001) })).content, /"test_command" must be/);
  assert.equal((await use({ title: "Own", spec: "s", test_command: "node --test test/a.test.ts" })).content, "Created CTC-2 (queued).");
  assert.equal((await use({ title: "Empty", spec: "s", test_command: "" })).content, "Created CTC-3 (queued).");
  assert.equal((await use({ title: "Null", spec: "s", test_command: null })).content, "Created CTC-4 (queued).");
  const kids = (await w.get(e.id)).children;
  assert.deepEqual(kids.map((k: any) => k.test_command), ["node --test test/a.test.ts", null, null]);
  const list = (await runTool(plannerTools(e, {}, 0, async () => undefined), { type: "tool_use", id: "y", name: "list_children", input: {} }, { root: w.repo, exec: hostExec })).content;
  assert.match(list, /## CTC-2 Own — todo\nKind: task · test command: `node --test test\/a\.test\.ts` · latest run: none/);
  db.prepare("DELETE FROM tickets WHERE workspace_id = ?").run(e.workspace_id); // nothing here may run
});

test("escalation: a task failing every attempt becomes a Split epic with the failure context; its children carry test_command", async () => {
  // The workspace gate never passes: the ticket's own command is the one its children and the split epic's gate must meet.
  const w = await workspace("esc", { test_command: "false", auto_approve_children: true });
  const t = await w.create({ title: "Big change", spec: "Write both parts. SPLIT-ME", test_command: "test -f part1.txt && test -f part2.txt" });
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, w.cookie)).status, 201);
  const failed = await until("escalated", async () => {
    const x = await w.get(t.id);
    return x.status === "failed" && x.escalated_key && x;
  });
  assert.deepEqual(failed.runs.map((r: any) => r.status), ["failed", "failed", "failed"]);
  const epic = await w.get((await w.byKey(failed.escalated_key)).id);
  assert.deepEqual([epic.kind, epic.title, epic.parent_id, epic.split_from_key, epic.test_command], ["epic", "Split: Big change", null, failed.key, t.test_command]);
  assert.match(epic.spec, /^Write both parts\. SPLIT-ME\n\n## Previous direct attempt\n\nA worker tried this as one ticket and failed/);
  assert.match(epic.spec, /- Attempt 1: failed \(modified protected path tests\/broken\.txt\), 5 turns\n- Attempt 2: .*\n- Attempt 3: failed/);
  assert.match(epic.spec, /Last test gate failure: modified protected path tests\/broken\.txt\n```\n/);
  assert.match(epic.spec, /The worker's final reply:\nWrote notes\.txt, listed the directory and read it back\.$/);

  // The epic's planner ran round 1 at once, with the size hint and its own gate command; the children have their own gates.
  const done = await w.is(epic.id, "review");
  const r1 = done.runs[0];
  assert.deepEqual([r1.role, r1.attempt], ["planner", 1]);
  assert.match(task(r1.id), /- Epic gate: complete_epic first runs `test -f part1\.txt && test -f part2\.txt` on main as it is then/);
  assert.match(task(r1.id), /- Child size: the worker model reliably finishes tickets of this size: at most 3 files and about 60 changed lines, finishable in 20 agent turns; make every child at most that size/);
  assert.deepEqual(done.children.map((c: any) => [c.title, c.test_command, c.status]), [["Create part1.txt", "test -f part1.txt", "done"], ["Create part2.txt", "test -f part2.txt", "done"]]);
  const gates = done.runs.flatMap((r: any) => events(r.id).filter((e) => e.type === "epic_gate").map((e) => [e.p.passed, e.p.command]));
  assert.deepEqual(gates, [[true, "test -f part1.txt && test -f part2.txt"]]);
  assert.deepEqual([sh(w.repo, "git show main:part1.txt"), sh(w.repo, "git show main:part2.txt")], ["part1", "part2"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND title LIKE 'Split:%'").get(epic.workspace_id)!.n, 1);
  await idle(epic.workspace_id);
});

test("escalation of a child: the Split epic is a sibling, dependents wait for it, the parent is not woken for the failure", async () => {
  const w = await workspace("spl", { test_command: "test -f part1.txt && test -f part2.txt", auto_approve_children: true });
  const root = await w.create({ title: "Two files", spec: "SPLIT-CHILD", kind: "epic" });
  assert.equal((await call("POST", `/api/tickets/${root.id}/runs`, w.cookie)).status, 201);
  const at = await until("A split", async () => {
    const d = await w.get(root.id);
    return d.children.find((c: any) => c.title === "Split: Create a.txt") && d;
  });
  const [A, B, S] = at.children;
  assert.deepEqual([A.title, A.status, A.escalated_key, A.label], ["Create a.txt", "failed", S.key, `split into ${S.key} (failed as one ticket)`]);
  assert.deepEqual([S.kind, S.parent_id, S.split_from_key], ["epic", root.id, A.key]);
  assert.deepEqual([B.title, B.depends_keys, B.status], ["Create b.txt", [S.key], "todo"]);
  assert.match(B.label, new RegExp(`^waiting on ${S.key}$`));
  assert.match(A.handoff, /The run failed: modified protected path tests\/broken\.txt/);

  // The sub-epic splits A; once it is done (auto-approved), B runs from main with its work; the root completes.
  const done = await w.is(root.id, "review");
  const kids = new Map(done.children.map((c: any) => [c.title, c]));
  assert.equal((kids.get("Split: Create a.txt") as any).status, "done");
  assert.equal((kids.get("Create b.txt") as any).status, "done");
  assert.deepEqual(done.children.filter((c: any) => c.parent_id === S.id).map((c: any) => c.title), ["Create part1.txt", "Create part2.txt"]);
  const sTask = task((await w.get(S.id)).runs[0].id);
  assert.match(sTask, /sub-epics: not allowed/);
  assert.match(sTask, /- Failed children: not split automatically/);
  const settled = (db.prepare("SELECT settled_at FROM tickets WHERE id = ?").get(S.id) as { settled_at: number }).settled_at;
  assert.ok(done.runs[1].started_at >= settled, "no round started between A failing and its Split epic settling");
  assert.match(task(done.runs[1].id), new RegExp(`## ${A.key} Create a\\.txt — split into ${S.key} \\(failed as one ticket\\)`));
  assert.match(task(done.runs[0].id), /- Failed children: a child task that fails every attempt is split automatically/);
  assert.equal(sh(w.repo, "git ls-tree -r --name-only main"), "README.md\nb.txt\npart1.txt\npart2.txt");
  await idle(root.workspace_id);
});

test("no escalation at the depth limit (a child of a sub-epic) or with auto_split off", async () => {
  const w = await workspace("dep", { test_command: "true" });
  const root = await w.create({ title: "Root", kind: "epic" });
  const make = (epic: any, input: Record<string, unknown>) =>
    runTool(plannerTools(epic, {}, 0, async () => undefined), { type: "tool_use", id: "x", name: "create_ticket", input }, { root: w.repo, exec: hostExec });
  await make(root, { title: "Sub", spec: "s", kind: "epic" });
  const sub = await w.byKey("DEP-2");
  await make(sub, { title: "Create c.txt", spec: "SPLIT-ME" });
  const c = await w.byKey("DEP-3");
  assert.equal((await call("POST", `/api/tickets/${c.id}/runs`, w.cookie)).status, 201);
  const deep = await until("failed", async () => (await w.get(c.id)).status === "failed" && w.get(c.id));
  assert.deepEqual([deep.runs.length, deep.escalated_key], [3, null]);

  await call("PUT", "/api/settings", w.cookie, { repo_path: w.repo, setup_command: "", test_command: "true", auto_split: false });
  const t = await w.create({ title: "Top", spec: "SPLIT-ME" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const off = await until("failed", async () => (await w.get(t.id)).status === "failed" && w.get(t.id));
  assert.deepEqual([off.runs.length, off.escalated_key], [3, null]);
  await idle(root.workspace_id);
  assert.deepEqual((await call("GET", "/api/tickets", w.cookie)).body.map((x: any) => x.title), ["Root", "Sub", "Create c.txt", "Top"]);
});

test("epic gate: a failing workspace test command refuses complete_epic; the planner adds a fix child; then it passes", async () => {
  const w = await workspace("gat", { test_command: "test -f a.txt && test -f fix.txt", auto_approve_children: true });
  const e = await w.create({ title: "Gated", spec: "EPIC-GATE-FAIL", kind: "epic" });
  await call("POST", `/api/tickets/${e.id}/runs`, w.cookie);
  const d = await w.is(e.id, "review");
  assert.deepEqual(d.children.map((c: any) => [c.title, c.test_command, c.status]), [["Create a.txt", "test -f a.txt", "done"], ["Fix: create fix.txt", null, "done"]]);
  const gates = d.runs.flatMap((r: any) => events(r.id).filter((x) => x.type === "epic_gate").map((x) => ({ round: r.attempt, ...x.p })));
  assert.deepEqual(gates.map((g: any) => [g.round, g.passed, g.code]), [[2, false, 1], [3, true, 0]]);
  const refused = events(d.runs[1].id).find((x) => x.type === "tool_result" && x.p.is_error)!.p.content;
  assert.match(refused, /^InvalidArguments: The epic gate failed: `test -f a\.txt && test -f fix\.txt` exited with code 1 on main at [0-9a-f]{8}\. Output \(tail\):/);
  assert.match(refused, /create child tickets that fix this, then call finish_round/);
  assert.equal(events(d.runs[1].id).find((x) => x.type === "round_finished")!.p.completed, false);
  assert.equal(sh(w.repo, "git show main:fix.txt"), "fix");
  await idle(e.workspace_id);
  assert.equal(sh(w.repo, "git worktree list").split("\n").length, 1); // the gate's checkouts are removed

  // No test command: no epic gate.
  const v = await workspace("fre", { test_command: "", auto_approve_children: true });
  const free = await v.create({ title: "Free", spec: "PARALLEL", kind: "epic" });
  await call("POST", `/api/tickets/${free.id}/runs`, v.cookie);
  const f = await v.is(free.id, "review");
  assert.equal(f.runs.some((r: any) => events(r.id).some((x) => x.type === "epic_gate")), false);
  await idle(free.workspace_id);
});

test("triage: score ≥ 3 splits before any run, < 3 runs directly, an error runs directly; only first runs of top-level tasks", async () => {
  const seen: any[] = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method !== "POST" || req.url !== "/v1/systemone") return void res.writeHead(404).end();
    const b = JSON.parse(raw);
    seen.push(b);
    if (b.state.includes("boom")) return void res.writeHead(500).end("model not loaded");
    const score = b.state.includes("huge") ? 3.4 : 0.8;
    res.end(JSON.stringify({ answers: { size: { score, probabilities: { "0": 0.1, "4": score > 3 ? 0.6 : 0 }, confidence: 0.7 } } }));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const w = await workspace("tri", { test_command: "true" });
    const p = (await call("POST", "/api/providers", w.cookie, { name: "Local", kind: "ollama", base_url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/` })).body;
    assert.equal((await call("PUT", "/api/settings/default-provider", w.cookie, { provider_id: p.id, model: "qwen" })).status, 200);
    await call("PUT", "/api/settings", w.cookie, { repo_path: w.repo, setup_command: "", test_command: "true", triage_model: "d1", model_review: false });
    // model "demo" on the ticket: its runs use the demo provider, while triage asks the workspace's default Ollama provider.
    const ticket = (title: string, spec = "") => w.create({ title, spec, model: "demo" });

    const big = await ticket("huge refactor", "Rewrite everything.");
    const r = await call("POST", `/api/tickets/${big.id}/runs`, w.cookie);
    assert.equal(r.status, 201);
    const orig = await w.get(big.id);
    assert.deepEqual([orig.status, orig.runs.length], ["failed", 0]);
    const epic = await w.get((await w.byKey(orig.escalated_key)).id);
    assert.deepEqual([r.body.ticket_id, r.body.role, epic.title, epic.split_from_key, epic.model], [epic.id, "planner", "Split: huge refactor", orig.key, "demo"]);
    assert.match(epic.spec, /^Rewrite everything\.\n\n## Triage\n\nA triage model scored this ticket's size 3\.40 of 4/);
    const first = events(r.body.id)[0];
    assert.deepEqual([first.type, first.p], ["triage", { model: "d1", split: true, score: 3.4, probabilities: { "0": 0.1, "4": 0.6 }, confidence: 0.7 }]);
    assert.deepEqual(seen[0], {
      model: "d1", state: "huge refactor\n\nRewrite everything.",
      questions: { size: { type: "score", instructions: "How large is this software change for an AI coding agent?", criteria: ["Trivial: one small edit", "Small: one or two files", "Medium: a few files, one feature", "Large: many files or several features", "Epic: needs to be split into several tickets"] } },
    });

    const small = await ticket("tiny fix");
    const s = (await call("POST", `/api/tickets/${small.id}/runs`, w.cookie)).body;
    assert.equal(s.ticket_id, small.id);
    assert.deepEqual(events(s.id)[0], { type: "triage", p: { model: "d1", split: false, score: 0.8, probabilities: { "0": 0.1, "4": 0 }, confidence: 0.7 } });
    await w.is(small.id, "review");

    const broken = await ticket("boom");
    const b = (await call("POST", `/api/tickets/${broken.id}/runs`, w.cookie)).body;
    assert.equal(b.ticket_id, broken.id);
    const err = events(b.id)[0];
    assert.equal(err.type, "triage");
    assert.deepEqual([err.p.split, err.p.error], [false, "HTTP 500: model not loaded"]);
    await w.is(broken.id, "review");

    // Not triaged again: a ticket with earlier runs.
    const n = seen.length;
    const again = (await call("POST", `/api/tickets/${small.id}/runs`, w.cookie)).body;
    await idle(big.workspace_id);
    assert.equal(events(again.id).some((e) => e.type === "triage"), false);
    assert.equal(seen.length, n, "children of the split epic were not triaged");
  } finally {
    srv.close();
  }
});

test("escalation: the Split epic copies the ticket's tracker fields; its children inherit them as the planner's do", async () => {
  const w = await workspace("trk", { test_command: "test -f part1.txt && test -f part2.txt", auto_approve_children: true });
  const ws = (db.prepare("SELECT id FROM organization WHERE slug = 'trk'").get() as { id: string }).id;
  const me = (db.prepare("SELECT userId FROM member WHERE organizationId = ?").get(ws) as { userId: string }).userId;
  db.prepare("INSERT INTO labels (id, workspace_id, name, color) VALUES ('l1', ?, 'bug', 'red'), ('l2', ?, 'ui', 'blue')").run(ws, ws);
  db.prepare("INSERT INTO projects (id, workspace_id, name) VALUES ('p1', ?, 'Proj')").run(ws);
  db.prepare("INSERT INTO milestones (id, project_id, name, position) VALUES ('m1', 'p1', 'Beta', 0)").run();
  db.prepare("INSERT INTO cycles (id, workspace_id, number, starts_at, ends_at) VALUES ('c1', ?, 1, '2026-01-01', '2026-12-31')").run(ws);
  const t = await w.create({ title: "Tracked", spec: "SPLIT-ME" });
  db.prepare("INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, 'l1'), (?, 'l2')").run(t.id, t.id);
  db.prepare("UPDATE tickets SET priority = 2, assignee_id = ?, estimate = 5, due_date = '2026-06-30', project_id = 'p1', milestone_id = 'm1', cycle_id = 'c1', cycle_added_at = 123 WHERE id = ?").run(me, t.id);
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, w.cookie)).status, 201);
  const failed = await until("escalated", async () => {
    const x = await w.get(t.id);
    return x.status === "failed" && x.escalated_key && x;
  });
  const epic = await w.get((await w.byKey(failed.escalated_key)).id);
  const fields = (id: string): Record<string, any> => ({
    ...(db.prepare("SELECT priority, assignee_id, estimate, due_date, project_id, milestone_id, cycle_id, cycle_added_at FROM tickets WHERE id = ?").get(id) as Record<string, unknown>),
    labels: (db.prepare("SELECT label_id FROM ticket_labels WHERE ticket_id = ? ORDER BY label_id").all(id) as { label_id: string }[]).map((l) => l.label_id),
  });
  assert.deepEqual(fields(epic.id), { priority: 2, assignee_id: me, estimate: 5, due_date: "2026-06-30", project_id: "p1", milestone_id: "m1", cycle_id: "c1", cycle_added_at: 123, labels: ["l1", "l2"] });
  const done = await w.is(epic.id, "review");
  assert.equal(done.children.length, 2);
  for (const k of done.children) assert.deepEqual([fields(k.id).project_id, fields(k.id).milestone_id, fields(k.id).cycle_id, fields(k.id).priority], ["p1", "m1", "c1", 2]);
  await idle(ws);
});
