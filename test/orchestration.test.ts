import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M3 pipeline without docker: POLARIS_SANDBOX=host runs setup/test/shell commands in the worktree on the host.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "2";
const { configure, fileTicket, projectOf, call, db, events, sh, tempRepo, user, waitFor, wsOf } = await import("./helpers.ts");
const { addWorktree, protectedChanges, removeWorktree } = await import("../server/git.ts");
const { parseProtected } = await import("../server/agent/tools.ts");
const { parseTasks, seedTasks } = await import("../server/cli/seed-tasks.ts");

const ticket = async (cookie: string, title: string, spec = "") => (await fileTicket(cookie, { title, spec })).body;
const branches = (repo: string) => sh(repo, "git for-each-ref --format='%(refname:short)' refs/heads/polaris");

const alice = await user("alice");
const bob = await user("bob");

test("worktree + branch per run, protected-path detection, cleanup", async () => {
  const repo = tempRepo({ "README.md": "hi\n", "tests/a.test.js": "x\n", "src/x.js": "1\n" });
  const wt = join(process.env.POLARIS_DATA_DIR!, "wt-unit");
  const base = await addWorktree(repo, "main", wt, "polaris/T-1-abc");
  assert.equal(base, sh(repo, "git rev-parse main"));
  assert.equal(sh(wt, "git branch --show-current"), "polaris/T-1-abc");

  const prot = parseProtected(" tests/, ./evals ,");
  assert.deepEqual(prot, ["tests", "evals"]);
  writeFileSync(join(wt, "src/x.js"), "2\n");
  writeFileSync(join(wt, "new.txt"), "n\n");
  assert.deepEqual(await protectedChanges(wt, base, prot), []);
  writeFileSync(join(wt, "tests/a.test.js"), "changed\n"); // modified tracked
  mkdirSync(join(wt, "evals"));
  writeFileSync(join(wt, "evals/e.json"), "{}"); // untracked
  assert.deepEqual((await protectedChanges(wt, base, prot)).sort(), ["evals/e.json", "tests/a.test.js"]);
  sh(wt, "git checkout -q -- tests && rm tests/a.test.js"); // deleted
  assert.deepEqual((await protectedChanges(wt, base, prot)).sort(), ["evals/e.json", "tests/a.test.js"]);
  // a "testsuite" dir is not under "tests"
  rmSync(join(wt, "evals"), { recursive: true });
  sh(wt, "git checkout -q -- tests && mkdir testsuite && touch testsuite/x");
  assert.deepEqual(await protectedChanges(wt, base, prot), []);

  await removeWorktree(repo, wt, "polaris/T-1-abc", process.env.POLARIS_DATA_DIR!);
  assert.equal(existsSync(wt), false);
  assert.equal(branches(repo), "");
  assert.doesNotMatch(sh(repo, "git worktree list"), /wt-unit/);
});

test("project repository: validation, defaults, per-workspace; runs need a valid repo", async () => {
  // No project, no repository: a ticket cannot even be filed.
  assert.match((await fileTicket(alice, { title: "needs repo" })).body.error, /project_id is required/);

  // The repository is a project's, not the workspace's.
  const defaults = (await call("GET", "/api/settings", alice)).body;
  assert.deepEqual([defaults.repo_path, defaults.test_command, defaults.max_turns], [undefined, undefined, 120]);

  const empty = realpathSync(mkdtempSync(join(tmpdir(), "empty-")));
  sh(empty, "git init -q");
  const repo = tempRepo();
  for (const [body, error] of [
    [{ repo_path: "relative/path" }, /absolute/],
    [{ repo_path: "/nonexistent/x" }, /not a git repository/],
    [{ repo_path: tmpdir() }, /not a git repository/],
    [{ repo_path: empty }, /no commits/],
    [{ repo_path: repo, base_branch: "nope" }, /"nope" does not exist/],
    [{ repo_path: repo, protected_paths: "../x" }, /relative/],
    [{ repo_path: 5 }, /string/],
  ] as const) {
    const r = await configure(alice, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, error);
  }
  const saved = await configure(alice, { repo_path: repo, setup_command: "", test_command: "test -f ok.txt" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.base_branch, "main"); // defaults to the checked-out branch
  assert.equal(saved.body.setup_command, "");
  assert.equal((await call("GET", `/api/projects/${projectOf(alice)}`, alice)).body.repo_path, repo);
  assert.deepEqual((await call("GET", "/api/projects", bob)).body, []);

  // A project's repository defaults; the repo vanishing later is caught when queueing too.
  const gone = tempRepo();
  const b = (await configure(bob, { repo_path: gone })).body;
  assert.deepEqual([b.setup_command, b.test_command, b.protected_paths, b.image], ["npm ci", "npm test", "tests/,evals/", "polaris-sandbox:1"]);
  rmSync(gone, { recursive: true });
  const bt = await ticket(bob, "repo gone");
  const r = await call("POST", `/api/tickets/${bt.id}/runs`, bob);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Repository settings are invalid/);
});

test("queue: FIFO, at most POLARIS_CONCURRENCY running, queued runs can be cancelled", async () => {
  const carol = await user("carol");
  const repo = tempRepo();
  await configure(carol, { repo_path: repo, setup_command: "", test_command: "test -f notes.txt" });
  const ts: any[] = [];
  for (const n of [1, 2, 3, 4]) ts.push(await ticket(carol, `q${n}`));
  let max = 0;
  const sample = setInterval(() => {
    max = Math.max(max, (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }).n);
  }, 5).unref(); // a failed assertion must not keep the process alive (it hung the suite)
  const runs: any[] = [];
  for (const t of ts) runs.push((await call("POST", `/api/tickets/${t.id}/runs`, carol)).body);
  const status = (id: string) => (call("GET", `/api/runs/${id}`, carol)).then((r) => r.body.status);
  assert.deepEqual(await Promise.all(runs.map((r) => status(r.id))), ["running", "running", "queued", "queued"]);
  assert.equal((await call("GET", "/api/tickets", carol)).body.find((t: any) => t.id === ts[3].id).run_status, "queued");

  assert.equal((await call("POST", `/api/runs/${runs[3].id}/cancel`, carol)).status, 200);
  const cancelled = await waitFor(carol, ts[3].id, "todo");
  assert.equal(cancelled.runs[0].status, "cancelled");
  assert.deepEqual(events(runs[3].id).map((e) => e.type), ["run_finished"]);

  for (const t of ts.slice(0, 3)) await waitFor(carol, t.id, "review");
  clearInterval(sample);
  assert.equal(max, 2);
  // FIFO: the third run started after the first two.
  const started = runs.slice(0, 3).map((r) => (db.prepare("SELECT started_at FROM runs WHERE id = ?").get(r.id) as { started_at: number }).started_at);
  assert.ok(started[2] >= Math.min(started[0], started[1]));
  assert.equal(branches(repo).split("\n").length, 3); // passed runs keep their branch for review
});

// Shared by the retry → approve → reject tests below (alice's repo: test gate `test -f ok.txt`).
let retried: any;

test("gate failure retries with the failure fed back; pass commits on the run branch", async () => {
  const repo = (await call("GET", `/api/projects/${projectOf(alice)}`, alice)).body.repo_path;
  const t = await ticket(alice, "make ok");
  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  const done = await waitFor(alice, t.id, "review");
  assert.deepEqual(done.runs.map((r: any) => [r.attempt, r.status]), [[1, "failed"], [2, "passed"]]);
  const [r1, r2] = done.runs;

  const gate1 = events(r1.id).find((e) => e.type === "test_result")!.p;
  assert.equal(gate1.passed, false);
  assert.equal(gate1.code, 1);
  assert.match(events(r1.id).at(-1)!.p.reason, /`test -f ok.txt` exited with code 1/);
  const task2 = events(r2.id).find((e) => e.type === "run_started")!.p.task;
  assert.match(task2, /Previous attempt failed: `test -f ok.txt` exited with code 1/);
  assert.match(task2, /Read-only paths .*tests, evals/);

  // Failed attempt: worktree and branch gone. Passed: commit with the harness identity on its branch.
  assert.equal(existsSync(r1.worktree), false);
  assert.equal(branches(repo), r2.branch);
  assert.equal(sh(repo, `git log -1 --format='%s|%an <%ae>' ${r2.branch}`), `${t.key}: make ok|polaris <polaris@localhost>`);
  assert.equal(sh(repo, `git rev-parse ${r2.branch}~1`), r2.base_sha);
  assert.deepEqual(sh(repo, `git diff --name-only ${r2.base_sha} ${r2.branch}`).split("\n").sort(), ["notes.txt", "ok.txt"]);
  const commit = events(r2.id).find((e) => e.type === "commit")!.p;
  assert.equal(commit.sha, sh(repo, `git rev-parse ${r2.branch}`));

  const diff = await call("GET", `/api/tickets/${t.id}/diff`, alice);
  assert.equal(diff.status, 200);
  assert.match(diff.body.diff, /\+\+\+ b\/ok\.txt\n@@ -0,0 \+1 @@\n\+ok/);
  retried = { ...t, repo, branch: r2.branch };
});

test("approve merges into the checked-out base branch (refuses a dirty checkout)", async () => {
  const { id, repo, branch, key } = retried;
  writeFileSync(join(repo, "README.md"), "dirty\n");
  const dirty = await call("POST", `/api/tickets/${id}/approve`, alice);
  assert.equal(dirty.status, 409);
  assert.match(dirty.body.error, /uncommitted changes/);
  sh(repo, "git checkout -q -- README.md");

  const ok = await call("POST", `/api/tickets/${id}/approve`, alice);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "done");
  assert.equal(sh(repo, "git log -1 --format=%P main").split(" ").length, 2); // --no-ff merge commit
  assert.match(sh(repo, "git log --format=%s main"), new RegExp(`${key}: make ok`));
  assert.equal(existsSync(join(repo, "ok.txt")), true); // user's checkout updated
  assert.equal(branches(repo), "");
  assert.doesNotMatch(sh(repo, "git worktree list"), new RegExp(branch));
  assert.equal((await call("POST", `/api/tickets/${id}/approve`, alice)).status, 409);
});

test("approve when the base branch is not checked out leaves the user's checkout alone", async () => {
  const dave = await user("dave");
  const repo = tempRepo();
  sh(repo, "git checkout -q -b feature");
  await configure(dave, { repo_path: repo, base_branch: "main", setup_command: "", test_command: "true" });
  const t = await ticket(dave, "elsewhere");
  await call("POST", `/api/tickets/${t.id}/runs`, dave);
  await waitFor(dave, t.id, "review");
  const before = sh(repo, "git rev-parse main");
  assert.equal((await call("POST", `/api/tickets/${t.id}/approve`, dave)).status, 200);
  assert.equal(sh(repo, "git branch --show-current"), "feature");
  assert.equal(existsSync(join(repo, "notes.txt")), false);
  assert.equal(sh(repo, "git status --porcelain"), "");
  assert.equal(sh(repo, "git rev-parse main^1"), before);
  assert.equal(sh(repo, "git show main:notes.txt"), "hello from the demo agent");
  assert.equal(branches(repo), "");
});

test("reject cleans up, returns to todo, and the note reaches the next run's task", async () => {
  const repo = (await call("GET", `/api/projects/${projectOf(alice)}`, alice)).body.repo_path; // main now has ok.txt: attempt 1 passes
  const t = await ticket(alice, "to reject");
  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  const inReview = await waitFor(alice, t.id, "review");
  const run = inReview.runs[0];
  assert.ok(existsSync(run.worktree));

  const r = await call("POST", `/api/tickets/${t.id}/reject`, alice, { note: "use a better file name" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "todo");
  assert.equal(existsSync(run.worktree), false);
  assert.equal(branches(repo), "");
  assert.equal((await call("GET", `/api/tickets/${t.id}/diff`, alice)).status, 404);

  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  const again = await waitFor(alice, t.id, "review");
  const task = events(again.runs[1].id).find((e) => e.type === "run_started")!.p.task;
  assert.match(task, /A reviewer rejected an earlier attempt: use a better file name/);
  assert.equal((await call("DELETE", `/api/tickets/${t.id}`, alice)).status, 204); // delete cleans up too
  assert.equal(branches(repo), "");
});

test("deleting a ticket while its reject note is being reflected on does not crash the server", async () => {
  const { reject } = await import("../server/runs.ts");
  const crashes: unknown[] = [];
  const onCrash = (e: unknown) => crashes.push(e);
  process.on("unhandledRejection", onCrash);
  try {
    const t = await ticket(alice, "reject then delete");
    await call("POST", `/api/tickets/${t.id}/runs`, alice);
    await waitFor(alice, t.id, "review");
    const rejected = reject(t.id, "wrong approach"); // the reflection on the note runs in the background
    db.prepare("DELETE FROM tickets WHERE id = ?").run(t.id); // what DELETE /api/tickets/:id does once it is done
    await rejected;
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(crashes, []);
  } finally {
    process.off("unhandledRejection", onCrash);
  }
});

test("other workspaces cannot see settings, diffs, or approve/reject", async () => {
  const t = await ticket(alice, "private review");
  await call("POST", `/api/tickets/${t.id}/runs`, alice);
  await waitFor(alice, t.id, "review");
  for (const [m, p] of [["GET", "diff"], ["POST", "approve"], ["POST", "reject"]])
    assert.equal((await call(m, `/api/tickets/${t.id}/${p}`, bob)).status, 404, p);
  assert.notEqual((await call("GET", "/api/projects", bob)).body[0].repo_path, (await call("GET", "/api/projects", alice)).body[0].repo_path);
  assert.equal((await call("GET", `/api/tickets/${t.id}`, alice)).body.status, "review");
});

test("seed-tasks: one ticket per unchecked milestone item, idempotent", async () => {
  const md = "# Tasks\n\n## M3 — Orch\n- [x] done thing\n- [ ] open thing\n\n## M4 — Providers\n- [ ] A\n- [ ] B\n\n## Notes\n- [ ] not a milestone\n";
  assert.deepEqual(parseTasks(md), [
    { title: "M3: open thing", spec: "M3 — Orch\n\n- open thing" },
    { title: "M4: A", spec: "M4 — Providers\n\n- A" },
    { title: "M4: B", spec: "M4 — Providers\n\n- B" },
  ]);
  const p = { id: projectOf(bob)!, workspace_id: wsOf("bob") };
  assert.equal(seedTasks(p, md), 3);
  assert.equal(seedTasks(p, md), 0);
  const titles = (await call("GET", "/api/tickets", bob)).body.map((t: any) => t.title);
  assert.ok(["M3: open thing", "M4: A", "M4: B"].every((x) => titles.includes(x)));
});
