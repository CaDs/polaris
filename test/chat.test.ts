import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.POLARIS_PROVIDER = "fake";
const { configure, fileTicket, call, db, until, user, workspace } = await import("./helpers.ts");
const { contextText } = await import("../server/chat.ts");
const { runAgent } = await import("../server/agent/loop.ts");
const { fakeProvider } = await import("../server/agent/providers/fake.ts");
const { usageSummary } = await import("../server/usage.ts");

const w = await workspace("cat", { test_command: "test -f notes.txt", model_review: false });
const chat = async (id: string) => (await call("GET", `/api/chats/${id}`, w.cookie)).body;
const idle = (id: string, turns = 1) =>
  until("chat turn finished", async () => {
    const c = await chat(id);
    return !c.busy && c.events.filter((e: any) => e.type === "turn_finished").length >= turns && c;
  });

test("a chat turn reads the page's ticket, proposes a ticket, and the member files it", async () => {
  const page = await w.create({ title: "Notes are missing", spec: "Users want a notes.txt file." });
  const started = await call("POST", "/api/chats", w.cookie, { message: "Add a notes file\n\nit should say hello", context: { ticket: page.key }, project_id: w.project.id });
  assert.equal(started.status, 201);
  assert.equal(started.body.title, "Add a notes file");

  const c = await idle(started.body.id);
  assert.deepEqual(c.events.map((e: any) => e.type), [
    "user_message", "assistant_message", "tool_call", "tool_result", "assistant_message", "tool_call", "proposal", "tool_result", "assistant_message", "turn_finished",
  ]);
  assert.deepEqual(c.events[0].payload, { text: "Add a notes file\n\nit should say hello", context: { ticket: page.key } });
  assert.equal(c.events.at(-1).payload.status, "passed");
  const sent = JSON.parse((db.prepare("SELECT messages FROM chats WHERE id = ?").get(started.body.id) as { messages: string }).messages)[0].content[0].text;
  assert.match(sent, new RegExp(`^# Environment[\\s\\S]*# Context\\n\\nThe user is looking at this ticket:\\n\\n## ${page.key} Notes are missing[\\s\\S]*# Message\\n\\nAdd a notes file\\n\\nit should say hello$`));
  assert.equal(c.proposals.length, 1);
  const [p] = c.proposals;
  assert.equal(p.number, 1);
  assert.equal(p.status, "open");
  assert.equal(p.payload.title, "it should say hello");

  // Filing validates like New ticket; the card may have been edited.
  assert.equal((await call("POST", `/api/chats/proposals/${p.id}/file`, w.cookie, { title: "" })).status, 400);
  const filed = await call("POST", `/api/chats/proposals/${p.id}/file`, w.cookie, { ...p.payload, title: "Write notes.txt", run: true });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.title, "Write notes.txt");
  assert.equal(filed.body.project_id, w.project.id); // filed in the chat's project
  assert.match(filed.body.spec, /it should say hello[\s\S]*From chat: Add a notes file$/);
  assert.equal(filed.body.estimate, 2);
  assert.equal((await call("POST", `/api/chats/proposals/${p.id}/file`, w.cookie, p.payload)).status, 409);
  assert.equal((await call("POST", `/api/chats/proposals/${p.id}/dismiss`, w.cookie)).status, 409);
  await w.is(filed.body.id, "review"); // run: true queued it
  const after = await chat(started.body.id);
  assert.equal(after.proposals[0].status, "filed");
  assert.equal(after.proposals[0].ticket_key, filed.body.key);
  assert.equal(after.proposals[0].payload.title, "Write notes.txt"); // the card shows what was filed

  // A second message resumes the same conversation and can replace an open proposal.
  assert.equal((await call("POST", `/api/chats/${started.body.id}/messages`, w.cookie, { message: "One more" })).status, 202);
  assert.equal((await call("POST", `/api/chats/${started.body.id}/messages`, w.cookie, { message: "too soon" })).status, 409);
  await idle(started.body.id, 2);
  assert.equal((await call("POST", `/api/chats/${started.body.id}/messages`, w.cookie, { message: "Smaller please REPLACE-P2" })).status, 202);
  const third = await idle(started.body.id, 3);
  assert.deepEqual(third.proposals.map((x: any) => [x.number, x.status]), [[1, "filed"], [2, "superseded"], [3, "open"]]);
  assert.equal((await call("POST", `/api/chats/proposals/${third.proposals[2].id}/dismiss`, w.cookie)).status, 200);

  assert.ok(usageSummary(w.ws).purposes.some((u: any) => u.purpose === "chat" && u.background === 1));
  assert.deepEqual((await call("GET", "/api/chats", w.cookie)).body.map((x: any) => [x.id, x.project_key]), [[started.body.id, "CAT"]]);
});

test("chats are private to their member and belong to a project of the workspace", async () => {
  const c = (await call("POST", "/api/chats", w.cookie, { message: "NO-PROPOSAL what is this repo?", project_id: w.project.id })).body;
  await idle(c.id);
  const other = await user("dog");
  const theirs = await workspace("dob");
  for (const project_id of [undefined, "nope", theirs.project.id])
    assert.match((await call("POST", "/api/chats", w.cookie, { message: "hi", project_id })).body.error, /project_id/);
  for (const [m, path] of [["GET", `/api/chats/${c.id}`], ["POST", `/api/chats/${c.id}/messages`], ["DELETE", `/api/chats/${c.id}`], ["GET", `/api/chats/${c.id}/stream`]])
    assert.equal((await call(m, path, other, m === "POST" ? { message: "hi" } : undefined)).status, 404, `${m} ${path}`);
  assert.equal((await call("GET", "/api/chats", other)).body.length, 0);
  assert.equal((await call("POST", "/api/chats", w.cookie, { message: " ", project_id: w.project.id })).status, 400);
  assert.equal((await call("DELETE", `/api/chats/${c.id}`, w.cookie)).status, 204);
  assert.equal((await call("GET", `/api/chats/${c.id}`, w.cookie)).status, 404);
});

test("context: the page's ticket and @-mentions, scoped to the workspace", async () => {
  const a = await w.create({ title: "Alpha", spec: "alpha spec" });
  const b = await w.create({ title: "Beta", spec: "beta spec" });
  const chat = { id: "c", workspace_id: w.ws, project_id: w.project.id, user_id: "u", title: "", messages: "[]" };
  const text = contextText(chat, `compare with @${b.key} and @XYZ-999`, { ticket: a.key });
  assert.match(text, new RegExp(`^# Context\\n\\nThe user is looking at this ticket:\\n\\n## ${a.key} Alpha\\n- Status: todo; kind: task[\\s\\S]*alpha spec`));
  assert.match(text, new RegExp(`Mentioned tickets:\\n\\n## ${b.key} Beta`));
  assert.doesNotMatch(text, /XYZ-999/);
  const other = await (await workspace("eel")).create({ title: "Not yours" });
  assert.equal(contextText(chat, "", { ticket: other.key }), ""); // another workspace's ticket is not resolved
});

test("a resumed turn sends the earlier conversation unchanged (prompt cache)", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-"));
  const fake = fakeProvider([[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]);
  const opts = { provider: fake.provider, model: "m", system: "s", tools: [], root, budget: { maxTurns: 5, maxTokens: 1e6 }, onEvent: () => {} };
  const one = await runAgent({ ...opts, task: "hello" });
  await runAgent({ ...opts, task: "hello", resume: { messages: one.messages, message: "again" } });
  assert.deepEqual(fake.requests[1].messages.slice(0, one.messages.length), one.messages);
  assert.deepEqual(fake.requests[1].messages.at(-1), { role: "user", content: [{ type: "text", text: "again" }] });
});
