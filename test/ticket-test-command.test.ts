import { test } from "node:test";
import assert from "node:assert/strict";

// Per-ticket test command: a ticket may override the workspace test command for its own test gate.
process.env.POLARIS_PROVIDER = "fake"; // the demo worker writes notes.txt on attempt 1
const { configure, fileTicket, call, db, task, waitFor, workspace } = await import("./helpers.ts");

const { cookie: me } = await workspace("ttc", { test_command: "test -f never.txt" });

test("test_command is stored on create, defaults to null, can be changed and cleared, and is validated", async () => {
  const plain = await fileTicket(me, { title: "plain" });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.test_command, null);

  const t = await fileTicket(me, { title: "own gate", test_command: "npm test -- foo" });
  assert.equal(t.status, 201);
  assert.equal(t.body.test_command, "npm test -- foo");
  assert.equal((await call("GET", `/api/tickets/${t.body.id}`, me)).body.test_command, "npm test -- foo");

  const changed = await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: "true" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.test_command, "true");
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { title: "renamed" })).body.test_command, "true"); // untouched when absent
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: "" })).body.test_command, null); // "" clears
  assert.equal((await call("PATCH", `/api/tickets/${t.body.id}`, me, { test_command: null })).body.test_command, null);

  for (const bad of [5, "x".repeat(2001)]) assert.equal((await fileTicket(me, { title: "bad", test_command: bad })).status, 400);
});

test("a ticket's own test_command replaces the workspace one in the test gate", async () => {
  const t = (await fileTicket(me, { title: "write notes", test_command: "test -f notes.txt" })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, me)).status, 201);
  await waitFor(me, t.id, "review"); // the workspace gate (test -f never.txt) would have failed every attempt
  const gate = db.prepare("SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id WHERE r.ticket_id = ? AND e.type = 'test_result'").all(t.id) as { payload: string }[];
  const run = db.prepare("SELECT id FROM runs WHERE ticket_id = ?").get(t.id) as { id: string };
  assert.match(task(run.id), /\n- Test command: `test -f notes\.txt`\. The harness runs it after you finish/); // the worker is told its own gate
  assert.equal(gate.length, 2); // the in-place gate and the clean run of the commit (POL-4)
  assert.deepEqual(gate.map((g) => JSON.parse(g.payload).command), ["test -f notes.txt", "test -f notes.txt"]);
});
