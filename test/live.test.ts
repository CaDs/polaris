import { test } from "node:test";
import assert from "node:assert/strict";

// The live channel of a run (liveStream): the model's output while a call runs, coalesced, never stored, and always ahead
// of the turn's stored assistant_message.
process.env.POLARIS_PROVIDER = "fake";
const { app, call, db, until, workspace } = await import("./helpers.ts");
const { createRun, eventLog, liveStream, subscribe } = await import("../server/agent/events.ts");

const { cookie, create } = await workspace("live", { test_command: "", model_review: false, auto_split: false, wiki: false });
const msg = (text: string) => ({ type: "assistant_message" as const, payload: { message: { role: "assistant" as const, content: [{ type: "text" as const, text }] }, stop_reason: "end_turn" } });
const stored = (runId: string) => (db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string }[]).map((e) => e.type);

test("deltas are coalesced, flushed ahead of the next stored event, and never stored", async () => {
  const runId = createRun({ ticketId: (await create({ title: "live coalesce" })).id, model: "m" });
  const log = eventLog(runId);
  const seen: any[] = [];
  const stream = liveStream(runId);
  stream({ type: "text", text: "dropped: nobody watching" });
  const off = subscribe(runId, (e) => seen.push(e));
  stream({ type: "reasoning", text: "Let me " });
  for (let i = 0; i < 1000; i++) stream({ type: "reasoning", text: "x" });
  stream({ type: "text", text: "Reading " });
  stream({ type: "text", text: "a.txt" });
  stream({ type: "tool_use", id: "c1", name: "read_file" });
  log(msg("Reading a.txt"));
  assert.deepEqual(seen.map((e) => e.type), ["live", "assistant_message"]); // one message for 1,003 deltas, before the turn
  assert.deepEqual(seen[0].parts, [{ kind: "reasoning", text: `Let me ${"x".repeat(1000)}` }, { kind: "text", text: "Reading a.txt" }, { kind: "tool", id: "c1", name: "read_file" }]);

  stream({ type: "text", text: "on a timer" });
  await until("timer flush", () => seen.length === 3, 1000);
  assert.deepEqual(seen[2].parts, [{ kind: "text", text: "on a timer" }]);
  off();
  assert.deepEqual(stored(runId), ["assistant_message"]);
});

test("the run's SSE stream sends live messages without an id, in order with the stored events", async () => {
  const runId = createRun({ ticketId: (await create({ title: "live sse" })).id, model: "m" });
  const log = eventLog(runId);
  log({ type: "run_started", payload: { model: "m", task: "t", root: "/" } });
  const res = await app.request(`/api/runs/${runId}/events`, { headers: { cookie } });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = (await reader.read()).value!; // the replayed run_started: the stream is subscribed
  liveStream(runId)({ type: "text", text: "Done." });
  log(msg("Done."));
  log({ type: "run_finished", payload: { status: "passed", turns: 1, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } });
  for (let r = await reader.read(); !r.done; r = await reader.read()) text += r.value;
  const frames = text.trim().split(/\n\n/).map((f) => ({ id: /^id: (.*)$/m.exec(f)?.[1], e: JSON.parse(/^data: (.*)$/m.exec(f)![1]) }));
  assert.deepEqual(frames.map((f) => [f.id, f.e.type]), [["1", "run_started"], [undefined, "live"], ["2", "assistant_message"], ["3", "run_finished"]]);
});

test("a ticket run streams its model output live, ahead of each stored turn", async () => {
  const t = await create({ title: "live run" });
  const run = (await call("POST", `/api/tickets/${t.id}/runs`, cookie)).body;
  const seen: any[] = [];
  const off = subscribe(run.id, (e) => seen.push(e));
  await until("run finished", () => seen.some((e) => e.type === "run_finished"));
  off();
  const firstText = seen.findIndex((e) => e.type === "assistant_message" && e.payload.message.content.some((b: any) => b.type === "text"));
  const live = seen.findIndex((e) => e.type === "live" && e.parts.some((p: any) => p.kind === "text"));
  assert.ok(live >= 0 && live < firstText, "a live text part arrived before the first stored text");
  assert.ok(!stored(run.id).includes("live"));
});
