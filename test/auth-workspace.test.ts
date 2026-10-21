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
  db.prepare("INSERT INTO projects (id, workspace_id, key, name, repo_path, base_branch) VALUES ('p1', ?, 'ALI', 'alice', '/', 'main')").run(a.workspaceId);
  db.prepare("INSERT INTO tickets (id, workspace_id, project_id, title) VALUES ('t1', ?, 'p1', 'only alice sees this')").run(a.workspaceId);

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

test("API tokens default to 30 days, carry a name, and revoking one in Settings ends it", async () => {
  const { mintToken } = await import("../server/cli/token.ts");
  const a = await userWithWorkspace("tokeny");
  const token = await mintToken("tokeny@x.dev", undefined, "claude-code");
  const bearer = { origin: "http://localhost:5173", authorization: `Bearer ${token}` };
  assert.equal((await call("GET", "/api/tickets", "", undefined, bearer)).status, 200);

  const list = (await call("GET", "/api/me/sessions", a.cookie)).body as { id: string; token: boolean; name: string; current: boolean; expiresAt: string }[];
  const t = list.find((s) => s.token)!;
  assert.equal(t.name, "claude-code");
  assert.ok(Math.abs(new Date(t.expiresAt).getTime() - (Date.now() + 30 * 86_400_000)) < 60_000, "default lifetime is 30 days");
  assert.equal(list.find((s) => s.current)?.token, false, "the browser session is listed and marked current");

  assert.equal((await call("DELETE", `/api/me/sessions/${t.id}`, a.cookie)).status, 200);
  assert.equal((await call("GET", "/api/tickets", "", undefined, bearer)).status, 401);
  assert.equal((await call("DELETE", `/api/me/sessions/${t.id}`, a.cookie)).status, 404);
  const other = await userWithWorkspace("tokeny2");
  const mine = (db.prepare("SELECT id FROM session WHERE userId = (SELECT id FROM user WHERE email = 'tokeny@x.dev') LIMIT 1").get() as { id: string }).id;
  assert.equal((await call("DELETE", `/api/me/sessions/${mine}`, other.cookie)).status, 404, "only your own sessions");
});
