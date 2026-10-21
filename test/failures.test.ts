import { test } from "node:test";
import assert from "node:assert/strict";

// M12 failure mining: failure classes from run events, GET /api/failures, POST /api/failures/mine. POLARIS_SANDBOX=host.
process.env.POLARIS_PROVIDER = "fake";
const { call, db, workspace } = await import("./helpers.ts");
const { failureClass, mine, MINE_SYSTEM } = await import("../server/failures.ts");
const { createRun, eventLog } = await import("../server/agent/events.ts");
const { fakeProvider } = await import("../server/agent/providers/fake.ts");
const { noUsage } = await import("../server/agent/types.ts");
type AgentEvent = import("../server/agent/types.ts").AgentEvent;

const gate = (protectedPaths: string[] = []) => ({ passed: false, command: "npm test", code: 1, timed_out: false, output: "FAIL test/a.test.ts\nexpected 1, got 2", protected: protectedPaths });

test("failure classes from the run's reason, gate result, stuck stop and review", () => {
  const cases: [string | undefined, string, object, string | null][] = [
    ["stuck: repeat_call (read_file README.md)", "failed", {}, "stuck"],
    ["turn budget exhausted (120)", "failed", {}, "budget_turns"],
    ["token budget exhausted (2000001 >= 2000000)", "failed", {}, "budget_turns"],
    ["time budget exhausted (60 min)", "failed", {}, "budget_time"],
    ["`npm test` exited with code 1", "failed", { gate: gate() }, "gate_tests"],
    ["`npm test` timed out", "failed", {}, "gate_tests"],
    ["modified protected path tests/a.txt", "failed", { gate: gate(["tests/a.txt"]) }, "gate_protected"],
    ["`npm test` exited with code 1; the fix round ended: turn budget exhausted (10)", "failed", {}, "gate_tests"],
    ["`npm test` exited with code 1; the fix round ended: stuck: no_progress (8 turns without a change)", "failed", {}, "stuck"],
    ["`npm test` exited with code 1; the fix round ended: ProviderError: HTTP 529", "failed", {}, "provider_error"],
    ["model review: changes still requested after 3 rounds", "failed", {}, "review_rejected"],
    ["model review requested changes; the fix round ended: time budget exhausted (60 min)", "failed", {}, "review_rejected"],
    ["ProviderError: the model refused (stop_reason refusal)", "failed", {}, "provider_error"],
    ["UnexpectedEnvironment: setup command failed with exit code 1", "failed", {}, "environment"],
    ["interrupted by server restart", "failed", {}, "environment"],
    ["cancelled", "cancelled", {}, "cancelled"],
    ["cancelled while queued", "cancelled", {}, "cancelled"],
    ["Unknown: boom", "failed", {}, "unknown"],
    [undefined, "failed", { gate: gate(["tests/x"]) }, "gate_protected"],
    [undefined, "failed", { gate: gate() }, "gate_tests"],
    [undefined, "failed", { stuck: true }, "stuck"],
    [undefined, "failed", {}, "unknown"],
    [undefined, "passed", { rejected: true }, "human_rejected"],
    [undefined, "passed", {}, null],
  ];
  for (const [reason, status, more, want] of cases) assert.equal(failureClass({ status, reason, ...more }), want, `${status} ${reason}`);
});

// A finished run of the ticket from canned events (no pipeline: classified on read, like a run from before migration 017).
function canned(ticketId: string, reason: string | undefined, extra: AgentEvent[] = [], status: "failed" | "passed" | "cancelled" = "failed", model = "m1") {
  const id = createRun({ ticketId, model });
  const log = eventLog(id);
  for (const e of extra) log(e);
  log({ type: "run_finished", payload: { status, reason, turns: 3, usage: noUsage() } });
  return id;
}
const classOf = (id: string) => (db.prepare("SELECT failure_class FROM runs WHERE id = ?").get(id) as { failure_class: string | null }).failure_class;
const tickets = async (w: Awaited<ReturnType<typeof workspace>>) => (await call("GET", "/api/tickets", w.cookie)).body as any[];

test("the pipeline stores the class when a run ends; a reject marks the passed run human_rejected", async () => {
  const w = await workspace("pia", { test_command: "test -f ok.txt", model_review: false });
  const t = await w.create({ title: "make ok" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const done = await w.is(t.id, "review");
  assert.deepEqual(done.runs.map((r: any) => [r.status, r.failure_class]), [["failed", "gate_tests"], ["passed", null]]);
  await call("POST", `/api/tickets/${t.id}/reject`, w.cookie, { note: "wrong file" });
  assert.equal(classOf(done.runs[1].id), "human_rejected");
  const f = (await call("GET", "/api/failures", w.cookie)).body;
  assert.deepEqual(f.classes.map((c: any) => [c.class, c.runs, c.tickets]), [["gate_tests", 1, 1], ["human_rejected", 1, 1]]);
  assert.equal(f.classes[1].examples[0].reason, "rejected in review: wrong file");
});

test("GET /api/failures: classes by count with ≤3 examples, per-day rows, the window, mined tickets left out", async () => {
  const w = await workspace("fay");
  const [a, b, m] = [await w.create({ title: "A" }), await w.create({ title: "B" }), await w.create({ title: "mined one" })];
  const runs = [1, 2].map(() => canned(a.id, "`npm test` exited with code 1", [{ type: "test_result", payload: gate() }]));
  runs.push(canned(b.id, "`npm test` exited with code 1"), canned(b.id, "`npm test` exited with code 1"));
  const stuck = canned(b.id, "stuck: repeat_call (read_file README.md)", [], "failed", "m2");
  canned(b.id, undefined, [], "passed"); // no failure
  const old = canned(a.id, "time budget exhausted (60 min)");
  db.prepare("UPDATE runs SET ended_at = ? WHERE id = ?").run(Date.now() - 40 * 86_400_000, old);
  const label = (await call("POST", "/api/labels", w.cookie, { name: "Mined", color: "gray" })).body;
  await call("PATCH", `/api/tickets/${m.id}`, w.cookie, { label_ids: [label.id] });
  canned(m.id, "ProviderError: HTTP 500");

  const f = (await call("GET", "/api/failures", w.cookie)).body;
  assert.equal(f.days, 30);
  assert.deepEqual(f.classes.map((c: any) => [c.class, c.runs, c.tickets]), [["gate_tests", 4, 2], ["stuck", 1, 1]]);
  const g = f.classes[0];
  assert.equal(g.description, "the tests failed after the agent finished");
  assert.equal(g.mined, null);
  // Newest first, one per ticket before a second of the same ticket.
  assert.deepEqual(g.examples.map((e: any) => e.ticket_key), [b.key, a.key, b.key]);
  assert.deepEqual(Object.keys(g.examples[0]).sort(), ["model", "reason", "run_id", "ticket_id", "ticket_key", "title"]);
  assert.equal(g.examples[0].reason, "`npm test` exited with code 1");
  assert.equal(f.classes[1].examples[0].model, "m2");
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(f.rows.sort((x: any, y: any) => (x.class < y.class ? -1 : 1)), [{ day: today, class: "gate_tests", runs: 4 }, { day: today, class: "stuck", runs: 1 }]);
  assert.deepEqual([...runs, stuck].map(classOf), ["gate_tests", "gate_tests", "gate_tests", "gate_tests", "stuck"]); // stored on read

  const all = (await call("GET", "/api/failures?days=90", w.cookie)).body;
  assert.deepEqual(all.classes.map((c: any) => c.class), ["gate_tests", "budget_time", "stuck"]); // ties by name
  assert.deepEqual((await call("GET", "/api/failures", (await workspace("other")).cookie)).body.classes, []);
});

// A fake model that answers every mining call by its dossier's class: harness for environment, else a repo ticket.
function miner(calls = 10) {
  const answer = (req: any) => {
    const cls = /<class>(\w+)/.exec(req.messages[0].content[0].text)![1];
    return [{ type: "tool_use" as const, id: "m", name: "submit_mined_ticket", input: cls === "environment"
      ? { verdict: "harness", lesson: "- Retry the setup command once before giving up", confidence: 0.4 }
      : { verdict: "repo", title: `Fix ${cls}`, spec: `Make ${cls} stop: add a test.`, confidence: 0.8 } }];
  };
  return fakeProvider(Array.from({ length: calls }, () => answer));
}

test("mining: one structured call per class with ≥ 2 runs; mined todo tickets with the dossier; harness → a lesson; dedupe", async () => {
  const w = await workspace("max");
  const [a, b] = [await w.create({ title: "A" }), await w.create({ title: "B" })];
  for (const t of [a, b, a]) canned(t.id, "`npm test` exited with code 1", [{ type: "test_result", payload: gate() }]);
  for (const t of [a, b]) canned(t.id, "stuck: repeat_call (read_file README.md)");
  for (const t of [a, b]) canned(t.id, "UnexpectedEnvironment: setup command failed with exit code 1");
  canned(b.id, "time budget exhausted (60 min)");
  for (const t of [a, b]) canned(t.id, "cancelled", [], "cancelled");

  const f = miner();
  const r = await mine({ workspaceId: w.ws, provider: f.provider, model: "fake" });
  assert.equal(f.requests.length, 3);
  const req = f.requests[0];
  assert.equal((req.system[0] as any).text, MINE_SYSTEM);
  assert.deepEqual(req.tools.map((t) => t.name), ["submit_mined_ticket"]);
  const dossier = (req.messages[0].content[0] as any).text as string;
  assert.match(dossier, /^<class>gate_tests: the tests failed after the agent finished<\/class>\n\n<count>3 runs on 2 tickets in the last 30 days<\/count>/);
  assert.match(dossier, /## MAX-1 A\nAttempt 1: failed \(`npm test` exited with code 1\)[\s\S]*expected 1, got 2/); // the gate output tail
  assert.match(dossier, /<lessons>\n\(none yet\)\n<\/lessons>$/);

  assert.deepEqual(r.created.map((c) => [c.class, c.title, c.confidence]), [["gate_tests", "Fix gate_tests", 0.8], ["stuck", "Fix stuck", 0.8]]);
  assert.deepEqual(r.lessons.map((l) => [l.class, l.version, l.lesson]), [["environment", 1, "Retry the setup command once before giving up"]]);
  assert.deepEqual(r.skipped, [{ class: "cancelled", why: "cancelled by a person: nothing to fix" }, { class: "budget_time", why: "only 1 run" }]);
  const t = await w.get(r.created[0].ticket_id);
  assert.deepEqual([t.status, t.mined_class, t.labels.map((l: any) => l.name), t.run_count], ["todo", "gate_tests", ["mined"], 0]);
  assert.match(t.spec, /^Make gate_tests stop: add a test\.\n\n## Mined from failures\n\nClass `gate_tests` \(the tests failed after the agent finished\): 3 runs on 2 tickets in the last 30 days\. Model confidence 0\.80\. Examples:\n- MAX-1 \(m1\): `npm test` exited with code 1\n/);
  const mined = (await call("GET", "/api/lessons", w.cookie)).body.versions[0];
  assert.deepEqual([mined.body, mined.state], ["- Retry the setup command once before giving up", "pending"]); // POL-10: waits for a human
  assert.deepEqual(JSON.parse((db.prepare("SELECT result FROM minings WHERE id = ?").get(r.id) as { result: string }).result).created.length, 2);
  assert.equal((await tickets(w)).filter((x) => x.labels.some((l: any) => l.name === "mined")).length, 2); // one label, reused

  // Again: both classes have an open mined ticket, the lesson is there already. Runs of mined tickets never count.
  canned(r.created[0].ticket_id, "ProviderError: HTTP 500");
  canned(r.created[0].ticket_id, "ProviderError: HTTP 500");
  const g = miner();
  const again = await mine({ workspaceId: w.ws, provider: g.provider, model: "fake" });
  assert.equal(g.requests.length, 1);
  assert.deepEqual([again.created, again.lessons], [[], []]);
  assert.deepEqual(again.skipped.map((s) => [s.class, s.why]), [
    ["gate_tests", `${r.created[0].key} is still open`], ["cancelled", "cancelled by a person: nothing to fix"], ["environment", "the model's lesson is already in the lessons"],
    ["stuck", `${r.created[1].key} is still open`], ["budget_time", "only 1 run"],
  ]);

  // A done (or failed) mined ticket no longer blocks its class.
  await call("PATCH", `/api/tickets/${r.created[0].ticket_id}`, w.cookie, { status: "done" });
  const third = await mine({ workspaceId: w.ws, provider: miner().provider, model: "fake" });
  assert.deepEqual(third.created.map((c) => c.class), ["gate_tests"]);
});

test("mining creates at most 5 tickets; a broken answer skips its class; the API uses the workspace model (demo)", async () => {
  const w = await workspace("cap");
  const t = await w.create({ title: "T" });
  const reasons = ["stuck: repeat_call (x)", "turn budget exhausted (120)", "time budget exhausted (60 min)", "`npm test` exited with code 1", "modified protected path tests/a", "model review: changes still requested after 3 rounds", "ProviderError: HTTP 500"];
  for (const [i, reason] of reasons.entries()) for (let n = 0; n <= i; n++) canned(t.id, reason); // distinct counts: a stable order
  const r = await mine({ workspaceId: w.ws, provider: miner().provider, model: "fake" });
  assert.equal(r.created.length, 5);
  assert.deepEqual(r.skipped, [{ class: "budget_turns", why: "at most 5 tickets per mining" }, { class: "stuck", why: "only 1 run" }]);

  const w2 = await workspace("api");
  const u = await w2.create({ title: "U" });
  for (let n = 0; n < 2; n++) canned(u.id, "stuck: repeat_call (read_file README.md)");
  const broken = await mine({ workspaceId: w2.ws, provider: fakeProvider([[{ type: "text", text: "no tool" }]]).provider, model: "fake" });
  assert.deepEqual(broken.skipped, [{ class: "stuck", why: "mining failed: it did not call submit_mined_ticket" }]);
  const res = await call("POST", "/api/failures/mine", w2.cookie);
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.body.created.map((c: any) => [c.class, c.title]), [["stuck", "Stop stuck failures"]]);
  assert.match((await w2.get(res.body.created[0].ticket_id)).spec, /^Demo draft: change the repository so runs stop failing with stuck \(2 runs on 1 ticket in the last 30 days\)\./);
  assert.equal((await call("GET", "/api/failures", w2.cookie)).body.classes[0].mined.key, res.body.created[0].key);
});
