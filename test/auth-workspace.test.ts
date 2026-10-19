import { test } from "node:test";
import assert from "node:assert/strict";
import { call, db, signUp } from "./helpers.ts";

async function userWithWorkspace(name: string) {
  const { cookie } = await signUp(name);
  assert.equal((await call("GET", "/api/tickets", cookie)).status, 409, "no workspace yet");
  const created = await call("POST", "/api/auth/organization/create", cookie, { name, slug: name });
  assert.equal(created.status, 200);
  return { cookie: created.cookie, workspaceId: created.body.id as string };
}

test("api requires a session", async () => {
  assert.equal((await call("GET", "/api/tickets")).status, 401);
});

test("tickets are scoped to the active workspace", async () => {
  const a = await userWithWorkspace("alice");
  const b = await userWithWorkspace("bob");
  db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES ('t1', ?, 'only alice sees this')").run(a.workspaceId);

  const seen = async (u: { cookie: string }) => {
    const r = await call("GET", "/api/tickets", u.cookie);
    assert.equal(r.status, 200);
    return (r.body as { id: string }[]).map((t) => t.id);
  };
  assert.deepEqual(await seen(a), ["t1"]);
  assert.deepEqual(await seen(b), []);

  // A fresh login lands back in the user's workspace.
  const login = await call("POST", "/api/auth/sign-in/email", "", { email: "alice@x.dev", password: "password-123" });
  assert.deepEqual(await seen(login), ["t1"]);
});
