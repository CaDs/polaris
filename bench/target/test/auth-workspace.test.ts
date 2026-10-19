import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../server/app.ts";
import { db } from "../server/db.ts";

const origin = "http://localhost:5173";

async function call(path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { res, cookie: set || cookie };
}

async function userWithWorkspace(name: string) {
  const { cookie } = await call("/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  assert.equal((await call("/api/tickets", cookie)).res.status, 409, "no workspace yet");
  const created = await call("/api/auth/organization/create", cookie, { name, slug: name });
  assert.equal(created.res.status, 200);
  const org = (await created.res.json()) as { id: string };
  return { cookie: created.cookie, workspaceId: org.id };
}

test("api requires a session", async () => {
  assert.equal((await call("/api/tickets")).res.status, 401);
});

test("tickets are scoped to the active workspace", async () => {
  const a = await userWithWorkspace("alice");
  const b = await userWithWorkspace("bob");
  db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES ('t1', ?, 'only alice sees this')").run(a.workspaceId);

  const seen = async (u: { cookie: string }) => {
    const { res } = await call("/api/tickets", u.cookie);
    assert.equal(res.status, 200);
    return ((await res.json()) as { id: string }[]).map((t) => t.id);
  };
  assert.deepEqual(await seen(a), ["t1"]);
  assert.deepEqual(await seen(b), []);

  // A fresh login lands back in the user's workspace.
  const login = await call("/api/auth/sign-in/email", "", { email: "alice@x.dev", password: "password-123" });
  assert.deepEqual(await seen(login), ["t1"]);
});
