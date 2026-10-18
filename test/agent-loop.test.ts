import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../server/auth.ts";
import { db, migrate } from "../server/db.ts";
import { createRun, eventLog, subscribe } from "../server/agent/events.ts";
import { runAgent, type RunOptions } from "../server/agent/loop.ts";
import { fakeProvider, type Turn } from "../server/agent/providers/fake.ts";
import { tools } from "../server/agent/tools.ts";
import type { ToolUseBlock } from "../server/agent/types.ts";

migrate();
db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', '2026-01-01')").run();
db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES ('t', 'w', 'test')").run();

const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });

function run(script: Turn[], opts: Partial<RunOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "loop-"));
  const runId = createRun({ ticketId: "t", model: "fake", worktree: root });
  const live: number[] = [];
  const unsubscribe = subscribe(runId, (e) => live.push(e.seq));
  const fake = fakeProvider(script, { input: 100, output: 20, cache_read: 7, cache_write: 3 });
  const done = runAgent({
    provider: fake.provider, model: "fake", system: "sys", task: "do it", tools, root,
    budget: { maxTurns: 10, maxTokens: 1e6 }, onEvent: eventLog(runId), ...opts,
  }).finally(unsubscribe);
  return { root, runId, fake, done, live };
}

const events = (runId: string) =>
  db.prepare("SELECT seq, type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { seq: number; type: string; payload: string }[];
const runRow = (runId: string) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, any>;

test("fake provider drives the loop to create and edit a file, run a shell command and finish", async () => {
  const { root, runId, fake, done, live } = run([
    [{ type: "text", text: "creating" }, use("1", "edit_file", { path: "a.txt", old_string: "", new_string: "hello\n" })],
    [use("2", "edit_file", { path: "a.txt", old_string: "hello", new_string: "hello world" }), use("3", "shell", { command: "cat a.txt" })],
    [{ type: "text", text: "done" }],
  ]);
  const r = await done;

  assert.equal(r.status, "passed");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello world\n");
  // The third request carried both tool results in one user message.
  const last = fake.requests[2].messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.deepEqual(last.content.map((b) => b.type), ["tool_result", "tool_result"]);
  assert.match(JSON.stringify(last.content[1]), /hello world/);

  const ev = events(runId);
  assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));
  assert.deepEqual(live, ev.map((e) => e.seq));
  assert.deepEqual(ev.map((e) => e.type), [
    "run_started",
    "assistant_message", "usage", "tool_call", "tool_result",
    "assistant_message", "usage", "tool_call", "tool_result", "tool_call", "tool_result",
    "assistant_message", "usage",
    "run_finished",
  ]);
  assert.equal(JSON.parse(ev.at(-1)!.payload).status, "passed");

  const row = runRow(runId);
  assert.equal(row.status, "passed");
  assert.ok(row.started_at && row.ended_at);
  assert.deepEqual([row.tokens_in, row.tokens_out, row.tokens_cached], [3 * 103, 3 * 20, 3 * 7]);
});

test("turn and token budgets stop the run", async () => {
  const forever = Array(20).fill([use("x", "shell", { command: "true" })]);
  const turns = await run(forever, { budget: { maxTurns: 2, maxTokens: 1e6 } }).done;
  assert.equal(turns.status, "failed");
  assert.match(turns.reason!, /turn budget/);
  assert.equal(turns.turns, 2);

  const t = run(forever, { budget: { maxTurns: 20, maxTokens: 300 } });
  const tokens = await t.done;
  assert.equal(tokens.status, "failed");
  assert.match(tokens.reason!, /token budget/);
  assert.equal(tokens.turns, 3); // 123 tokens per turn
  assert.equal(runRow(t.runId).status, "failed");
});

test("abort signal cancels a running tool and the run", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const t = run([[use("s", "shell", { command: "sleep 30" })], [{ type: "text", text: "never" }]], { signal: ac.signal });
  const r = await t.done;
  assert.equal(r.status, "cancelled");
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(t.fake.requests.length, 1);
  const result = events(t.runId).find((e) => e.type === "tool_result")!;
  assert.equal(JSON.parse(result.payload).error_kind, "UserAborted");
  assert.equal(runRow(t.runId).status, "cancelled");
});

test("unexpected errors fail the run and are classified Unknown", async () => {
  const t = run([]);
  const r = await t.done;
  assert.equal(r.status, "failed");
  const err = events(t.runId).find((e) => e.type === "error")!;
  assert.equal(JSON.parse(err.payload).kind, "Unknown");
});

test("resume continues a conversation with a new user message; the earlier messages are untouched", async () => {
  const first = run([[{ type: "text", text: "done" }]]);
  const a = await first.done;
  const before = structuredClone(a.messages);
  const second = run([[{ type: "text", text: "fixed" }]], { resume: { messages: a.messages, message: "please fix" } });
  const b = await second.done;
  assert.equal(b.status, "passed");
  const sent = second.fake.requests[0].messages;
  assert.deepEqual(sent, [...before, { role: "user", content: [{ type: "text", text: "please fix" }] }]);
  assert.deepEqual(b.messages.slice(0, 3), sent);
});

test("finishHint is appended to the tool results when 2 turns are left, once", async () => {
  const sh = (id: string) => [use(id, "shell", { command: "true" })];
  const { fake, done } = run([sh("a"), sh("b"), sh("c"), sh("d"), sh("e")], { budget: { maxTurns: 5, maxTokens: 1e6 }, finishHint: "Wrap up." });
  assert.equal((await done).reason, "turn budget exhausted (5)");
  const notes = (i: number) => fake.requests[i].messages.at(-1)!.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  assert.deepEqual(notes(3), ["[harness] Only 2 turns are left in your budget. Wrap up."]); // sent with turn 4 of 5
  assert.deepEqual([notes(2), notes(4)], [[], []]);
});

// Wall-clock budget: the clock is injected and each scripted turn advances it by a minute.
function timed(turns: number, opts: Partial<RunOptions>) {
  let clock = 0;
  const sh = (i: number) => (): ToolUseBlock[] => ((clock += 60_000), [use(`t${i}`, "shell", { command: "true" })]);
  return run(Array.from({ length: turns }, (_, i) => sh(i)), { now: () => clock, ...opts });
}
const noteAt = (fake: { requests: { messages: { content: { type: string; text?: string }[] }[] }[] }, i: number) =>
  fake.requests[i].messages.at(-1)!.content.filter((b) => b.type === "text" && b.text!.startsWith("[harness]")).map((b) => b.text);

test("deadline: the run ends at the top of the turn once the wall clock passes it, naming the minutes", async () => {
  const { done } = timed(20, { budget: { maxTurns: 50, maxTokens: 1e6, deadline: 5 * 60_000 } });
  const r = await done;
  assert.deepEqual([r.status, r.turns, r.reason], ["failed", 5, "time budget exhausted (5 min)"]);
  const resumed = await timed(20, { budget: { maxTurns: 50, maxTokens: 1e6, deadline: 5 * 60_000, minutes: 60 } }).done; // a fix round: the attempt's minutes, not what is left
  assert.equal(resumed.reason, "time budget exhausted (60 min)");
});

test("finishHint also fires when under 10% of the time (min 2 minutes) is left, once, whichever limit comes first", async () => {
  // 100-minute window: 10% = 10 min, so the hint comes with the turn that leaves 9 minutes (turn 91 of the clock).
  const t = timed(100, { budget: { maxTurns: 500, maxTokens: 1e6, deadline: 100 * 60_000 }, finishHint: "Wrap up." });
  await t.done;
  const hinted = t.fake.requests.map((_, i) => i).filter((i) => noteAt(t.fake, i).length);
  assert.deepEqual(hinted, [91]); // request 91 carries the results of turn 91, sent after the clock reached 91 min
  assert.deepEqual(noteAt(t.fake, 91), ["[harness] Less than 9 minutes are left in your budget. Wrap up."]);
  // A short window uses the 2-minute floor.
  const s = timed(10, { budget: { maxTurns: 50, maxTokens: 1e6, deadline: 10 * 60_000 }, finishHint: "Wrap up." });
  await s.done;
  assert.deepEqual(s.fake.requests.map((_, i) => i).filter((i) => noteAt(s.fake, i).length), [9]);
  // Turns first: 3 turns of a minute against a 60-minute window.
  const n = timed(5, { budget: { maxTurns: 5, maxTokens: 1e6, deadline: 60 * 60_000 }, finishHint: "Wrap up." });
  assert.equal((await n.done).reason, "turn budget exhausted (5)");
  assert.deepEqual(noteAt(n.fake, 3), ["[harness] Only 2 turns are left in your budget. Wrap up."]);
});
