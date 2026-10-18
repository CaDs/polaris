import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host"; // docker is covered by docker.test.ts
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "runs-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { recoverOrphans } = await import("../server/runs.ts");

const origin = "http://localhost:5173";

async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { res, cookie: set || cookie };
}
const json = async (method: string, path: string, cookie: string, body?: unknown) => {
  const { res } = await call(method, path, cookie, body);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

async function userWithWorkspace(name: string) {
  const { cookie } = await call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  const created = await call("POST", "/api/auth/organization/create", cookie, { name, slug: name });
  return created.cookie;
}

const alice = await userWithWorkspace("alice");
const bob = await userWithWorkspace("bob");

// Runs need a repository: a one-commit repo whose test gate checks the demo agent's notes.txt.
const repo = mkdtempSync(join(tmpdir(), "repo-"));
writeFileSync(join(repo, "README.md"), "hi\n");
execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
assert.equal((await json("PUT", "/api/settings", alice, { repo_path: repo, setup_command: "", test_command: "test -f notes.txt", model_review: false })).status, 200);

async function waitFor(cookie: string, ticketId: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const t = await json("GET", `/api/tickets/${ticketId}`, cookie);
    if (t.body.status === status) return t.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`ticket never reached ${status}`);
}

test("ticket CRUD, validation and per-workspace numbering", async () => {
  const a1 = await json("POST", "/api/tickets", alice, { title: "  First  ", spec: "do it" });
  assert.equal(a1.status, 201);
  assert.equal(a1.body.title, "First");
  assert.equal(a1.body.key, "ALI-1");
  const a2 = await json("POST", "/api/tickets", alice, { title: "Second" });
  assert.equal(a2.body.key, "ALI-2");
  const b1 = await json("POST", "/api/tickets", bob, { title: "Bob's" });
  assert.equal(b1.body.number, 1);

  for (const bad of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: 5 }, { title: "ok", spec: 1 }, { title: "ok", status: "done" }])
    assert.equal((await json("POST", "/api/tickets", alice, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal((await json("PATCH", `/api/tickets/${a1.body.id}`, alice, { status: "bogus" })).status, 400);
  assert.equal((await json("PATCH", `/api/tickets/${a1.body.id}`, alice, { title: "" })).status, 400);

  const patched = await json("PATCH", `/api/tickets/${a1.body.id}`, alice, { title: "Renamed", status: "done" });
  assert.equal(patched.body.title, "Renamed");
  assert.equal(patched.body.status, "done");
  assert.equal(patched.body.spec, "do it");

  const list = await json("GET", "/api/tickets", alice);
  assert.deepEqual(list.body.map((t: any) => t.key), ["ALI-1", "ALI-2"]);
  assert.equal(list.body[0].run_status, null);

  assert.equal((await json("DELETE", `/api/tickets/${a2.body.id}`, alice)).status, 204);
  assert.equal((await json("GET", `/api/tickets/${a2.body.id}`, alice)).status, 404);
  // numbers are never reused within the max+1 scheme
  assert.equal((await json("POST", "/api/tickets", alice, { title: "Third" })).body.number, 2);
});

test("other workspaces get 404 for tickets and runs", async () => {
  const t = await json("POST", "/api/tickets", alice, { title: "private" });
  const run = await json("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(run.status, 201);
  const id = run.body.id;

  for (const [m, p] of [
    ["GET", `/api/tickets/${t.body.id}`], ["PATCH", `/api/tickets/${t.body.id}`], ["DELETE", `/api/tickets/${t.body.id}`],
    ["POST", `/api/tickets/${t.body.id}/runs`], ["GET", `/api/runs/${id}`], ["POST", `/api/runs/${id}/cancel`], ["GET", `/api/runs/${id}/events`],
  ])
    assert.equal((await call(m, p, bob, m === "PATCH" ? { title: "x" } : undefined)).res.status, 404, `${m} ${p}`);
  assert.equal((await json("GET", `/api/runs/${id}`, alice)).status, 200);
  await waitFor(alice, t.body.id, "review");
});

test("a fake run stores events, moves the ticket to review and matches totals", async () => {
  const t = await json("POST", "/api/tickets", alice, { title: "demo" });
  const run = await json("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(run.body.attempt, 1);

  // SSE: replay + live, closes after run_finished
  const sse = await app.request(`/api/runs/${run.body.id}/events`, { headers: { cookie: alice, origin } });
  const text = await sse.text();
  const seen = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(seen.map((e) => e.seq), seen.map((_, i) => i + 1));
  const types = seen.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ["setup", "setup", "setup"]); // worktree, sandbox (no setup command), context
  assert.deepEqual(types.slice(-4), ["test_result", "commit", "reflection", "run_finished"]);
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
  const listed = (await json("GET", "/api/tickets", alice)).body.find((x: any) => x.id === t.body.id);
  assert.equal(listed.run_status, "passed");
  assert.equal(listed.tokens_out, 80);

  // A manual re-run starts a new series of attempts (retries count up from 1).
  const second = await json("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal(second.body.attempt, 1);
  await waitFor(alice, t.body.id, "review");
});

test("cancelling a slow run ends it as cancelled and returns the ticket to todo", async () => {
  const t = await json("POST", "/api/tickets", alice, { title: "slow one", spec: "this is slow" });
  const run = await json("POST", `/api/tickets/${t.body.id}/runs`, alice);
  assert.equal((await json("GET", `/api/tickets/${t.body.id}`, alice)).body.status, "running");
  assert.equal((await json("POST", `/api/tickets/${t.body.id}/runs`, alice)).status, 409);
  assert.equal((await json("DELETE", `/api/tickets/${t.body.id}`, alice)).status, 409);
  await new Promise((r) => setTimeout(r, 700)); // let it reach the sleep
  assert.equal((await json("POST", `/api/runs/${run.body.id}/cancel`, alice)).status, 200);
  const ticket = await waitFor(alice, t.body.id, "todo");
  assert.equal(ticket.runs[0].status, "cancelled");
  assert.equal((await json("POST", `/api/runs/${run.body.id}/cancel`, alice)).status, 409);
});

test("startup recovery fails orphaned runs and their tickets", async () => {
  const t = await json("POST", "/api/tickets", alice, { title: "orphan" });
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(t.body.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status) VALUES ('orphan-run', ?, 'm', 'running')").run(t.body.id);
  assert.equal(recoverOrphans(), 1);
  const ticket = (await json("GET", `/api/tickets/${t.body.id}`, alice)).body;
  assert.equal(ticket.status, "failed");
  assert.equal(ticket.runs[0].status, "failed");
  const ev = db.prepare("SELECT type, payload FROM events WHERE run_id = 'orphan-run' ORDER BY seq").all() as { type: string; payload: string }[];
  assert.deepEqual(ev.map((e) => e.type), ["error", "run_finished"]);
  assert.match(ev[0].payload, /interrupted by server restart/);
  assert.equal(recoverOrphans(), 0);
});

test("settings accept only a plain docker image reference (it is an argument of docker run)", async () => {
  const dan = await userWithWorkspace("dan");
  for (const image of ["--privileged", "-v/:/host", "ubuntu --privileged", "Ubuntu", "a;b", "x:y:z", "img@sha256:abc"]) {
    const r = await json("PUT", "/api/settings", dan, { repo_path: repo, image });
    assert.equal(r.status, 400, image);
    assert.match(r.body.error, /image/i, image);
  }
  for (const image of ["polaris-sandbox:1", "node:22-bookworm", "ghcr.io/org/img:v1.2", `localhost:5000/team/img@sha256:${"a".repeat(64)}`])
    assert.equal((await json("PUT", "/api/settings", dan, { repo_path: repo, image })).body.image, image);
});
