import { test } from "node:test";
import assert from "node:assert/strict";

// M14: the planner, wiki and chat phases each run on their own model when one is set (the demo provider takes any model name).
process.env.POLARIS_PROVIDER = "fake";
const { call, db, until, workspace } = await import("./helpers.ts");
const { enqueueWiki } = await import("../server/runs.ts");

const w = await workspace("phases", { test_command: "", model_review: false });
const run = (id: string) => db.prepare("SELECT role, model, status FROM runs WHERE id = ?").get(id) as { role: string; model: string; status: string };
const done = (id: string) => until("run finished", () => !["queued", "running"].includes(run(id).status));

test("planner, wiki and chat model settings: saved, validated, and used by their phase", async () => {
  assert.equal((await call("GET", "/api/settings", w.cookie)).body.planner_model, null);
  assert.equal((await call("PUT", "/api/settings/planner-provider", w.cookie, { provider_id: "nope" })).status, 400);
  for (const p of ["planner", "wiki", "chat"]) {
    const saved = await call("PUT", `/api/settings/${p}-provider`, w.cookie, { model: `${p}-small` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body[`${p}_model`], `${p}-small`);
  }

  // An epic's planner round uses the planner model; a task still uses the default (the env's demo here).
  const epic = await w.create({ title: "Big thing", kind: "epic" });
  const planned = (await call("POST", `/api/tickets/${epic.id}/runs`, w.cookie)).body;
  assert.deepEqual([run(planned.id).role, run(planned.id).model], ["planner", "planner-small"]);
  await call("POST", `/api/runs/${planned.id}/cancel`, w.cookie);
  await done(planned.id);
  const task = await w.create({ title: "Small thing" });
  const worked = (await call("POST", `/api/tickets/${task.id}/runs`, w.cookie)).body;
  assert.equal(run(worked.id).model, "demo");
  await done(worked.id);

  const wiki = await enqueueWiki(w.project.id, "bootstrap");
  assert.ok("runId" in wiki, JSON.stringify(wiki));
  assert.deepEqual([run(wiki.runId).role, run(wiki.runId).model], ["wiki", "wiki-small"]);
  await done(wiki.runId);

  const chat = (await call("POST", "/api/chats", w.cookie, { message: "NO-PROPOSAL hi", project_id: w.project.id })).body;
  await until("chat turn finished", async () => !(await call("GET", `/api/chats/${chat.id}`, w.cookie)).body.busy);
  const models = db.prepare("SELECT DISTINCT model FROM usage_ledger WHERE workspace_id = ? AND purpose = 'chat'").all(w.ws) as { model: string }[];
  assert.deepEqual(models.map((m) => m.model), ["chat-small"]);

  // Back to the fallback.
  assert.equal((await call("PUT", "/api/settings/planner-provider", w.cookie, { provider_id: null, model: null })).body.planner_model, null);
});
