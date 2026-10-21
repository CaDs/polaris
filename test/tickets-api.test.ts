import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.POLARIS_PROVIDER = "fake";
const { configure, fileTicket, app, call, db, events, origin, tempRepo, until, user, waitFor } = await import("./helpers.ts");
const { recoverOrphans } = await import("../server/runs.ts");

const alice = await user("alice");
const bob = await user("bob");

// Runs need a repository: a one-commit repo whose test gate checks the demo agent's notes.txt.
const repo = tempRepo();
assert.equal((await configure(alice, { repo_path: repo, setup_command: "", test_command: "test -f notes.txt", model_review: false })).status, 200);
assert.equal((await configure(bob, { repo_path: tempRepo() })).status, 200);

test("ticket CRUD, validation and per-workspace numbering", async () => {
  const a1 = await fileTicket(alice, { title: "  First  ", spec: "do it" });
  assert.equal(a1.status, 201);
  assert.equal(a1.body.title, "First");
  assert.equal(a1.body.key, "ALI-1");
  const a2 = await fileTicket(alice, { title: "Second" });
  assert.equal(a2.body.key, "ALI-2");
  const b1 = await fileTicket(bob, { title: "Bob's" });
  assert.equal(b1.body.number, 1);

  for (const bad of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: 5 }, { title: "ok", spec: 1 }, { title: "ok", status: "done" }])
    assert.equal((await fileTicket(alice, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal((await call("PATCH", `/api/tickets/${a1.body.id}`, alice, { status: "bogus" })).status, 400);
  assert.equal((await call("PATCH", `/api/tickets/${a1.body.id}`, alice, { title: "" })).status, 400);

  const patched = await call("PATCH", `/api/tickets/${a1.body.id}`, alice, { title: "Renamed", status: "done" });
  assert.equal(patched.body.title, "Renamed");
  assert.equal(patched.body.status, "done");
  assert.equal(patched.body.spec, "do it");

  const list = await call("GET", "/api/tickets", alice);
  assert.deepEqual(list.body.map((t: any) => t.key), ["ALI-1", "ALI-2"]);
  assert.equal(list.body[0].run_status, null);

  assert.equal((await call("DELETE", `/api/tickets/${a2.body.id}`, alice)).status, 204);
  assert.equal((await call("GET", `/api/tickets/${a2.body.id}`, alice)).status, 404);
  // numbers are never reused within the max+1 scheme
  assert.equal((await fileTicket(alice, { title: "Third" })).body.number, 2);
});

test("other workspaces get 404 for tickets and runs", async () => {
  const t = await fileTicket(alice, { title: "private" });
  const run = await call("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(run.status, 201);
  const id = run.body.id;

  for (const [m, p] of [
    ["GET", `/api/tickets/${t.body.id}`], ["PATCH", `/api/tickets/${t.body.id}`], ["DELETE", `/api/tickets/${t.body.id}`],
    ["POST", `/api/tickets/${t.body.id}/runs`], ["GET", `/api/runs/${id}`], ["POST", `/api/runs/${id}/cancel`], ["GET", `/api/runs/${id}/events`],
  ])
    assert.equal((await call(m, p, bob, m === "PATCH" ? { title: "x" } : undefined)).status, 404, `${m} ${p}`);
  assert.equal((await call("GET", `/api/runs/${id}`, alice)).status, 200);
  await waitFor(alice, t.body.id, "review");
});

test("a fake run stores events, moves the ticket to review and matches totals", async () => {
  const t = await fileTicket(alice, { title: "demo" });
  const run = await call("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(run.body.attempt, 1);

  // SSE: replay + live, closes after run_finished
  const sse = await app.request(`/api/runs/${run.body.id}/events`, { headers: { cookie: alice, origin } });
  const text = await sse.text();
  const frames = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const seen = frames.filter((e) => e.type !== "live"); // live output: the model's text as it streamed, never stored
  assert.deepEqual(seen.map((e) => e.seq), seen.map((_, i) => i + 1));
  assert.ok(frames.some((e) => e.type === "live" && e.parts.some((p: any) => p.kind === "text")));
  const types = seen.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ["setup", "setup", "setup"]); // worktree, sandbox (no setup command), context
  assert.deepEqual(types.slice(-5), ["test_result", "commit", "reflection", "run_metrics", "run_finished"]);
  assert.deepEqual(seen.filter((e) => e.type === "tool_call").map((e) => e.payload.name), ["edit_file", "shell", "read_file"]);

  const ticket = await waitFor(alice, t.body.id, "review");
  const r = ticket.runs[0];
  assert.equal(r.status, "passed");
  assert.equal(r.tokens_in, 400);
  assert.equal(r.tokens_out, 80);
  assert.equal(r.tokens_cached, 40);
  assert.equal(r.cost_usd, 0);
  const stored = db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(r.id) as { n: number };
  assert.equal(stored.n, seen.length);
  const listed = (await call("GET", "/api/tickets", alice)).body.find((x: any) => x.id === t.body.id);
  assert.equal(listed.run_status, "passed");
  assert.equal(listed.tokens_out, 80);
  // M12 run metrics: on the ticket's runs and their own route (404 for a run without any).
  assert.deepEqual(r.metrics, {
    turns: 4, tool_calls: 3, tool_errors: 0, repeated_calls: 0, repeated_reads: 0, compactions: 0, first_edit_turn: 1, files_changed: 1, // notes.txt
    turns_pct: 3, minutes: 0, minutes_pct: 0, input: 400, output: 80, cache_read: 40, stuck: null, // 4 of 120 turns; ~2 s of 60 min
  });
  assert.deepEqual((await call("GET", `/api/runs/${r.id}/metrics`, alice)).body, r.metrics);
  db.prepare("INSERT INTO runs (id, ticket_id, model) VALUES ('no-metrics', ?, 'x')").run(t.body.id);
  assert.equal((await call("GET", "/api/runs/no-metrics/metrics", alice)).status, 404);
  db.prepare("DELETE FROM runs WHERE id = 'no-metrics'").run();

  // A manual re-run starts a new series of attempts (retries count up from 1).
  const second = await call("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(second.body.attempt, 1);
  await waitFor(alice, t.body.id, "review");

  // The workspace's metrics per day and model (earlier tests ran demo runs today too).
  const metrics = (await call("GET", "/api/metrics?days=3", alice)).body;
  assert.equal(metrics.days, 3);
  const today = metrics.rows.find((x: any) => x.day === new Date().toISOString().slice(0, 10) && x.model === r.model);
  assert.deepEqual(Object.keys(today), ["day", "model", "runs", "passed", "failed", "cancelled", "measured", "mean_turns_pct", "sum_turns_pct", "stuck", "tool_calls", "tool_errors", "tool_error_rate", "mean_files_changed"]);
  assert.ok(today.runs >= 2 && today.passed >= 2 && today.measured >= 2 && today.tool_calls >= 6, JSON.stringify(today));
  assert.deepEqual([today.stuck, today.tool_error_rate, today.mean_turns_pct, today.sum_turns_pct], [0, today.tool_errors / today.tool_calls, today.sum_turns_pct / today.measured, today.sum_turns_pct]);
});

test("cancelling a slow run ends it as cancelled and returns the ticket to todo", async () => {
  const t = await fileTicket(alice, { title: "slow one", spec: "this is slow" });
  const run = await call("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal((await call("GET", `/api/tickets/${t.body.id}`, alice)).body.status, "running");
  assert.equal((await call("POST", `/api/tickets/${t.body.id}/runs`, alice)).status, 409);
  assert.equal((await call("DELETE", `/api/tickets/${t.body.id}`, alice)).status, 409);
  await until("the run to reach the sleep", () => events(run.body.id).some((e) => e.type === "tool_call"));
  assert.equal((await call("POST", `/api/runs/${run.body.id}/cancel`, alice)).status, 200);
  const ticket = await waitFor(alice, t.body.id, "todo");
  assert.equal(ticket.runs[0].status, "cancelled");
  assert.equal((await call("POST", `/api/runs/${run.body.id}/cancel`, alice)).status, 409);
});

test("startup recovery fails orphaned runs and their tickets", async () => {
  const t = await fileTicket(alice, { title: "orphan" });
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(t.body.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status) VALUES ('orphan-run', ?, 'm', 'running')").run(t.body.id);
  assert.equal(recoverOrphans(), 1);
  const ticket = (await call("GET", `/api/tickets/${t.body.id}`, alice)).body;
  assert.equal(ticket.status, "failed");
  assert.equal(ticket.runs[0].status, "failed");
  const ev = db.prepare("SELECT type, payload FROM events WHERE run_id = 'orphan-run' ORDER BY seq").all() as { type: string; payload: string }[];
  assert.deepEqual(ev.map((e) => e.type), ["error", "run_finished"]);
  assert.match(ev[0].payload, /interrupted by server restart/);
  assert.equal(recoverOrphans(), 0);
});

test("settings accept only a plain docker image reference (it is an argument of docker run)", async () => {
  const dan = await user("dan");
  for (const image of ["--privileged", "-v/:/host", "ubuntu --privileged", "Ubuntu", "a;b", "x:y:z", "img@sha256:abc"]) {
    const r = await configure(dan, { repo_path: repo, image });
    assert.equal(r.status, 400, image);
    assert.match(r.body.error, /image/i, image);
  }
  for (const image of ["polaris-sandbox:1", "node:22-bookworm", "ghcr.io/org/img:v1.2", `localhost:5000/team/img@sha256:${"a".repeat(64)}`])
    assert.equal((await configure(dan, { repo_path: repo, image })).body.image, image);
});

test("startup recovery: an interrupted attempt is retried with the reason fed back and cleaned up; the last one fails; a finished run's ticket is unstuck", async () => {
  const { addWorktree } = await import("../server/git.ts");
  const orphan = async (attempt: number, title: string) => {
    const t = (await fileTicket(alice, { title })).body;
    const id = `dead-${attempt}-${t.id}`;
    const wt = join(process.env.POLARIS_DATA_DIR!, "worktrees", id);
    await addWorktree(repo, "main", wt, `polaris/${id}`);
    db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(t.id);
    db.prepare("INSERT INTO runs (id, ticket_id, model, status, attempt, worktree, branch) VALUES (?, ?, 'demo', 'running', ?, ?, ?)").run(id, t.id, attempt, wt, `polaris/${id}`);
    return { t, wt, branch: `polaris/${id}` };
  };
  const a = await orphan(1, "interrupted early");
  const last = await orphan(3, "interrupted last");
  const stuck = (await fileTicket(alice, { title: "finished before the restart" })).body;
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(stuck.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status) VALUES (?, ?, 'demo', 'passed')").run(`done-${stuck.id}`, stuck.id);
  const epic = (await fileTicket(alice, { title: "planning", kind: "epic" })).body;
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(epic.id);
  // A planner round is re-run once after a restart (test/resume.test.ts); one that was already a re-run fails its epic.
  db.prepare("INSERT INTO runs (id, ticket_id, model, status, role) VALUES (?, ?, 'demo', 'failed', 'planner')").run(`round0-${epic.id}`, epic.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status, role, resumed_from) VALUES (?, ?, 'demo', 'running', 'planner', ?)").run(`round-${epic.id}`, epic.id, `round0-${epic.id}`);

  assert.equal(recoverOrphans(), 3);
  const failedEpic = (await call("GET", `/api/tickets/${epic.id}`, alice)).body;
  assert.deepEqual([failedEpic.status, failedEpic.handoff], ["failed", "A planner round failed: interrupted by server restart"]);
  assert.equal((await call("GET", `/api/tickets/${stuck.id}`, alice)).body.status, "review");
  assert.equal((await call("GET", `/api/tickets/${last.t.id}`, alice)).body.status, "failed");
  const done = await waitFor(alice, a.t.id, "review");
  assert.deepEqual(done.runs.map((r: any) => [r.attempt, r.status]), [[1, "failed"], [2, "passed"]]);
  const started = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'run_started'").get(done.runs[1].id) as { payload: string };
  assert.match(JSON.parse(started.payload).task, /Previous attempt failed: interrupted by server restart/);
  assert.equal((await call("GET", `/api/tickets/${last.t.id}`, alice)).body.runs.length, 1);
  for (const o of [a, last]) {
    assert.equal(existsSync(o.wt), false);
    assert.equal(execFileSync("git", ["branch", "--list", o.branch], { cwd: repo, encoding: "utf8" }), "");
  }
});

test("manual status changes: only between todo, done and failed (and review back to todo), never while a run is active", async () => {
  const t = (await fileTicket(alice, { title: "by hand" })).body;
  const patch = async (status: string) => {
    const r = await call("PATCH", `/api/tickets/${t.id}`, alice, { status });
    return { status: r.status, body: r.body };
  };
  assert.deepEqual(await patch("running"), { status: 409, body: { error: "invalid_transition", from: "todo", to: "running" } });
  assert.equal((await patch("review")).status, 409);
  assert.equal((await patch("done")).body.status, "done");
  assert.equal((await patch("failed")).body.status, "failed");
  assert.equal((await patch("todo")).body.status, "todo");
  assert.equal((await patch("todo")).status, 200); // unchanged: fine
  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  assert.deepEqual((await patch("todo")).body, { error: "invalid_transition", from: "running", to: "todo" }); // two runs, before
  await waitFor(alice, t.id, "review");
  assert.equal((await patch("done")).status, 409); // done = merged: Approve
  const back = await patch("todo"); // send back
  assert.deepEqual([back.status, back.body.status], [200, "todo"]);
  assert.equal((await call("PATCH", `/api/tickets/${t.id}`, alice, { status: "running", title: "renamed" })).status, 409);
  assert.equal((await call("GET", `/api/tickets/${t.id}`, alice)).body.title, "by hand"); // a refused move changes nothing

  // A child marked done by hand settles like a merged one: its dependent starts.
  const epic = (await fileTicket(alice, { title: "by hand epic", kind: "epic" })).body;
  const a = (await fileTicket(alice, { title: "child a" })).body;
  const b = (await fileTicket(alice, { title: "child b", test_command: "true" })).body;
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(epic.id);
  db.prepare("UPDATE tickets SET parent_id = ?, depends_on = ? WHERE id IN (?, ?)").run(epic.id, "[]", a.id, b.id);
  db.prepare("UPDATE tickets SET depends_on = ? WHERE id = ?").run(JSON.stringify([a.id]), b.id);
  assert.equal((await call("PATCH", `/api/tickets/${a.id}`, alice, { status: "done" })).status, 200);
  assert.equal((await waitFor(alice, b.id, "review")).runs.length, 1);
  // Put back in todo by hand (its dependency is done, its epic running): it is queued again, once.
  assert.equal((await call("PATCH", `/api/tickets/${b.id}`, alice, { status: "todo" })).status, 200);
  assert.equal((await waitFor(alice, b.id, "review")).runs.length, 2);
});
