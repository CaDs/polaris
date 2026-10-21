import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

// M11 tracker: labels, ticket fields, filters, search, views, projects (one repo each), cycles, parent epics, priority
// queue, planner.
// POLARIS_SANDBOX=host and the demo provider for the runs; one slot so the queue order is observable.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "1";
const { configure, fileTicket, call, db, project, projectOf, task, tempRepo, until, user, wsOf } = await import("./helpers.ts");
const { hostExec, runTool } = await import("../server/agent/tools.ts");
const { plannerTools } = await import("../server/planner.ts");
const { today } = await import("../server/tracker.ts");

const userId = (name: string) => (db.prepare("SELECT id FROM user WHERE email = ?").get(`${name}@x.dev`) as { id: string }).id;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Each user's workspace starts with one project (alice → ALI), where `ticket` files unless the body names another.
const member = async (name: string) => {
  const cookie = await user(name);
  await project(cookie, name);
  return cookie;
};
const alice = await member("alice");
const bob = await member("bob");
await user("carl", false); // joins alice's workspace below
db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-carl', ?, ?, 'member', ?)").run(wsOf("alice"), userId("carl"), new Date().toISOString());

const post = (cookie: string, path: string, body: unknown) => call("POST", path, cookie, body);
const ticket = async (cookie: string, body: Record<string, unknown>) => {
  const r = await fileTicket(cookie, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const keys = async (cookie: string, query: string) => {
  const r = await call("GET", `/api/tickets?${query}`, cookie);
  assert.equal(r.status, 200, `${query}: ${JSON.stringify(r.body)}`);
  return r.body.map((t: any) => t.key);
};

test("labels: CRUD, case-insensitive unique names, fixed palette, workspace isolation", async () => {
  const bug = await post(alice, "/api/labels", { name: " Bug ", color: "red" });
  assert.equal(bug.status, 201);
  assert.deepEqual([bug.body.name, bug.body.color], ["Bug", "red"]);
  assert.match((await post(alice, "/api/labels", { name: "bug", color: "blue" })).body.error, /already exists/);
  await post(alice, "/api/labels", { name: "Über", color: "teal" });
  assert.equal((await post(alice, "/api/labels", { name: "über", color: "teal" })).status, 400); // Unicode case folding, not just ASCII
  for (const bad of [{ name: "", color: "red" }, { name: "x".repeat(41), color: "red" }, { name: "ok", color: "#ff0000" }, { name: "ok" }])
    assert.equal((await post(alice, "/api/labels", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post(bob, "/api/labels", { name: "Bug", color: "red" })).status, 201); // per workspace

  const ui = (await post(alice, "/api/labels", { name: "UI", color: "blue" })).body;
  assert.equal((await call("PATCH", `/api/labels/${ui.id}`, alice, { name: "BUG" })).status, 400);
  assert.equal((await call("PATCH", `/api/labels/${ui.id}`, alice, { name: "ui", color: "purple" })).body.color, "purple");
  assert.deepEqual((await call("GET", "/api/labels", alice)).body.map((l: any) => l.name), ["Bug", "ui", "Über"]);
  assert.deepEqual((await call("GET", "/api/labels", bob)).body.map((l: any) => l.name), ["Bug"]);
  // Another workspace's label: invisible, unchangeable, unusable.
  assert.equal((await call("PATCH", `/api/labels/${ui.id}`, bob, { name: "x" })).status, 404);
  assert.equal((await call("DELETE", `/api/labels/${ui.id}`, bob)).status, 404);
  assert.match((await fileTicket(bob, { title: "t", label_ids: [ui.id] })).body.error, /no label/);

  const t = await ticket(alice, { title: "labelled", label_ids: [ui.id, bug.body.id, ui.id] });
  assert.deepEqual(t.labels.map((l: any) => [l.name, l.color]), [["Bug", "red"], ["ui", "purple"]]);
  assert.equal((await call("DELETE", `/api/labels/${ui.id}`, alice)).status, 204);
  assert.deepEqual((await call("GET", `/api/tickets/${t.id}`, alice)).body.labels.map((l: any) => l.name), ["Bug"]);
});

test("ticket fields: validation, JSON shape, cross-workspace and cross-project ids rejected", async () => {
  const p = (await call("GET", `/api/projects/${projectOf(alice)}`, alice)).body;
  const p2 = (await post(alice, "/api/projects", { name: "Billing", key: "BIL", repo_path: tempRepo() })).body;
  const ms = (await post(alice, `/api/projects/${p.id}/milestones`, { name: "Beta" })).body.milestones[0];
  const ms2 = (await post(alice, `/api/projects/${p2.id}/milestones`, { name: "Other" })).body.milestones[0];
  const cy = (await post(alice, "/api/cycles", { project_id: p.id, starts_at: day(-400), ends_at: day(-390) })).body;
  const cy2 = (await post(alice, "/api/cycles", { project_id: p2.id, starts_at: day(-400), ends_at: day(-390) })).body;
  const epic2 = await ticket(alice, { title: "billing epic", kind: "epic", project_id: p2.id });
  const [bp, bc, bl] = [
    (await call("GET", `/api/projects/${projectOf(bob)}`, bob)).body, (await post(bob, "/api/cycles", { project_id: projectOf(bob), starts_at: day(-400), ends_at: day(-390) })).body,
    (await call("GET", "/api/labels", bob)).body[0],
  ];

  const t = await ticket(alice, { title: "full", priority: 1, estimate: 5, due_date: "2026-11-01", assignee_id: userId("carl"), milestone_id: ms.id, cycle_id: cy.id });
  assert.deepEqual([t.priority, t.estimate, t.due_date, t.key], [1, 5, "2026-11-01", "ALI-2"]);
  assert.deepEqual(t.project, { id: p.id, name: "alice", key: "ALI" });
  assert.deepEqual(t.milestone, { id: ms.id, name: "Beta" });
  assert.deepEqual(t.cycle, { id: cy.id, number: cy.number, name: "" });
  assert.deepEqual(t.assignee, { id: userId("carl"), name: "carl", email: "carl@x.dev" });
  const plain = await ticket(alice, { title: "plain" });
  assert.deepEqual([plain.priority, plain.estimate, plain.due_date, plain.labels, plain.project.id, plain.assignee], [0, null, null, [], p.id, null]);

  const bad: [Record<string, unknown>, RegExp][] = [
    [{ priority: 5 }, /priority/], [{ priority: "1" }, /priority/], [{ estimate: 4 }, /estimate/], [{ due_date: "2026-02-30" }, /due_date/], [{ due_date: "soon" }, /due_date/],
    [{ assignee_id: userId("bob") }, /not a member/], [{ cycle_id: bc.id }, /no such cycle/], [{ label_ids: [bl.id] }, /no label/], [{ label_ids: "x" }, /label_ids/],
    [{ milestone_id: ms2.id }, /another project/], [{ cycle_id: cy2.id }, /another project/], [{ parent_id: epic2.id }, /another project/],
    [{ project_id: p2.id }, /stays in the project/], [{ project_id: bp.id }, /stays in the project/], [{ project_id: null }, /stays in the project/],
  ];
  for (const [b, re] of bad) {
    const r = await call("PATCH", `/api/tickets/${plain.id}`, alice, b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.body.error, re);
  }
  assert.equal((await call("PATCH", `/api/tickets/${plain.id}`, alice, { project_id: p.id })).status, 200); // naming its own project is fine
  for (const [b, re] of [[{}, /project_id is required/], [{ project_id: bp.id }, /no such project/], [{ project_id: 5 }, /must be an id/]] as const)
    assert.match((await call("POST", "/api/tickets", alice, { title: "x", ...b })).body.error, re);
  assert.match((await fileTicket(bob, { title: "x", milestone_id: ms.id })).body.error, /no such milestone/);

  // A second project numbers its tickets on its own; null clears.
  assert.equal((await ticket(alice, { title: "bill", project_id: p2.id })).key, "BIL-2"); // BIL-1 is the epic
  const u = (await call("PATCH", `/api/tickets/${t.id}`, alice, { assignee_id: null, due_date: null, estimate: null, priority: 0, cycle_id: null, milestone_id: null })).body;
  assert.deepEqual([u.assignee, u.due_date, u.estimate, u.priority, u.cycle, u.milestone], [null, null, null, 0, null, null]);
  assert.equal(u.title, "full"); // untouched fields stay
});

test("filters: every field, AND across fields, OR within one", async () => {
  const w = await member("fil");
  const me = userId("fil");
  const [red, blue] = [(await post(w, "/api/labels", { name: "red", color: "red" })).body.id, (await post(w, "/api/labels", { name: "blue", color: "blue" })).body.id];
  const p = { id: projectOf(w)! };
  const empty = (await post(w, "/api/projects", { name: "Empty", key: "EMP", repo_path: tempRepo() })).body;
  await post(w, `/api/projects/${p.id}/milestones`, { name: "M" });
  const ms = (await call("GET", `/api/projects/${p.id}`, w)).body.milestones[0].id;
  const now = (await post(w, "/api/cycles", { project_id: p.id, starts_at: day(-3), ends_at: day(3) })).body.id;
  const epic = await ticket(w, { title: "Epic", kind: "epic" });
  // FIL-2 … FIL-6
  await ticket(w, { title: "a", priority: 1, label_ids: [red, blue], assignee_id: me, milestone_id: ms, cycle_id: now, due_date: "2026-01-10" });
  await ticket(w, { title: "b", priority: 2, label_ids: [red], due_date: "2026-02-10" });
  await ticket(w, { title: "c", priority: 0, label_ids: [blue], cycle_id: now, parent_id: epic.id });
  const d = await ticket(w, { title: "d", priority: 4, assignee_id: me });
  await ticket(w, { title: "e", priority: 3 });
  await new Promise((r) => setTimeout(r, 5)); // updated_at has ms resolution: no tie with FIL-6
  await call("PATCH", `/api/tickets/${d.id}`, w, { status: "done" });

  assert.deepEqual(await keys(w, "status=done"), ["FIL-5"]);
  assert.deepEqual(await keys(w, "status=done,todo&priority=4,1"), ["FIL-2", "FIL-5"]);
  assert.deepEqual(await keys(w, `label=${red}`), ["FIL-2", "FIL-3"]);
  assert.deepEqual(await keys(w, `label=${red},${blue}`), ["FIL-2", "FIL-3", "FIL-4"]);
  assert.deepEqual(await keys(w, `label=${red},${blue}&label_mode=all`), ["FIL-2"]);
  assert.deepEqual(await keys(w, "priority=0"), ["FIL-1", "FIL-4"]);
  assert.deepEqual(await keys(w, "assignee=me"), ["FIL-2", "FIL-5"]);
  assert.deepEqual(await keys(w, "assignee=none&kind=task"), ["FIL-3", "FIL-4", "FIL-6"]);
  assert.deepEqual(await keys(w, `assignee=${me}&status=todo`), ["FIL-2"]);
  assert.deepEqual(await keys(w, `project=${p.id}&priority=1,3`), ["FIL-2", "FIL-6"]);
  assert.deepEqual(await keys(w, `project=${empty.id}`), []);
  assert.deepEqual(await keys(w, `project=${empty.id},${p.id}&kind=epic`), ["FIL-1"]);
  assert.deepEqual(await keys(w, `milestone=${ms}`), ["FIL-2"]);
  assert.deepEqual(await keys(w, "cycle=current"), ["FIL-2", "FIL-4"]);
  assert.deepEqual(await keys(w, `cycle=${now}&label=${blue}&label_mode=all`), ["FIL-2", "FIL-4"]);
  assert.deepEqual(await keys(w, "kind=epic"), ["FIL-1"]);
  assert.deepEqual(await keys(w, `parent=${epic.id}`), ["FIL-4"]);
  assert.deepEqual(await keys(w, "parent=none&kind=task&priority=1,2"), ["FIL-2", "FIL-3"]);
  assert.deepEqual(await keys(w, "due_before=2026-01-31"), ["FIL-2"]);
  assert.deepEqual(await keys(w, "due_after=2026-01-10&due_before=2026-12-31"), ["FIL-2", "FIL-3"]);
  assert.deepEqual(await keys(w, "layout=list&group=priority"), ["FIL-1", "FIL-2", "FIL-3", "FIL-4", "FIL-5", "FIL-6"]); // UI-only params are ignored
  assert.deepEqual(await keys(alice, `project=${p.id}`), []); // another workspace's id matches nothing

  // Sorts.
  assert.deepEqual(await keys(w, "sort=priority"), ["FIL-2", "FIL-3", "FIL-6", "FIL-5", "FIL-1", "FIL-4"]); // urgent → low, then none
  assert.deepEqual(await keys(w, "sort=due&priority=1,2,4"), ["FIL-2", "FIL-3", "FIL-5"]);
  assert.deepEqual((await keys(w, "sort=created")).slice(0, 2), ["FIL-6", "FIL-5"]);
  assert.equal((await keys(w, "sort=updated"))[0], "FIL-5"); // patched last

  for (const q of ["status=open", "priority=9", "kind=story", "label_mode=some", "due_before=tomorrow", "sort=random"])
    assert.equal((await call("GET", `/api/tickets?${q}`, w)).status, 400, q);
});

test("search: ranked FTS over title + spec, key jump, no FTS syntax injection", async () => {
  const w = await member("sea");
  await ticket(w, { title: "Fix the login page", spec: "users cannot sign in" }); // SEA-1
  await ticket(w, { title: "Dark theme", spec: "the login button is unreadable in dark mode" }); // SEA-2
  await ticket(w, { title: "Logging", spec: "structured logs" }); // SEA-3
  await ticket(w, { title: "Café menu", spec: "naïve résumé" }); // SEA-4
  assert.deepEqual(await keys(w, "q=login"), ["SEA-1", "SEA-2"]); // title match outranks a spec match
  assert.deepEqual(await keys(w, "q=log"), ["SEA-3", "SEA-1", "SEA-2"]); // prefix match; a shorter title ranks first
  assert.deepEqual(await keys(w, "q=dark%20login"), ["SEA-2"]); // every word must match
  assert.deepEqual(await keys(w, "q=cafe%20resume"), ["SEA-4"]); // diacritics folded
  assert.deepEqual(await keys(w, "q=SEA-3"), ["SEA-3"]); // key lookup
  assert.deepEqual(await keys(w, "q=sea-2&status=todo"), ["SEA-2"]);
  assert.deepEqual(await keys(w, "q=2"), ["SEA-2"]);
  assert.deepEqual(await keys(w, "q=login&sort=created"), ["SEA-2", "SEA-1"]); // an explicit sort replaces relevance
  for (const q of ['"', "login OR x", "title:x", "*", "a AND NOT b", "NEAR(a b)", "'"]) assert.equal((await call("GET", `/api/tickets?q=${encodeURIComponent(q)}`, w)).status, 200, q);
  assert.deepEqual(await keys(w, "q=%22dark%22%20login%20-"), ["SEA-2"]); // quotes and operators are not FTS syntax
  // Edits are indexed (triggers), deletes leave the index.
  const t = (await call("GET", "/api/tickets?q=SEA-3", w)).body[0];
  await call("PATCH", `/api/tickets/${t.id}`, w, { title: "Telemetry" });
  assert.deepEqual(await keys(w, "q=telemetry"), ["SEA-3"]);
  await call("DELETE", `/api/tickets/${t.id}`, w);
  assert.deepEqual(await keys(w, "q=telemetry"), []);
  assert.deepEqual(await keys(alice, "q=login"), []); // other workspaces' tickets never match
});

test("saved views: personal or shared, owner-only changes, filters validated", async () => {
  const label = (await call("GET", "/api/labels", alice)).body[0].id;
  const mine = await post(alice, "/api/views", { name: "My bugs", filters: { label, assignee: "me", group: "priority" }, sort: "priority", layout: "list" });
  assert.equal(mine.status, 201);
  assert.deepEqual([mine.body.filters, mine.body.sort, mine.body.layout, mine.body.shared, mine.body.mine], [{ label, assignee: "me", group: "priority" }, "priority", "list", false, true]);
  const shared = (await post(alice, "/api/views", { name: "Team", filters: { status: "review" }, shared: true })).body;
  assert.deepEqual([shared.layout, shared.sort], ["board", "manual"]);
  const carl = (await call("POST", "/api/auth/sign-in/email", "", { email: "carl@x.dev", password: "password-123" })).cookie;
  assert.deepEqual((await call("GET", "/api/views", carl)).body.map((v: any) => [v.name, v.mine, v.owner]), [["Team", false, "alice"]]);
  assert.deepEqual((await call("GET", "/api/views", alice)).body.map((v: any) => v.name), ["My bugs", "Team"]);
  assert.equal((await call("GET", `/api/views/${mine.body.id}`, carl)).status, 404);
  assert.equal((await call("PATCH", `/api/views/${shared.id}`, carl, { name: "x" })).status, 403);
  assert.equal((await call("DELETE", `/api/views/${shared.id}`, carl)).status, 403);
  assert.equal((await call("GET", "/api/views", bob)).body.length, 0);
  assert.equal((await call("PATCH", `/api/views/${shared.id}`, bob, { name: "x" })).status, 404);
  for (const bad of [{ name: "" }, { name: "x", filters: { color: "red" } }, { name: "x", filters: { status: "nope" } }, { name: "x", filters: { q: 1 } }, { name: "x", layout: "grid" }, { name: "x", sort: "z" }, { name: "x", filters: { group: "x" } }])
    assert.equal((await post(alice, "/api/views", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call("PATCH", `/api/views/${mine.body.id}`, alice, { shared: true, layout: "board" })).body.layout, "board");
  assert.equal((await call("GET", "/api/views", carl)).body.length, 2);
  assert.equal((await call("DELETE", `/api/views/${mine.body.id}`, alice)).status, 204);
  assert.equal((await call("GET", "/api/views", alice)).body.length, 1);
});

test("projects: key and repository checked, ordered milestones, progress by status, deleted only when empty", async () => {
  const w = await member("pro"); // project PRO
  const repo = tempRepo();
  const ok = { name: "Launch", key: "lch", repo_path: repo };
  const bad: [Record<string, unknown>, RegExp][] = [
    [{}, /name/], [{ name: "x", repo_path: repo }, /key/], [{ ...ok, key: "L" }, /key/], [{ ...ok, key: "1AB" }, /key/], [{ ...ok, key: "TOOLONG" }, /key/],
    [{ ...ok, key: "pro" }, /already has the key PRO/], [{ ...ok, repo_path: "relative/path" }, /absolute/], [{ ...ok, repo_path: tmpdir() }, /not a git repository/],
    [{ ...ok, base_branch: "nope" }, /Branch "nope" does not exist/], [{ ...ok, image: "Not An Image" }, /docker image/], [{ ...ok, protected_paths: "../x" }, /Protected paths/],
    [{ ...ok, status: "done" }, /status/], [{ ...ok, lead_id: userId("alice") }, /not a member/], [{ ...ok, target_date: "2026-13-01" }, /target_date/],
  ];
  for (const [b, re] of bad) {
    const r = await post(w, "/api/projects", b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.body.error, re, JSON.stringify(b));
  }
  const p = (await post(w, "/api/projects", { ...ok, description: "ship it", status: "started", lead_id: userId("pro"), target_date: "2026-12-01", setup_command: "" })).body;
  assert.deepEqual([p.key, p.status, p.lead.name, p.target_date, p.progress.total], ["LCH", "started", "pro", "2026-12-01", 0]);
  assert.deepEqual([p.repo_path, p.base_branch, p.setup_command, p.test_command, p.image], [repo, "main", "", "npm test", "polaris-sandbox:1"]); // base branch: the repo's current one
  for (const name of ["Alpha", "Beta", "GA"]) await post(w, `/api/projects/${p.id}/milestones`, { name, target_date: null });
  let ms = (await call("GET", `/api/projects/${p.id}`, w)).body.milestones;
  assert.deepEqual(ms.map((m: any) => m.name), ["Alpha", "Beta", "GA"]);
  assert.equal((await call("PUT", `/api/projects/${p.id}/milestones/order`, w, { ids: [ms[0].id] })).status, 400);
  ms = (await call("PUT", `/api/projects/${p.id}/milestones/order`, w, { ids: [ms[2].id, ms[0].id, ms[1].id] })).body.milestones;
  assert.deepEqual(ms.map((m: any) => m.name), ["GA", "Alpha", "Beta"]);
  const [ga, alpha] = ms;

  const a = await ticket(w, { title: "a", project_id: p.id, milestone_id: alpha.id, estimate: 3 });
  const b = await ticket(w, { title: "b", project_id: p.id, milestone_id: alpha.id, estimate: 2 });
  const c = await ticket(w, { title: "c", project_id: p.id, milestone_id: ga.id });
  await ticket(w, { title: "elsewhere" }); // PRO-1: not in this project's progress
  assert.deepEqual([a.key, c.key], ["LCH-1", "LCH-3"]);
  await call("PATCH", `/api/tickets/${a.id}`, w, { status: "done" });
  const got = (await call("GET", `/api/projects/${p.id}`, w)).body;
  assert.deepEqual([got.progress.total, got.progress.done, got.progress.points, got.progress.points_done], [3, 1, 5, 3]);
  assert.deepEqual(got.progress.by_status, { todo: 2, running: 0, review: 0, done: 1, failed: 0 });
  assert.deepEqual(got.milestones.map((m: any) => [m.name, m.progress.done, m.progress.total]), [["GA", 0, 1], ["Alpha", 1, 2], ["Beta", 0, 0]]);

  // Fields, the repository and the key change; a new key renames the project's tickets.
  assert.equal((await call("PATCH", `/api/projects/${p.id}`, w, { status: "completed", lead_id: null })).body.status, "completed");
  assert.match((await call("PATCH", `/api/projects/${p.id}`, w, { repo_path: "/nope" })).body.error, /not a git repository/);
  assert.match((await call("PATCH", `/api/projects/${p.id}`, w, { key: "PRO" })).body.error, /already has the key/);
  assert.equal((await call("PATCH", `/api/projects/${p.id}`, w, { key: "go", test_command: null })).body.test_command, "npm test");
  assert.equal((await call("GET", `/api/tickets/${a.id}`, w)).body.key, "GO-1");
  assert.deepEqual(await keys(w, "q=GO-3"), ["GO-3"]);

  assert.equal((await call("GET", `/api/projects/${p.id}`, bob)).status, 404);
  assert.equal((await call("PATCH", `/api/projects/${p.id}`, bob, { name: "x" })).status, 404);
  assert.equal((await call("DELETE", `/api/milestones/${alpha.id}`, bob)).status, 404);
  assert.equal((await call("DELETE", `/api/milestones/${alpha.id}`, w)).status, 204);
  assert.equal((await call("GET", `/api/tickets/${a.id}`, w)).body.milestone, null);
  assert.match((await call("DELETE", `/api/projects/${p.id}`, w)).body.error, /delete the project's tickets first/);
  for (const t of [a, b, c]) await call("DELETE", `/api/tickets/${t.id}`, w);
  assert.equal((await call("DELETE", `/api/projects/${p.id}`, bob)).status, 404);
  assert.equal((await call("DELETE", `/api/projects/${p.id}`, w)).status, 204);
  assert.equal((await call("GET", `/api/projects/${p.id}`, w)).status, 404);
});

test("cycles: numbering, no overlap, current/upcoming/past, scope change, move unfinished", async () => {
  const w = await member("cyc");
  const pid = projectOf(w)!;
  const cycle = (b: Record<string, unknown>, project_id = pid) => post(w, "/api/cycles", { project_id, ...b });
  const past = (await cycle({ name: "Kickoff", starts_at: day(-20), ends_at: day(-7) })).body;
  const cur = (await cycle({ starts_at: day(-6), ends_at: day(7) })).body;
  const next = (await cycle({ starts_at: day(8), ends_at: day(21) })).body;
  assert.deepEqual([past.number, cur.number, next.number], [1, 2, 3]);
  assert.deepEqual([past.state, cur.state, next.state], ["past", "current", "upcoming"]);
  for (const [b, re] of [[{ starts_at: day(5), ends_at: day(9) }, /overlap cycle 2/], [{ starts_at: day(-30), ends_at: day(-20) }, /overlap cycle 1/], [{ starts_at: day(40), ends_at: day(30) }, /before/], [{ starts_at: "x", ends_at: day(1) }, /starts_at/]] as const)
    assert.match((await cycle(b)).body.error, re);
  assert.match((await post(w, "/api/cycles", { starts_at: day(40), ends_at: day(41) })).body.error, /project_id/);
  assert.match((await call("PATCH", `/api/cycles/${next.id}`, w, { starts_at: day(7) })).body.error, /overlap cycle 2/);
  assert.equal((await call("PATCH", `/api/cycles/${next.id}`, w, { name: "Polish", ends_at: day(22) })).body.name, "Polish");
  assert.equal((await post(bob, "/api/cycles", { project_id: projectOf(bob), starts_at: day(-6), ends_at: day(7) })).status, 201); // other workspace: no clash
  assert.equal((await post(bob, "/api/cycles", { project_id: pid, starts_at: day(40), ends_at: day(41) })).status, 400); // nor its project
  // Another project of the workspace has its own numbering and current cycle.
  const other = (await post(w, "/api/projects", { name: "Other", key: "OTH", repo_path: tempRepo() })).body;
  const theirs = (await cycle({ starts_at: day(-1), ends_at: day(1) }, other.id)).body;
  assert.deepEqual([theirs.number, theirs.state], [1, "current"]);
  assert.equal((await call("GET", `/api/cycles/current?project=${pid}`, w)).body.id, cur.id);
  assert.equal((await call("GET", `/api/cycles/current?project=${other.id}`, w)).body.id, theirs.id);
  assert.equal((await call("GET", "/api/cycles/current", w)).status, 404); // which project's?
  assert.deepEqual((await call("GET", `/api/cycles?project=${other.id}`, w)).body.map((y: any) => y.id), [theirs.id]);
  assert.equal(today(), day(0));

  const t1 = await ticket(w, { title: "planned", cycle_id: past.id });
  const t2 = await ticket(w, { title: "finished", cycle_id: past.id });
  await ticket(w, { title: "in flight", cycle_id: cur.id });
  await call("PATCH", `/api/tickets/${t2.id}`, w, { status: "done" });
  db.prepare("UPDATE tickets SET cycle_added_at = ? WHERE id = ?").run(Date.parse(`${day(-21)}T00:00:00Z`), t1.id); // planned before the cycle started
  let p = (await call("GET", `/api/cycles/${past.id}`, w)).body;
  assert.deepEqual([p.progress.total, p.progress.done, p.added_after_start], [2, 1, 1]);
  await ticket(w, { title: "theirs", project_id: other.id, cycle_id: theirs.id }); // OTH-1
  assert.deepEqual(await keys(w, "cycle=current"), ["OTH-1", "CYC-3"]); // every project's current cycle (manual order: by number)
  assert.deepEqual(await keys(w, `cycle=current&project=${pid}`), ["CYC-3"]);

  assert.match((await post(w, `/api/cycles/${next.id}/move-unfinished`, {})).body.error, /no cycle after cycle 3/);
  const moved = await post(w, `/api/cycles/${past.id}/move-unfinished`, {});
  assert.deepEqual([moved.body.moved, moved.body.to.id], [1, cur.id]);
  assert.deepEqual(await keys(w, `cycle=current&project=${pid}`), ["CYC-1", "CYC-3"]);
  p = (await call("GET", `/api/cycles/${past.id}`, w)).body;
  assert.deepEqual([p.progress.total, p.progress.done], [1, 1]);
  assert.equal((await call("GET", `/api/cycles/${cur.id}`, w)).body.added_after_start, 2);
  assert.equal((await post(bob, `/api/cycles/${past.id}/move-unfinished`, {})).status, 404);
  assert.equal((await call("DELETE", `/api/cycles/${cur.id}`, w)).status, 204);
  assert.equal((await call("GET", `/api/tickets/${t1.id}`, w)).body.cycle, null);
});

test("parent epic set by hand: only a todo task without runs, into an open epic, never stranding the planner", async () => {
  const w = await member("par");
  const e = await ticket(w, { title: "E", kind: "epic" });
  const e2 = await ticket(w, { title: "E2", kind: "epic" });
  const t = await ticket(w, { title: "t", parent_id: e.id });
  assert.equal(t.parent_key, "PAR-1");
  const moved = (await call("PATCH", `/api/tickets/${t.id}`, w, { parent_id: e2.id })).body;
  assert.equal(moved.parent_key, "PAR-2");
  assert.equal((await call("PATCH", `/api/tickets/${t.id}`, w, { parent_id: null })).body.parent_id, null);

  assert.match((await fileTicket(w, { title: "x", kind: "epic", parent_id: e.id })).body.error, /only a todo task/);
  assert.match((await fileTicket(w, { title: "x", parent_id: t.id })).body.error, /no such epic/);
  assert.match((await fileTicket(bob, { title: "x", parent_id: e.id })).body.error, /no such epic/);
  const done = await ticket(w, { title: "x" });
  await call("PATCH", `/api/tickets/${done.id}`, w, { status: "done" });
  assert.match((await call("PATCH", `/api/tickets/${done.id}`, w, { parent_id: e.id })).body.error, /only a todo task/);
  db.prepare("UPDATE tickets SET status = 'review' WHERE id = ?").run(e2.id);
  assert.match((await call("PATCH", `/api/tickets/${t.id}`, w, { parent_id: e2.id })).body.error, /not open/);

  // A sibling depends on it; the last open child of a running epic.
  const a = await ticket(w, { title: "a", parent_id: e.id });
  const b = await ticket(w, { title: "b", parent_id: e.id });
  db.prepare("UPDATE tickets SET depends_on = ? WHERE id = ?").run(JSON.stringify([a.id]), b.id);
  assert.match((await call("PATCH", `/api/tickets/${a.id}`, w, { parent_id: null })).body.error, /depends on this ticket/);
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(e.id);
  db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(a.id);
  assert.match((await call("PATCH", `/api/tickets/${b.id}`, w, { parent_id: null })).body.error, /last open child/);
  const c = await ticket(w, { title: "c", parent_id: e.id }); // attaching to a running epic is fine
  assert.equal((await call("PATCH", `/api/tickets/${b.id}`, w, { parent_id: null })).body.depends_on, "[]"); // c is still open
  for (let i = 0; i < 10; i++) await ticket(w, { title: `k${i}`, parent_id: e.id }); // a, c and these: 12
  assert.match((await fileTicket(w, { title: "13th", parent_id: e.id })).body.error, /already has 12/);
  assert.ok(c);
});

// Polls until the run's ticket settles.
const settled = (cookie: string, ticketId: string) =>
  until("ticket settled", async () => {
    const t = (await call("GET", `/api/tickets/${ticketId}`, cookie)).body;
    return t.status !== "running" && t;
  });

test("run queue: urgent first, then FIFO, no priority last; the worker sees priority, labels, milestone and due date", async () => {
  const w = await user("que");
  await configure(w, { repo_path: tempRepo(), setup_command: "", test_command: "test -f notes.txt", model_review: false, wiki: false });
  const bug = (await post(w, "/api/labels", { name: "bug", color: "red" })).body.id;
  const ms = (await post(w, `/api/projects/${projectOf(w)}/milestones`, { name: "v1" })).body.milestones[0].id;

  const blocker = await ticket(w, { title: "blocker", spec: "this is slow" }); // holds the only slot
  const run = (await post(w, `/api/tickets/${blocker.id}/runs`, {})).body;
  const order = [
    await ticket(w, { title: "none" }), await ticket(w, { title: "low", priority: 4 }), await ticket(w, { title: "urgent", priority: 1, label_ids: [bug], milestone_id: ms, due_date: "2026-11-30" }),
    await ticket(w, { title: "medium", priority: 3 }), await ticket(w, { title: "urgent 2", priority: 1 }),
  ];
  const runs: Record<string, string> = {};
  for (const t of order) runs[t.title] = (await post(w, `/api/tickets/${t.id}/runs`, {})).body.id;
  await post(w, `/api/runs/${run.id}/cancel`, {});
  for (const t of order) await settled(w, t.id);
  const started = Object.entries(runs).map(([title, id]) => [title, (db.prepare("SELECT rowid, started_at FROM runs WHERE id = ?").get(id) as { started_at: number }).started_at] as const);
  assert.deepEqual(started.sort((a, b) => a[1] - b[1]).map(([t]) => t), ["urgent", "urgent 2", "medium", "low", "none"]);

  assert.match(task(runs.urgent), /# Task\n\n# urgent\n\nPriority: Urgent · Labels: bug · Milestone: v1 · Due: 2026-11-30$/);
  assert.match(task(runs.none), /# Task\n\nnone$/); // nothing set: unchanged
});

test("planner create_ticket: labels by name (created when unknown), priority, estimate; children inherit project, milestone, cycle, priority", async () => {
  const w = await member("pln");
  const ws = wsOf("pln");
  await post(w, "/api/labels", { name: "Backend", color: "green" });
  const p = (await post(w, "/api/projects", { name: "Platform", key: "PLT", repo_path: tempRepo() })).body;
  const ms = (await post(w, `/api/projects/${p.id}/milestones`, { name: "M1" })).body.milestones[0].id;
  const cy = (await post(w, "/api/cycles", { project_id: p.id, starts_at: day(-1), ends_at: day(5) })).body;
  const e = await ticket(w, { title: "Epic", kind: "epic", project_id: p.id, milestone_id: ms, cycle_id: cy.id, priority: 2, label_ids: [] });
  const queued: string[] = [];
  const use = (input: Record<string, unknown>) =>
    runTool(plannerTools({ ...e, workspace_id: ws }, {}, 0, async (id) => void queued.push(id)), { type: "tool_use", id: "x", name: "create_ticket", input }, { root: tmpdir(), exec: hostExec });

  assert.equal((await use({ title: "A", spec: "s", labels: ["backend", "Perf"], priority: 1, estimate: 3 })).content, "Created PLT-2 (queued)."); // in the epic's project
  assert.equal((await use({ title: "B", spec: "s" })).content, "Created PLT-3 (queued).");
  const [a, b] = [(await call("GET", `/api/tickets/${queued[0]}`, w)).body, (await call("GET", `/api/tickets/${queued[1]}`, w)).body];
  assert.deepEqual(a.labels.map((l: any) => l.name), ["Backend", "Perf"]); // matched case-insensitively; Perf is new
  assert.deepEqual([a.priority, a.estimate, b.priority, b.estimate], [1, 3, 2, null]);
  for (const t of [a, b]) assert.deepEqual([t.project?.id, t.milestone?.id, t.cycle?.id, t.parent_id], [p.id, ms, cy.id, e.id]);
  assert.equal((await call("GET", `/api/cycles/${cy.id}`, w)).body.added_after_start, 3); // the epic and both children
  assert.equal((await call("GET", "/api/labels", w)).body.length, 2);

  for (const [input, re] of [[{ labels: "bug" }, /"labels" must be an array/], [{ labels: [""] }, /label name/], [{ priority: 7 }, /"priority"/], [{ estimate: 4 }, /"estimate"/]] as const)
    assert.match((await use({ title: "x", spec: "s", ...input })).content, re);
  assert.equal(queued.length, 2);
});

test("projects that build the server's own checkout are found (the --watch startup warning)", async () => {
  const { ownCheckoutProjects } = await import("../server/tracker.ts");
  const p = await project(alice, "Selfie");
  const repo = (db.prepare("SELECT repo_path FROM projects WHERE id = ?").get(p.id) as { repo_path: string }).repo_path;
  assert.deepEqual(ownCheckoutProjects(repo).map((x) => x.key), [p.key]);
  assert.equal(ownCheckoutProjects(`${repo}/..`).length, 0);
});
