import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Resuming an attempt a server restart interrupted (HANDOVER-TASKS 1.3): the conversation rebuilt from its events, its
// worktree and branch kept, the same attempt number. Demo provider, host sandbox.
process.env.POLARIS_PROVIDER = "fake";
const { call, db, events, sh, until, waitFor, workspace } = await import("./helpers.ts");
const { recoverOrphans, resumeMessages, RESUME_NOTE } = await import("../server/runs.ts");
const { addWorktree } = await import("../server/git.ts");
const { eventLog } = await import("../server/agent/events.ts");

const use = (id: string, name: string, input: Record<string, unknown>, namespace?: string) => ({ type: "tool_use" as const, id, name, input, ...(namespace ? { namespace } : {}) });
const said = (...content: any[]) => ({ type: "assistant_message", payload: { message: { role: "assistant", content }, stop_reason: "tool_use" } });
const result = (id: string, content: string) => ({ type: "tool_result", payload: { tool_use_id: id, content, is_error: false } });

test("resumeMessages: task, each turn with its results, the cut turn dropped, the note as the user's turn", () => {
  const ev = [
    { type: "run_started", payload: { task: "T" } },
    said({ type: "text", text: "Looking." }, use("a", "read_file", { path: "x" }, "polaris")),
    { type: "usage", payload: {} },
    result("a", "x body"),
    said(use("b", "edit_file", { path: "y" }), use("c", "shell", { command: "ls" })),
    result("b", "ok"),
    result("c", "y"),
    said(use("d", "shell", { command: "npm test" })), // the restart cut this one: no result
  ];
  const r = resumeMessages(ev)!;
  assert.equal(r.turns, 2);
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(r.messages[2].content, [{ type: "tool_result", tool_use_id: "a", content: "x body", is_error: false, namespace: "polaris" }]);
  assert.deepEqual(r.messages[4].content.map((b: any) => b.tool_use_id ?? b.text), ["b", "c", RESUME_NOTE]);
  // Not replayable exactly: the harness added text the events don't hold, or the gate had started.
  for (const extra of ["stuck", "compaction", "gate_fix", "test_result"]) assert.equal(resumeMessages([...ev, { type: extra, payload: {} }]), undefined, extra);
  assert.equal(resumeMessages(ev.slice(0, 1)), undefined); // nothing to keep
});

test("recovery resumes an interrupted attempt in place: same attempt, worktree and branch, its edit reaches the commit", async () => {
  const w = await workspace("rs", { test_command: "test -f notes.txt", model_review: false, auto_split: false, wiki: false });
  const t = await w.create({ title: "Resume me", spec: "Write notes" });
  const id = `dead-${t.id}`;
  const wt = join(process.env.POLARIS_DATA_DIR!, "worktrees", id);
  const branch = `polaris/${t.key}-1-dead`;
  const base = await addWorktree(w.repo, "main", wt, branch);
  writeFileSync(join(wt, "half.txt"), "written before the restart\n");
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(t.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status, attempt, worktree, branch, base_sha, started_at) VALUES (?, ?, 'demo', 'running', 1, ?, ?, ?, ?)").run(id, t.id, wt, branch, base, Date.now());
  const log = eventLog(id);
  log({ type: "run_started", payload: { model: "demo", task: "# Task\n\nResume me", root: wt } });
  log({ type: "assistant_message", payload: { message: { role: "assistant", content: [use("h", "edit_file", { path: "half.txt", old_string: "", new_string: "x" })] }, stop_reason: "tool_use" } });
  log({ type: "tool_result", payload: { tool_use_id: "h", content: "created half.txt", is_error: false } });

  assert.equal(recoverOrphans(), 1);
  const done = await waitFor(w.cookie, t.id, "review");
  assert.deepEqual(done.runs.map((r: any) => [r.attempt, r.status]), [[1, "failed"], [1, "passed"]]);
  const resumed = done.runs[1];
  assert.equal((db.prepare("SELECT resumed_from FROM runs WHERE id = ?").get(resumed.id) as { resumed_from: string }).resumed_from, id);
  assert.deepEqual(events(resumed.id).find((e) => e.type === "setup" && e.p.step === "resumed")!.p, { step: "resumed", from: id, turns: 1 });
  assert.equal(events(resumed.id).find((e) => e.type === "setup" && e.p.step === "worktree")!.p.branch, branch);
  assert.equal(events(id).find((e) => e.type === "run_finished")!.p.reason, "interrupted by server restart");
  assert.match(sh(w.repo, `git show --stat --format= ${branch}`), /half\.txt/); // the pre-restart edit is in the commit
  assert.ok(existsSync(wt));
  await call("POST", `/api/tickets/${t.id}/reject`, w.cookie, { note: "" }); // clean up the kept worktree
});

test("adoptWorktree finds a worktree from the repository's side after a restart, never from its own .git file", async () => {
  const { adoptWorktree, git } = await import("../server/git.ts");
  const { tempRepo } = await import("./helpers.ts");
  const repo = tempRepo();
  const wt = `${repo}-wt`;
  sh(repo, `git worktree add -q -b polaris/adopt ${wt}`); // made by another process: this one has no git dir for it
  writeFileSync(join(wt, ".git"), "gitdir: /tmp/somewhere-else\n"); // what an agent could write in the sandbox
  assert.equal(await adoptWorktree(repo, wt), true);
  writeFileSync(join(wt, "new.txt"), "x\n");
  assert.match(await git(wt, ["status", "--porcelain"]), /new\.txt/); // git works through the repository's admin dir
  assert.equal(await adoptWorktree(repo, `${repo}-missing`), false);
});

test("an interrupted planner round is re-run once (a round is stateless); the epic carries on", async () => {
  const w = await workspace("rp", { test_command: "", model_review: false, auto_split: false, wiki: false, auto_approve_children: true });
  const epic = await w.create({ title: "Two files", spec: "Add a.txt and b.txt.", kind: "epic" });
  db.prepare("UPDATE tickets SET status = 'running' WHERE id = ?").run(epic.id);
  db.prepare("INSERT INTO runs (id, ticket_id, model, status, role, attempt, started_at) VALUES (?, ?, 'demo', 'running', 'planner', 1, ?)").run(`round-${epic.id}`, epic.id, Date.now());
  assert.equal(recoverOrphans(), 1);
  const rerun = await until("re-run queued", () => db.prepare("SELECT attempt, role FROM runs WHERE resumed_from = ?").get(`round-${epic.id}`) as { attempt: number; role: string } | undefined); // queued after the container sweep
  assert.deepEqual([rerun.attempt, rerun.role], [1, "planner"]);
  assert.equal((await waitFor(w.cookie, epic.id, "review")).status, "review"); // children done, epic gate passed
});
