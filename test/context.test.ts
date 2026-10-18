import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M5: spilled tool output, compaction, skills, cache-friendly prefix, usage API, reliability fixes.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SANDBOX = "host";
process.env.POLARIS_CONCURRENCY = "2";
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "ctx-data-"));
const { app } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const { runAgent } = await import("../server/agent/loop.ts");
const { fakeProvider } = await import("../server/agent/providers/fake.ts");
const { listSkills, skillsText } = await import("../server/agent/context.ts");
const { runTool, tools, hostExec, SPILL_AT } = await import("../server/agent/tools.ts");
const { addWorktree, commitAll, protectedChanges } = await import("../server/git.ts");
const { compactThreshold } = await import("../server/runs.ts");
import type { AgentEvent, Block, ToolUseBlock, Usage } from "../server/agent/types.ts";

const origin = "http://localhost:5173";
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

function tempRepo(files: Record<string, string> = { "README.md": "hi\n" }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  sh(dir, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init");
  return dir;
}
async function call(method: string, path: string, cookie = "", body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set || cookie };
}
async function user(name: string) {
  const { cookie } = await call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
  return (await call("POST", "/api/auth/organization/create", cookie, { name, slug: name })).cookie;
}
async function waitFor(cookie: string, ticketId: string, status: string, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const t = await call("GET", `/api/tickets/${ticketId}`, cookie);
    if (t.body.status === status) return t.body;
  }
  const runs = db.prepare("SELECT id FROM runs WHERE ticket_id = ?").all(ticketId) as { id: string }[];
  assert.fail(`ticket never reached ${status}: ${JSON.stringify(runs.flatMap((r) => events(r.id).filter((e) => e.type === "error" || e.type === "run_finished").map((e) => e.p)))}`);
}
const events = (runId: string) =>
  (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));

// Loop with a scripted provider whose reported usage grows with the conversation: 400 tokens per message (100 uncached, 300 cached).
function loop(script: Parameters<typeof fakeProvider>[0], o: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctx-loop-"));
  const fake = fakeProvider(script, (req): Usage => ({ input: 100 * req.messages.length, output: 20, cache_read: 300 * req.messages.length, cache_write: 0 }));
  const evs: AgentEvent[] = [];
  const done = runAgent({
    provider: fake.provider, model: "fake", system: "sys", task: "TASK", tools, root, budget: { maxTurns: 20, maxTokens: 1e6 }, onEvent: (e) => evs.push(e), ...o,
  });
  return { root, fake, evs, done };
}

test("long shell output is saved in full to .polaris/outputs; the model gets the path, size and tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "spill-"));
  const run = (command: string) => runTool(tools, use("toolu/1", "shell", { command }), { root, exec: hostExec, turn: 7 });
  const short = await run("seq 1 100");
  assert.ok(short.content.length < SPILL_AT && !short.content.includes("Output too long"));
  assert.equal(existsSync(join(root, ".polaris")), false);

  const big = await run("seq 1 5000; echo done-marker >&2");
  assert.equal(big.is_error, false);
  const file = ".polaris/outputs/7-shell-toolu_1.txt"; // id sanitized for the file name
  const full = readFileSync(join(root, file), "utf8");
  assert.match(full, /^exit code: 0\nstdout:\n1\n2\n3\n/);
  assert.match(full, /4999\n5000\n\nstderr:\ndone-marker\n$/);
  assert.match(big.content, new RegExp(`^\\[Output too long: saved to ${file}\\]`));
  assert.match(big.content, new RegExp(`Total: ${full.length} chars, 5006 lines`));
  assert.ok(big.content.includes(full.slice(-2000)), "the last 2000 chars are returned");
  assert.ok(!big.content.includes("\n2500\n"), "not the middle");
  assert.ok(big.content.length < 2600);
  assert.match(big.content, /read_file with offset\/limit/);

  const found = await runTool(tools, use("s1", "search", { pattern: "." , path: file }), { root, exec: hostExec, turn: 8 });
  assert.match(found.content, /8-search-s1\.txt/);
});

test(".polaris/outputs and history never reach the commit, the diff or the protected-path check; skills do", async () => {
  const repo = tempRepo({ "README.md": "hi\n", "tests/a.js": "1\n", ".polaris/skills/s.md": "---\nname: s\ndescription: d\n---\n" });
  const wt = join(process.env.POLARIS_DATA_DIR!, "wt-scratch");
  const base = await addWorktree(repo, "main", wt, "polaris/S-1-abc");
  assert.match(readFileSync(join(repo, ".git/info/exclude"), "utf8"), /\/\.polaris\/outputs\/\n\/\.polaris\/history\//);
  await addWorktree(repo, "main", join(process.env.POLARIS_DATA_DIR!, "wt-scratch2"), "polaris/S-2-abc"); // idempotent
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/outputs/g)!.length, 1);

  mkdirSync(join(wt, ".polaris/outputs"), { recursive: true });
  mkdirSync(join(wt, ".polaris/history"), { recursive: true });
  writeFileSync(join(wt, ".polaris/outputs/1-shell-a.txt"), "big\n");
  writeFileSync(join(wt, ".polaris/history/1.md"), "h\n");
  writeFileSync(join(wt, "new.txt"), "n\n");
  assert.equal(sh(wt, "git status --porcelain"), "?? new.txt");
  // Even protecting all of .polaris only flags edits to committed files (skills), not the harness's own scratch files.
  assert.deepEqual(await protectedChanges(wt, base, [".polaris"]), []);
  writeFileSync(join(wt, ".polaris/skills/s.md"), "changed\n");
  assert.deepEqual(await protectedChanges(wt, base, [".polaris"]), [".polaris/skills/s.md"]);
  sh(wt, "git checkout -q -- .polaris/skills");

  await commitAll(wt, "x");
  assert.equal(sh(wt, "git ls-tree -r --name-only HEAD"), ".polaris/skills/s.md\nREADME.md\nnew.txt\ntests/a.js");
  // Force-add (e.g. an exclude file that is missing): commitAll's pathspec still leaves them out.
  writeFileSync(join(wt, ".polaris/outputs/2.txt"), "x");
  sh(repo, "rm .git/info/exclude");
  await commitAll(wt, "y");
  assert.doesNotMatch(sh(wt, "git ls-tree -r --name-only HEAD"), /outputs|history/);
});

test("skills: frontmatter parsed, sorted, listed by name, description and path only", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  assert.deepEqual(listSkills(root), []);
  assert.equal(skillsText([]), "");
  mkdirSync(join(root, ".polaris/skills"), { recursive: true });
  const w = (f: string, body: string) => writeFileSync(join(root, ".polaris/skills", f), body);
  w("b-release.md", '---\nname: "release"\ndescription: Cut a release\n---\n# Release\nSECRET-BODY\n');
  w("a-lint.md", "---\ndescription: Run the linter\n---\nbody\n");
  w("c-plain.md", "no frontmatter\n");
  w("deploy.sh", "#!/bin/sh\n");
  const skills = listSkills(root);
  assert.deepEqual(skills, [
    { name: "a-lint", description: "Run the linter", path: ".polaris/skills/a-lint.md" },
    { name: "release", description: "Cut a release", path: ".polaris/skills/b-release.md" },
    { name: "c-plain", description: "", path: ".polaris/skills/c-plain.md" },
  ]);
  const t = skillsText(skills);
  assert.match(t, /- release — Cut a release — \.polaris\/skills\/b-release\.md/);
  assert.doesNotMatch(t, /SECRET-BODY/);
});

test("compaction: history file, fresh conversation, append-only requests, budget continues", async () => {
  const summaryTurn: Block[] = [text("Summary S1: did A, left B."), use("ign", "shell", { command: "touch ignored.txt" })];
  const t = loop(
    [
      [text("start"), use("c1", "shell", { command: "seq 1 3000" })],
      [use("c2", "shell", { command: "echo second" })],
      summaryTurn,
      [use("c3", "shell", { command: "echo after" })],
      [text("all done")],
    ],
    { compactAt: 1000, cacheKey: "ticket-9" },
  );
  const r = await t.done;
  assert.equal(r.status, "passed");
  const reqs = t.fake.requests;
  assert.equal(reqs.length, 5);
  assert.ok(reqs.every((q) => q.cacheKey === "ticket-9"), "one cache key for the whole run, across compactions");

  // Within a conversation every request extends the previous one verbatim; the only shrink is the compaction itself.
  let fresh = 0;
  reqs.forEach((q, i) => {
    assert.equal(JSON.stringify(q.tools), JSON.stringify(reqs[0].tools), "tools never change");
    assert.equal(JSON.stringify(q.system), JSON.stringify(reqs[0].system), "system never changes");
    if (!i) return;
    const prev = reqs[i - 1].messages;
    if (q.messages.length > prev.length) assert.deepEqual(q.messages.slice(0, prev.length), prev, `request ${i + 1} edits earlier messages`);
    else (fresh++, assert.equal(q.messages.length, 1));
  });
  assert.equal(fresh, 1);
  assert.deepEqual(reqs.map((q) => q.messages.length), [1, 3, 6, 1, 3]);

  // The summary request is the last message of request 3, appended after the tool results; tools were still offered.
  const ask = reqs[2].messages.at(-1)!;
  assert.equal(ask.role, "user");
  assert.match(JSON.stringify(ask), /Do not call any tools/);
  assert.ok(reqs[2].tools.length > 0);
  assert.equal(existsSync(join(t.root, "ignored.txt")), false, "tool calls in the summary turn are ignored");

  // New conversation: task + summary + pointer.
  const first = reqs[3].messages[0].content[0];
  assert.equal(first.type === "text" && first.text, "TASK\n\nContext was compacted. Summary:\nSummary S1: did A, left B.\n\nFull history: .polaris/history/1.md (search it with rg/read_file if a detail is missing)");

  // History: every tool call with input, every result, the spill notice.
  const history = readFileSync(join(t.root, ".polaris/history/1.md"), "utf8");
  for (const needle of ["Tool call shell (c1)", '"command": "seq 1 3000"', "Tool call shell (c2)", '"command": "echo second"', "Tool result (c2)", "Output too long: saved to .polaris/outputs/1-shell-c1.txt", "TASK"])
    assert.ok(history.includes(needle), needle);
  assert.ok(!history.includes("echo after"), "only the compacted conversation");
  assert.equal(readFileSync(join(t.root, ".polaris/outputs/1-shell-c1.txt"), "utf8").split("\n").length, 3000 + 5);

  const c = t.evs.filter((e) => e.type === "compaction");
  assert.deepEqual(c.map((e) => e.payload), [{ n: 1, tokens_before: 1200, summary_chars: "Summary S1: did A, left B.".length, history_path: ".polaris/history/1.md" }]);
  // Order: summary turn's message + usage, then the compaction event; its tool call produced no tool_call event.
  assert.deepEqual(t.evs.map((e) => e.type).slice(8, 14), ["tool_result", "assistant_message", "usage", "compaction", "assistant_message", "usage"]);
  assert.equal(t.evs.filter((e) => e.type === "tool_call").length, 3);
  // Usage includes the summary turn: 100 * (1 + 3 + 6 + 1 + 3) uncached.
  assert.equal(r.usage.input, 1400);
  assert.equal(r.turns, 5);
});

test("compaction repeats with numbered history files and the token budget spans conversations", async () => {
  const sum = (n: number) => [text(`S${n}`)];
  const t = loop(
    [
      [use("a", "shell", { command: "true" })], [use("b", "shell", { command: "true" })], sum(1),
      [use("c", "shell", { command: "true" })], [use("d", "shell", { command: "true" })], sum(2),
      [text("end")],
    ],
    { compactAt: 1000 },
  );
  const r = await t.done;
  assert.equal(r.status, "passed");
  assert.deepEqual(t.evs.filter((e) => e.type === "compaction").map((e) => (e.payload as any).history_path), [".polaris/history/1.md", ".polaris/history/2.md"]);
  const third = t.fake.requests[6].messages[0].content[0];
  assert.match(third.type === "text" ? third.text : "", /^TASK\n\nContext was compacted\. Summary:\nS2\n\nFull history: \.polaris\/history\/1\.md, \.polaris\/history\/2\.md/);
  assert.match(readFileSync(join(t.root, ".polaris/history/2.md"), "utf8"), /Context was compacted\. Summary:\nS1/); // chain

  // A budget that the first conversation did not exhaust is exhausted by the next one: spent counts everything.
  const b = await loop(
    [[use("a", "shell", { command: "true" })], [use("b", "shell", { command: "true" })], sum(1), [use("c", "shell", { command: "true" })], [text("never")]],
    { compactAt: 1000, budget: { maxTurns: 20, maxTokens: 1000 } },
  ).done;
  assert.equal(b.status, "failed");
  assert.match(b.reason!, /token budget exhausted \(1060 >= 1000\)/); // the summary turn counted
  assert.equal(b.turns, 3);
});

test("a threshold below the fresh conversation's size still allows two turns between compactions", async () => {
  const sh = (id: string) => [use(id, "shell", { command: "true" })];
  // compactAt 1: every request is "too big"; without the guard this compacts after every single turn.
  const t = loop([sh("a"), sh("b"), [text("S1")], sh("c"), sh("d"), [text("S2")], [text("end")]], { compactAt: 1 });
  const r = await t.done;
  assert.equal(r.status, "passed");
  assert.equal(t.evs.filter((e) => e.type === "compaction").length, 2);
  assert.equal(t.evs.filter((e) => e.type === "tool_call").length, 4);
});

test("a reply cut off by max_tokens is continued (twice at most), never counted as success", async () => {
  const ok = loop([{ blocks: [text("part one")], stopReason: "max_tokens" }, { blocks: [text("part two")], stopReason: "end_turn" }]);
  assert.equal((await ok.done).status, "passed");
  const last = ok.fake.requests[1].messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last), /cut off by the output token limit/);
  assert.deepEqual(ok.fake.requests[1].messages.slice(0, 2), [ok.fake.requests[0].messages[0], { role: "assistant", content: [text("part one")] }]);

  const cut = { blocks: [text("x")], stopReason: "max_output_tokens" };
  const bad = loop([cut, cut, cut, cut]);
  const r = await bad.done;
  assert.equal(r.status, "failed");
  assert.match(r.reason!, /cut off by the output token limit 3 times/);
  assert.equal(bad.fake.requests.length, 3);
  // "In a row": a tool turn in between resets the count.
  const reset = loop([cut, cut, [use("t", "shell", { command: "true" })], cut, cut, { blocks: [text("fin")], stopReason: "end_turn" }]);
  assert.equal((await reset.done).status, "passed");
});

test("truncated tool-call JSON comes back as InvalidArguments and nothing runs", async () => {
  const t = loop([
    [{ ...use("x", "edit_file", {}), invalid_input: '{"path":"a.txt","old_string":"","new_str' }],
    [text("sorry, retrying")],
  ]);
  const r = await t.done;
  assert.equal(r.status, "passed");
  const res = t.evs.find((e) => e.type === "tool_result")!.payload as any;
  assert.equal(res.is_error, true);
  assert.equal(res.error_kind, "InvalidArguments");
  assert.match(res.content, /not valid JSON/);
  assert.match(res.content, /Nothing was run/);
  assert.equal(existsSync(join(t.root, "a.txt")), false);
});

test("provider/workspace context settings: defaults per kind, editable, validated; compaction threshold", async () => {
  const pam = await user("pam");
  const mk = async (kind: string, extra = {}) => (await call("POST", "/api/providers", pam, { name: kind, kind, ...extra })).body;
  assert.deepEqual([(await mk("anthropic")).context_window, (await mk("openai")).context_window, (await mk("ollama")).context_window], [1_000_000, 400_000, 32_768]);
  const p = await mk("anthropic", { context_window: 200_000 });
  assert.equal(p.context_window, 200_000);
  const patched = await call("PATCH", `/api/providers/${p.id}`, pam, { context_window: 50_000 });
  assert.equal(patched.body.context_window, 50_000);
  assert.equal((await call("PATCH", `/api/providers/${p.id}`, pam, { name: "renamed" })).body.context_window, 50_000); // kept
  for (const bad of [10, "big", 1.5, 1e12]) assert.equal((await call("PATCH", `/api/providers/${p.id}`, pam, { context_window: bad })).status, 400, String(bad));
  assert.ok((await call("GET", "/api/providers", pam)).body.every((x: any) => x.context_window > 0));

  assert.equal((await call("GET", "/api/settings", pam)).body.compact_at_tokens, 150_000);
  const repo = tempRepo();
  assert.equal((await call("PUT", "/api/settings", pam, { repo_path: repo, compact_at_tokens: "20000" })).body.compact_at_tokens, 20_000);
  assert.equal((await call("PUT", "/api/settings", pam, { repo_path: repo, compact_at_tokens: 5 })).status, 400);
  assert.equal((await call("GET", "/api/settings", pam)).body.compact_at_tokens, 20_000);

  delete process.env.POLARIS_COMPACT_AT;
  assert.equal(compactThreshold(150_000, 1_000_000), 150_000); // workspace cap
  assert.equal(compactThreshold(150_000, 32_768), 22_937); // 70% of a small window
  assert.equal(compactThreshold(undefined, 400_000), 150_000);
  process.env.POLARIS_COMPACT_AT = "1000";
  assert.equal(compactThreshold(150_000, 1_000_000), 1000);
  delete process.env.POLARIS_COMPACT_AT;
});

test("system prompt and tools are byte-identical across repos and runs; per-run context is in the first user message", async () => {
  // Mock Anthropic: one shell call, then done. Records every request body.
  const bodies: any[] = [];
  const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    bodies.push(b);
    const tool = b.messages.at(-1).content[0].type !== "tool_result";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      ...(tool
        ? [
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "shell", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"true"}' } },
            { type: "content_block_stop", index: 0 },
          ]
        : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }]),
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
    ]));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const mock = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const skill = "---\nname: deploy\ndescription: Deploy the thing\n---\nSTEP-ONE\n";
  const setup = async (name: string, files: Record<string, string>) => {
    const cookie = await user(name);
    const repo = tempRepo(files);
    await call("PUT", "/api/settings", cookie, { repo_path: repo, setup_command: "", test_command: "", model_review: false });
    const provider = (await call("POST", "/api/providers", cookie, { name: "mock", kind: "anthropic", base_url: mock, api_key: "k" })).body.id;
    const t = (await call("POST", "/api/tickets", cookie, { title: `ticket of ${name}`, spec: "do it", provider_id: provider, model: "claude-sonnet-5-5" })).body;
    await call("POST", `/api/tickets/${t.id}/runs`, cookie);
    const done = await waitFor(cookie, t.id, "review");
    return { repo, run: done.runs[0], first: bodies.find((b) => b.messages[0].content[0].text.includes(`ticket of ${name}`)) };
  };
  const a = await setup("zed", { "README.md": "hi\n", ".polaris/skills/deploy.md": skill });
  const b = await setup("yan", { "README.md": "hi\n" });
  srv.close();

  const worker = readFileSync(new URL("../server/agent/prompts/worker.md", import.meta.url), "utf8");
  assert.equal(a.first.system[0].text, worker);
  assert.equal(JSON.stringify(a.first.system), JSON.stringify(b.first.system));
  assert.equal(JSON.stringify(a.first.tools), JSON.stringify(b.first.tools));
  assert.doesNotMatch(JSON.stringify(a.first.system) + JSON.stringify(a.first.tools), /deploy|zed|Sandbox:/);

  const m0 = a.first.messages[0].content[0].text as string;
  assert.match(m0, /^# Environment\n- Sandbox: .+\n- Repository: repo-.+, branched from main\. It is at \/work in the sandbox.*\n- Read-only paths \(changes there fail the run\): tests, evals, \.polaris\/wiki\n\nSkills /);
  assert.match(m0, /- deploy — Deploy the thing — \.polaris\/skills\/deploy\.md\n\n# Task\n\n# ticket of zed\n\ndo it$/);
  assert.doesNotMatch(m0, /STEP-ONE/); // description only; the body is read on demand
  assert.doesNotMatch(b.first.messages[0].content[0].text, /Skills/);
  assert.deepEqual(events(a.run.id).find((e) => e.type === "setup" && e.p.step === "skills")!.p.skills, [{ name: "deploy", description: "Deploy the thing", path: ".polaris/skills/deploy.md" }]);
  assert.equal(events(b.run.id).some((e) => e.type === "setup" && e.p.step === "skills"), false);

  // Breakpoints: tools, system, last block of the last message of every request; the earlier request is a prefix of the next.
  const reqs = bodies.filter((x) => x.tools && x.messages[0].content[0].text.includes("ticket of zed")); // not the reflection (no tools)
  for (const q of reqs) {
    assert.equal(JSON.stringify(q).split("cache_control").length - 1, 3);
    assert.ok(q.messages.at(-1).content.at(-1).cache_control);
  }
  const strip = (m: any) => JSON.parse(JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v)));
  assert.deepEqual(strip(reqs[1].messages.slice(0, 1)), strip(reqs[0].messages));
});

test("a compacting run through the pipeline: spill + history stay out of commit and diff; usage is booked", async () => {
  process.env.POLARIS_COMPACT_AT = "1000";
  const cookie = await user("frank");
  const repo = tempRepo({ "README.md": "hi\n", ".polaris/skills/deploy.md": "---\nname: deploy\ndescription: Deploy\n---\n" });
  await call("PUT", "/api/settings", cookie, { repo_path: repo, setup_command: "", test_command: "test -f notes.txt", model_review: false });
  const t = (await call("POST", "/api/tickets", cookie, { title: "long session", spec: "please compact along the way" })).body;
  await call("POST", `/api/tickets/${t.id}/runs`, cookie);
  const done = await waitFor(cookie, t.id, "review", 30_000);
  delete process.env.POLARIS_COMPACT_AT;
  const run = done.runs[0];
  assert.equal(run.status, "passed");

  const ev = events(run.id);
  const spilled = ev.find((e) => e.type === "tool_result" && /Output too long/.test(e.p.content))!;
  assert.match(spilled.p.content, /saved to \.polaris\/outputs\/1-shell-1\.txt/);
  assert.deepEqual(ev.filter((e) => e.type === "compaction").map((e) => e.p), [{ n: 1, tokens_before: 1200, summary_chars: 121, history_path: ".polaris/history/1.md" }]);
  assert.match(ev.find((e) => e.type === "run_started")!.p.task, /deploy — Deploy — \.polaris\/skills\/deploy\.md/);

  // On disk in the worktree, but not in the branch, the diff or the status.
  assert.equal(readFileSync(join(run.worktree, ".polaris/outputs/1-shell-1.txt"), "utf8").split("\n").length, 4000 + 5);
  assert.match(readFileSync(join(run.worktree, ".polaris/history/1.md"), "utf8"), /seq 1 4000/);
  assert.equal(sh(repo, `git ls-tree -r --name-only ${run.branch}`), ".polaris/skills/deploy.md\nREADME.md\nnotes.txt");
  const diff = (await call("GET", `/api/tickets/${t.id}/diff`, cookie)).body.diff;
  assert.match(diff, /notes\.txt/);
  assert.doesNotMatch(diff, /\.polaris/);
  assert.equal(sh(run.worktree, "git status --porcelain"), "");

  // 5 turns of (100, 300) per message: 14 messages → 1400 uncached, 4200 cached.
  assert.deepEqual([run.tokens_in, run.tokens_out, run.tokens_cached], [1400, 100, 4200]);
  const u = (await call("GET", "/api/usage", cookie)).body;
  assert.deepEqual([u.totals.runs, u.totals.tokens_in, u.totals.tokens_out, u.totals.tokens_cached, u.totals.cache_hit_rate], [1, 1400, 100, 4200, 0.75]);
  assert.equal(u.tickets[0].key, "FRA-1");
  assert.equal(u.models[0].model, "demo");
});

test("GET /api/usage: totals, 14 days, models, top tickets, hit rate; isolated per workspace", async () => {
  const gina = await user("gina");
  const hank = await user("hank");
  const ws = (slug: string) => (db.prepare("SELECT id FROM organization WHERE slug = ?").get(slug) as { id: string }).id;
  const ticket = (slug: string, id: string, title: string) => db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES (?, ?, ?)").run(id, ws(slug), title);
  ticket("gina", "ug1", "big one");
  ticket("gina", "ug2", "small one");
  ticket("hank", "uh1", "hank's");
  const day = (ago: number) => Date.now() - ago * 86_400_000;
  const run = (ticket: string, model: string, started: number | null, i: number, o: number, c: number, cost: number) =>
    db.prepare("INSERT INTO runs (id, ticket_id, model, status, tokens_in, tokens_out, tokens_cached, cost_usd, started_at) VALUES (?, ?, ?, 'passed', ?, ?, ?, ?, ?)")
      .run(`r${Math.random()}`, ticket, model, i, o, c, cost, started);
  run("ug1", "m1", day(0), 100, 10, 300, 0.5);
  run("ug1", "m1", day(1), 100, 10, 0, 0.25);
  run("ug1", "m2", day(30), 1000, 100, 0, 1);
  run("ug2", "m2", day(0), 50, 5, 150, 0);
  run("ug2", "m2", null, 999, 999, 999, 9); // never started (queued): ignored
  run("uh1", "m1", day(0), 7, 7, 7, 7);

  const u = (await call("GET", "/api/usage", gina)).body;
  assert.deepEqual(
    [u.totals.runs, u.totals.tokens_in, u.totals.tokens_out, u.totals.tokens_cached, u.totals.cost_usd, u.totals.cache_hit_rate],
    [4, 1250, 125, 450, 1.75, 450 / 1700],
  );
  assert.equal(u.days.length, 14);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(u.days[0].day, today);
  assert.deepEqual([u.days[0].runs, u.days[0].tokens_in, u.days[0].tokens_out, u.days[0].tokens_cached, u.days[0].cache_hit_rate], [2, 150, 15, 450, 0.75]);
  assert.deepEqual([u.days[1].runs, u.days[1].tokens_in, u.days[1].cache_hit_rate], [1, 100, 0]);
  assert.deepEqual([u.days[2].runs, u.days[2].cache_hit_rate], [0, null]);
  assert.deepEqual(u.models.map((m: any) => [m.model, m.runs, m.tokens_in]), [["m2", 2, 1050], ["m1", 2, 200]]); // by total tokens
  assert.deepEqual(u.tickets.map((t: any) => [t.key, t.title, t.tokens_in + t.tokens_out]), [["GIN-1", "big one", 1320], ["GIN-2", "small one", 55]]);

  const h = (await call("GET", "/api/usage", hank)).body;
  assert.deepEqual([h.totals.runs, h.totals.tokens_in, h.models.length, h.tickets.map((t: any) => t.title)], [1, 7, 1, ["hank's"]]);
  const none = (await call("GET", "/api/usage", await user("ivy"))).body;
  assert.deepEqual([none.totals.runs, none.totals.cache_hit_rate, none.models, none.tickets], [0, null, [], []]);
  assert.equal((await call("GET", "/api/usage")).status, 401);
});

test("read_file: an identical re-read returns a stub; edits, another range or a compaction bring the content back", async () => {
  const root = mkdtempSync(join(tmpdir(), "reads-"));
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  const reads = new Map();
  const rd = (input: Record<string, unknown>, turn: number) => runTool(tools, use("r", "read_file", { path: "a.txt", ...input }), { root, exec: hostExec, reads, turn });
  const full = (await rd({}, 1)).content;
  assert.match(full, /^1\tone\n2\ttwo/);
  assert.equal((await rd({}, 2)).content, "[unchanged since your read_file of a.txt at turn 1; that output is above in this conversation]");
  assert.equal((await rd({}, 3)).content.slice(0, 5), "[unch", "still points at the original turn");
  assert.match((await rd({}, 3)).content, /at turn 1;/);
  assert.equal((await rd({ offset: 2 }, 4)).content, "2\ttwo\n3\tthree\n4\t");
  await runTool(tools, use("e", "edit_file", { path: "a.txt", old_string: "two", new_string: "2" }), { root, exec: hostExec });
  assert.match((await rd({}, 5)).content, /2\t2\n/);
  assert.match((await rd({}, 6)).content, /^\[unchanged .* at turn 5;/);

  // Through the loop: the memory is dropped on compaction.
  const t = loop(
    [[use("a", "read_file", { path: "a.txt" })], [use("b", "read_file", { path: "a.txt" })], [text("S")], [use("c", "read_file", { path: "a.txt" })], [text("end")]],
    { compactAt: 1000, root },
  );
  assert.equal((await t.done).status, "passed");
  const out = t.evs.flatMap((e) => (e.type === "tool_result" ? [e.payload.content] : []));
  assert.deepEqual(out.map((c) => c.startsWith("[unchanged")), [false, true, false]);
  assert.match(out[1], /at turn 1;/);
});

test("compaction: structured summary request, then the change so far and the files read go into the new first message", async () => {
  const repo = tempRepo({ "tracked.txt": "old line\n", "big.txt": "x\n" });
  const script = [
    [use("r1", "read_file", { path: "tracked.txt" }), use("r2", "read_file", { path: "big.txt" })],
    [use("e1", "edit_file", { path: "tracked.txt", old_string: "old line", new_string: "new line" }), use("e2", "edit_file", { path: "fresh.txt", old_string: "", new_string: "hi\n" }), use("r3", "read_file", { path: "tracked.txt" })],
    [text("## Goal\nG")], [text("end")],
  ];
  const t = loop(script, { compactAt: 1000, root: repo });
  assert.equal((await t.done).status, "passed");
  const ask = JSON.stringify(t.fake.requests[2].messages.at(-1));
  for (const h of ["## Goal", "## Done", "## Decisions", "## Key facts", "## Left", "## Next step"]) assert.ok(ask.includes(h), h);
  const first = t.fake.requests[3].messages[0].content[0];
  const msg = first.type === "text" ? first.text : "";
  assert.match(msg, /git status --short\):\n M tracked\.txt\n\?\? fresh\.txt/);
  assert.match(msg, /-old line\n\+new line/);
  assert.match(msg, /Files you had read \(re-read only what you need; the Key facts above may be enough\): tracked\.txt, big\.txt\n\nFull history/);
  assert.ok(msg.indexOf("Key facts") < 0 || msg.indexOf("git diff") > msg.indexOf("Summary:"));

  // A huge diff is cut and points at git diff.
  writeFileSync(join(repo, "big.txt"), "y".repeat(20_000) + "\n");
  const t2 = loop([[use("r", "read_file", { path: "big.txt" })], [use("r", "shell", { command: "true" })], [text("S")], [text("end")]], { compactAt: 1000, root: repo });
  await t2.done;
  const m2 = (t2.fake.requests[3].messages[0].content[0] as { text: string }).text;
  assert.match(m2, /\[diff truncated at 12000 chars; run git diff for the rest\]/);
});

test("compaction outside a git repo has no state section", async () => {
  const t = loop([[use("r", "shell", { command: "true" })], [use("r", "shell", { command: "true" })], [text("S")], [text("end")]], { compactAt: 1000 });
  assert.equal((await t.done).status, "passed");
  const msg = (t.fake.requests[3].messages[0].content[0] as { text: string }).text;
  assert.doesNotMatch(msg, /git diff|git status|Files you had read/);
});
