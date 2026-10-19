import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-ticket test command: a ticket may override the workspace test command for its own test gate.
process.env.HARNESS_PROVIDER = "fake"; // the demo worker writes notes.txt on attempt 1
process.env.HARNESS_SANDBOX = "host";
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "ttc-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");

const origin = "http://localhost:5173";
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set || cookie };
}
const { cookie: signed } = await call("POST", "/api/auth/sign-up/email", "", { email: "ttc@x.dev", password: "password-123", name: "ttc" });
const me = (await call("POST", "/api/auth/organization/create", signed, { name: "Ttc", slug: "ttc" })).cookie;

const repo = realpathSync(mkdtempSync(join(tmpdir(), "ttc-repo-")));
writeFileSync(join(repo, "README.md"), "hi\n");
execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
await call("PUT", "/api/settings", me, { repo_path: repo, setup_command: "", test_command: "test -f never.txt" });

test("test_command is stored on create, defaults to null, can be changed and cleared, and is validated", async () => {
  const plain = await call("POST", "/api/tickets", me, { title: "plain" });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.test_command, null);

  const t = await call("POST", "/api/tickets", me, { title: "own gate", test_command: "npm test -- foo" });
  assert.equal(t.status, 201);
  assert.equal(t.body.test_command, "npm test -- foo");
  assert.equal((await call("GET", `/api/tickets/${t.body.id}`, me)).body.test_command, "npm test -- foo");

  const changed = await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: "true" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.test_command, "true");
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { title: "renamed" })).body.test_command, "true"); // untouched when absent
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: "" })).body.test_command, null); // "" clears
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: null })).body.test_command, null);

  for (const bad of [5, "x".repeat(2001)]) assert.equal((await call("POST", "/api/tickets", me, { title: "bad", test_command: bad })).status, 400);
});

test("a ticket's own test_command replaces the workspace one in the test gate", async () => {
  const t = (await call("POST", "/api/tickets", me, { title: "write notes", test_command: "test -f notes.txt" })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, me)).status, 201);
  let status = "";
  for (const end = Date.now() + 60_000; Date.now() < end && status !== "review"; await new Promise((r) => setTimeout(r, 50)))
    status = (await call("GET", `/api/tickets/${t.id}`, me)).body.status;
  assert.equal(status, "review"); // the workspace gate (test -f never.txt) would have failed every attempt
  const gate = db.prepare("SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND e.type = 'test_result'").all(t.id) as { payload: string }[];
  assert.equal(gate.length, 1);
  assert.equal(JSON.parse(gate[0].payload).command, "test -f notes.txt");
});
