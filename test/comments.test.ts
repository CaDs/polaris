import { test } from "node:test";
import assert from "node:assert/strict";

// M12: ticket comments, notifications (bell) and the workspace change stream behind the live board.
process.env.POLARIS_PROVIDER = "fake";
const { configure, fileTicket, app, call, db, tempRepo, user, waitFor, wsOf } = await import("./helpers.ts");

const a = await user("ca");
const b = (await call("POST", "/api/auth/sign-up/email", "", { email: "cb@x.dev", password: "password-123", name: "cb" })).cookie;
// b joins a's workspace (the organization plugin's invitation flow is not under test here).
const bId = (db.prepare("SELECT id FROM user WHERE email = 'cb@x.dev'").get() as { id: string }).id;
db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-cb', ?, ?, 'member', ?)").run(wsOf("ca"), bId, new Date().toISOString());
const bIn = (await call("POST", "/api/auth/organization/set-active", b, { organizationId: wsOf("ca") })).cookie || b;
const other = await user("cz");
await configure(a, { repo_path: tempRepo(), setup_command: "" }); // a's project, where fileTicket files

const notifications = (cookie: string) => call("GET", "/api/notifications", cookie).then((r) => r.body as { id: string; kind: string; text: string; key: string; number: number }[]);

test("comments: validated, listed in order with the author, scoped to the workspace", async () => {
  const t = (await fileTicket(a, { title: "talk" })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/comments`, a, { body: "   " })).status, 400);
  assert.equal((await call("POST", `/api/tickets/${t.id}/comments`, a, { body: "x".repeat(5001) })).status, 400);
  const c1 = await call("POST", `/api/tickets/${t.id}/comments`, a, { body: "first\nline two" });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.author, "ca@x.dev");
  await call("POST", `/api/tickets/${t.id}/comments`, bIn, { body: "second" });
  const list = (await call("GET", `/api/tickets/${t.id}/comments`, a)).body;
  assert.deepEqual(list.map((c: any) => [c.author, c.body]), [["ca@x.dev", "first\nline two"], ["cb@x.dev", "second"]]);
  assert.equal((await call("GET", `/api/tickets/${t.id}/comments`, other)).status, 404);
  assert.equal((await call("POST", `/api/tickets/${t.id}/comments`, other, { body: "hi" })).status, 404);
  // Deleting the ticket takes its comments and notifications along.
  await call("DELETE", `/api/tickets/${t.id}`, a);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comments WHERE ticket_id = ?").get(t.id) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ?").get(t.id) as { n: number }).n, 0);
});

test("notifications: a comment reaches the other members but not its author; reading clears them", async () => {
  const t = (await fileTicket(a, { title: "notify me" })).body;
  await call("POST", `/api/tickets/${t.id}/comments`, a, { body: "ping\nsecond line is not in the bell" });
  assert.deepEqual(await notifications(a), []);
  const forB = await notifications(bIn);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].kind, "comment");
  assert.equal(forB[0].text, `ca@x.dev on ${t.key}: ping`);
  assert.equal(forB[0].number, t.number);
  assert.deepEqual(await notifications(other), []);
  await call("POST", `/api/tickets/${t.id}/comments`, bIn, { body: "pong" });
  assert.equal((await notifications(a)).length, 1);
  await call("POST", "/api/notifications/read", bIn, { ids: [forB[0].id] });
  assert.deepEqual(await notifications(bIn), []);
  assert.equal((await notifications(a)).length, 1); // b's read does not touch a's unread (a's is a different row)
  await call("POST", "/api/notifications/read", a, {});
  assert.deepEqual(await notifications(a), []);
});

test("a run that passes notifies 'ready for review'; one that fails says why", async () => {
  await configure(a, { repo_path: tempRepo(), setup_command: "", test_command: "test -f notes.txt", model_review: false, auto_split: false });
  await call("POST", "/api/notifications/read", a, {});
  const ok = (await fileTicket(a, { title: "passes" })).body;
  await call("POST", `/api/tickets/${ok.id}/runs`, a);
  await waitFor(a, ok.id, "review");
  const n = await notifications(a);
  assert.deepEqual(n.map((x) => [x.kind, x.text]), [["review", `${ok.key} is ready for review`]]);
  const bad = (await fileTicket(a, { title: "FAIL-GATE: no notes", spec: "FAIL-GATE" })).body;
  await call("PATCH", `/api/tickets/${bad.id}`, a, { test_command: "false" });
  await call("POST", `/api/tickets/${bad.id}/runs`, a);
  await waitFor(a, bad.id, "failed", 120_000);
  const failed = (await notifications(a)).find((x) => x.kind === "failed");
  assert.ok(failed, "a failed notification");
  assert.match(failed.text, new RegExp(`^${bad.key} failed: `));
});

test("GET /api/events streams a ticket ping when a ticket changes, and a notification ping", async () => {
  const res = await app.request("/api/events", { headers: { cookie: a } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const next = async () => new TextDecoder().decode((await reader.read()).value);
  const t = (await fileTicket(a, { title: "live" })).body;
  const first = await next();
  assert.match(first, /^event: ticket\n/m);
  assert.ok(first.includes(`"id":"${t.id}"`));
  await call("POST", `/api/tickets/${t.id}/comments`, bIn, { body: "hello" });
  let chunk = "";
  while (!chunk.includes("event: notification")) chunk += await next();
  await reader.cancel();
});
