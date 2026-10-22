import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The project memory: a passing run proposes entries (one model call), the approval writes what the human confirmed, the
// entries reach every later run, a newer entry supersedes an older one, and humans add entries directly. Demo provider:
// "REMEMBER: <title>" in a ticket proposes a decision, "SUPERSEDE: <path>" makes it replace that entry.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "3";
const { call, db, events, projectOf, sh, task, waitFor, fileTicket, workspace: base } = await import("./helpers.ts");
const { lintDir, memoryMeta, memorySection, wikiDir } = await import("../server/wiki.ts");
const { memoryItems } = await import("../server/memory.ts");

const wiki = (cookie: string, path = "") => `/api/projects/${projectOf(cookie)}/wiki${path}`;

async function workspace(name: string, extra = {}) {
  const w = await base(name, { test_command: "", model_review: false, auto_split: false, ...extra });
  const file = (p: string) => sh(wikiDir(w.project.id), `git show HEAD:${p}`);
  const log = () => sh(wikiDir(w.project.id), "git log --format=%s").split("\n").filter(Boolean).reverse();
  const ticket = async (title: string, spec = "") => {
    const t = (await fileTicket(w.cookie, { title, spec })).body;
    await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
    const done = await waitFor(w.cookie, t.id, "review");
    return { t, run: done.runs[0] };
  };
  const approve = (id: string, body?: object) => call("POST", `/api/tickets/${id}/approve`, w.cookie, body);
  return { ...w, file, log, ticket, approve };
}

const entry = (o: Record<string, string> = {}) =>
  `---\ntitle: ${o.title ?? "Use tabs"}\nkind: ${o.kind ?? "decision"}\nstatus: ${o.status ?? "active"}\n${o.superseded_by ? `superseded_by: ${o.superseded_by}\n` : ""}source: ${o.source ?? "WIK-1"}\ndate: ${o.date ?? "2026-10-23"}\n---\nBody.\n`;

test("memory entries: frontmatter, layout and supersede links are checked; they need no index line", () => {
  assert.deepEqual(memoryMeta(entry()), { title: "Use tabs", kind: "decision", status: "active", superseded_by: "", source: "WIK-1", date: "2026-10-23" });
  assert.match(memoryMeta(entry({ kind: "opinion" })) as string, /kind must be one of decision, rule, gotcha/);
  assert.match(memoryMeta(entry({ status: "superseded" })) as string, /superseded_by/);
  assert.match(memoryMeta(entry({ date: "yesterday" })) as string, /date/);
  assert.match(memoryMeta(entry({ source: "" })) as string, /source/);

  const dir = mkdtempSync(join(tmpdir(), "memory-lint-"));
  mkdirSync(join(dir, "memory"));
  for (const [f, text] of [["SCHEMA.md", "s\n"], ["log.md", "# Log\n"], ["index.md", "# Index\n"]]) writeFileSync(join(dir, f), text);
  writeFileSync(join(dir, "memory/0001-use-tabs.md"), entry({ status: "superseded", superseded_by: "memory/0002-use-spaces.md" }));
  assert.deepEqual(lintDir(dir), ["memory/0001-use-tabs.md: superseded_by memory/0002-use-spaces.md does not exist"]);
  writeFileSync(join(dir, "memory/0002-use-spaces.md"), entry({ title: "Use spaces" }));
  assert.deepEqual(lintDir(dir), []);
  writeFileSync(join(dir, "memory/notes.md"), entry());
  writeFileSync(join(dir, "memory/0003-big.md"), entry() + "x".repeat(3000));
  assert.deepEqual(lintDir(dir), [
    "memory/notes.md: not allowed (only root .md files, modules/*.md, howto/*.md and memory/NNNN-slug.md)",
    "memory/0003-big.md is 3091 chars (at most 3000)",
  ]);
});

test("validation of proposed or confirmed entries", () => {
  const ok = { kind: "rule", title: "Never push to main", body: "Changes go through a pull request." };
  assert.deepEqual(memoryItems([ok], []), [ok]);
  assert.deepEqual(memoryItems([{ ...ok, supersedes: "" }], []), [ok]);
  assert.match(memoryItems({}, []) as string, /must be a list/);
  assert.match(memoryItems([ok, ok, ok, ok], []) as string, /at most 3/);
  assert.match(memoryItems([{ ...ok, kind: "wish" }], []) as string, /kind/);
  assert.match(memoryItems([{ ...ok, title: "two\nlines" }], []) as string, /title/);
  assert.match(memoryItems([{ ...ok, body: "" }], []) as string, /body/);
  assert.match(memoryItems([{ ...ok, supersedes: "memory/0009-gone.md" }], ["memory/0001-a.md"]) as string, /supersedes must be the path of an active entry/);
  assert.match(memoryItems([{ ...ok, supersedes: "memory/0001-a.md" }, { ...ok, supersedes: "memory/0001-a.md" }], ["memory/0001-a.md"]) as string, /same one/);
});

test("the agents' section lists active entries, newest first, and stops at its cap", () => {
  const e = (n: number, status: "active" | "superseded" = "active") =>
    ({ path: `memory/${String(n).padStart(4, "0")}-e.md`, title: `Entry ${n}`, kind: "decision" as const, status, superseded_by: "", source: "WIK-1", date: "2026-10-23" });
  assert.equal(memorySection([]), "");
  assert.equal(memorySection([e(1, "superseded")]), "");
  const s = memorySection([e(2), e(1, "superseded")]);
  assert.match(s, /^# Project memory\n\nDecisions, rules and gotchas approved for this project\./);
  assert.match(s, /\n\n- decision: Entry 2 \(\.polaris\/wiki\/memory\/0002-e\.md, WIK-1\)$/);
  const many = memorySection(Array.from({ length: 200 }, (_, i) => e(200 - i)));
  assert.match(many, /- … \d+ older entries: search \.polaris\/wiki\/memory$/);
  assert.ok(many.length < 6600);
});

let w: Awaited<ReturnType<typeof workspace>>;

test("a passing run proposes; approving writes it; the next run's worker and reviewer get it", async () => {
  w = await workspace("mem1", { model_review: true });
  const { t, run } = await w.ticket("Indentation", "Reindent the notes.\n\nREMEMBER: Use tabs for indentation");
  const proposal = events(run.id).find((e) => e.type === "memory_proposal")!.p;
  assert.deepEqual(proposal, { items: [{ kind: "decision", title: "Use tabs for indentation", body: "Recorded by the demo memory proposer." }] });
  const usage = db.prepare("SELECT purpose, background FROM usage_ledger WHERE run_id = ? AND purpose = 'memory'").get(run.id) as { purpose: string; background: number };
  assert.deepEqual({ ...usage }, { purpose: "memory", background: 1 });

  assert.equal((await w.approve(t.id)).status, 200); // no body: the proposal as it is
  const path = "memory/0001-use-tabs-for-indentation.md";
  assert.match(w.file(path), /^---\ntitle: Use tabs for indentation\nkind: decision\nstatus: active\nsource: MEM-1\ndate: \d{4}-\d\d-\d\d\n---\nRecorded by the demo memory proposer\.$/);
  assert.match(w.log().at(-1)!, /^memory: MEM-1 Indentation \(merge [0-9a-f]{8}\)$/);
  assert.match(w.file("log.md"), new RegExp(`\\] memory \\| MEM-1 Indentation \\(merge [0-9a-f]{8}\\): ${path}$`));
  const written = events(run.id).find((e) => e.type === "memory")!.p;
  assert.deepEqual([written.paths, written.commit], [[path], sh(wikiDir(w.project.id), "git rev-parse HEAD")]);
  assert.deepEqual((await call("GET", wiki(w.cookie), w.cookie)).body.memory.map((m: any) => [m.path, m.status, m.source]), [[path, "active", "MEM-1"]]);

  const next = await w.ticket("Another change");
  const starts = events(next.run.id).filter((e) => e.type === "run_started").map((e) => e.p.task as string);
  assert.equal(starts.length, 2); // the worker, then the reviewer
  for (const s of starts) assert.match(s, /# Project memory\n\n[^\n]+\n\n- decision: Use tabs for indentation \(\.polaris\/wiki\/memory\/0001-use-tabs-for-indentation\.md, MEM-1\)\n/);
  assert.deepEqual(events(next.run.id).find((e) => e.type === "memory_proposal")!.p, { items: [] }); // nothing new to remember
  await call("POST", `/api/tickets/${next.t.id}/reject`, w.cookie, {});
});

test("the approver's edits win: changed text, an unticked entry (an empty list) writes nothing, invalid input is a 400", async () => {
  const a = await w.ticket("Edited", "REMEMBER: Something the reviewer rewrites");
  const bad = await w.approve(a.t.id, { memory: [{ kind: "rule", title: "", body: "x" }] });
  assert.deepEqual([bad.status, bad.body.error], [400, "memory[0].title must be one line of at most 160 chars"]);
  assert.equal((await w.get(a.t.id)).status, "review");
  assert.equal((await w.approve(a.t.id, { memory: [{ kind: "rule", title: "Never push to main", body: "Changes go through a pull request." }] })).status, 200);
  assert.match(w.file("memory/0002-never-push-to-main.md"), /^---\ntitle: Never push to main\nkind: rule\n[\s\S]*\nChanges go through a pull request\.$/);

  const before = w.log().length;
  const b = await w.ticket("Unticked", "REMEMBER: Nobody wants this");
  assert.equal((await w.approve(b.t.id, { memory: [] })).status, 200);
  assert.equal(w.log().length, before);
  assert.equal(events(b.run.id).some((e) => e.type === "memory"), false);
});

test("a newer entry supersedes an older one: the old stays, marked, and leaves the agents' section", async () => {
  const { t, run } = await w.ticket("Spaces", "REMEMBER: Use spaces for indentation\nSUPERSEDE: memory/0001-use-tabs-for-indentation.md");
  assert.equal(events(run.id).find((e) => e.type === "memory_proposal")!.p.items[0].supersedes, "memory/0001-use-tabs-for-indentation.md");
  assert.equal((await w.approve(t.id)).status, 200);
  assert.match(w.file("memory/0001-use-tabs-for-indentation.md"), /\nstatus: superseded\nsuperseded_by: memory\/0003-use-spaces-for-indentation\.md\n/);
  assert.match(w.file("memory/0003-use-spaces-for-indentation.md"), /\nstatus: active\n/);
  const { run: next } = await w.ticket("After spaces");
  const first = task(next.id);
  assert.match(first, /- decision: Use spaces for indentation/);
  assert.doesNotMatch(first, /Use tabs/);
  // A superseded entry can't be superseded again.
  const again = await w.ticket("Again", "REMEMBER: Use tabs again\nSUPERSEDE: memory/0001-use-tabs-for-indentation.md");
  assert.match(events(again.run.id).find((e) => e.type === "memory_proposal")!.p.error, /supersedes must be the path of an active entry/);
});

test("Remember this: a human adds an entry (source: their email); bad input is a 400; the wiki off is a 409", async () => {
  const x = await workspace("mem2");
  const r = await call("POST", wiki(x.cookie, "/memory"), x.cookie, { kind: "rule", title: "Ask before deleting data", body: "Destructive actions need a person's yes." });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.paths, ["memory/0001-ask-before-deleting-data.md"]);
  assert.match(x.file(r.body.paths[0]), /\nkind: rule\nstatus: active\nsource: mem2@x\.dev\n/);
  assert.match(x.log().at(-1)!, /^memory: added by mem2@x\.dev$/);
  const bad = await call("POST", wiki(x.cookie, "/memory"), x.cookie, { kind: "wish", title: "x", body: "y" });
  assert.deepEqual([bad.status, bad.body.error], [400, "kind must be one of decision, rule, gotcha"]);
  // A human can also edit an entry like any page (checked the same way).
  const body = (await call("GET", wiki(x.cookie, `/page?path=${r.body.paths[0]}`), x.cookie)).body.body as string;
  assert.equal((await call("PUT", wiki(x.cookie, "/page"), x.cookie, { path: r.body.paths[0], body: body.replace("kind: rule", "kind: wish") })).status, 400);
  assert.equal((await call("PUT", wiki(x.cookie, "/page"), x.cookie, { path: r.body.paths[0], body: `${body}One more line.\n` })).status, 200);

  await x.settings({ wiki: false });
  assert.equal((await call("POST", wiki(x.cookie, "/memory"), x.cookie, { kind: "rule", title: "x", body: "y" })).status, 409);
});
