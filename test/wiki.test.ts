import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// M10: the per-project wiki: lint, snapshot + staleness in every run, serialized ingest after approve, bootstrap/lint runs,
// human edits, the wiki setting. POLARIS_SANDBOX=host (no docker), demo provider as the maintainer.
process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_CONCURRENCY = "3";
const { configure, fileTicket, projectOf, call, db, events, idle, sh, task, tempRepo, until, user, waitFor, workspace: base, wsOf } = await import("./helpers.ts");
const { runTool, wikiTools } = await import("../server/agent/tools.ts");
const { ensureWiki, finishCopy, frontmatter, lintDir, openCopy, wikiDir, wikiSerial, WIKI_PROTECTED } = await import("../server/wiki.ts");

const GIT = "git -c user.name=t -c user.email=t@t";

// The routes of the session's project wiki.
const wiki = (cookie: string, path = "") => `/api/projects/${projectOf(cookie)}/wiki${path}`;

// A workspace whose gate passes without a command (the demo worker writes notes.txt, identical in every ticket). pid: its
// project, whose id keys the wiki.
async function workspace(name: string, extra = {}) {
  const { cookie, repo, ws, get, project } = await base(name, { test_command: "", model_review: false, auto_split: false, ...extra });
  const pid = project.id;
  const wikiLog = () => {
    try {
      return sh(wikiDir(pid), "git log --format=%s").split("\n").filter(Boolean).reverse(); // oldest first
    } catch {
      return []; // not initialized yet
    }
  };
  const wikiFile = (p: string) => sh(wikiDir(pid), `git show HEAD:${p}`);
  // Creates a ticket, runs it to review.
  const ticket = async (title: string, spec = "") => {
    const t = (await fileTicket(cookie, { title, spec })).body;
    await call("POST", `/api/tickets/${t.id}/runs`, cookie);
    const done = await waitFor(cookie, t.id, "review");
    return { t, run: done.runs[0] };
  };
  const approve = async (id: string) => assert.equal((await call("POST", `/api/tickets/${id}/approve`, cookie)).status, 200);
  // Waits until the wiki repo has n commits (the initial one included).
  const commits = (n: number) => until(`${n} wiki commits`, () => existsSync(wikiDir(pid)) && wikiLog().length >= n);
  return { cookie, repo, ws, pid, wikiLog, wikiFile, get, ticket, approve, commits, idle: () => idle(ws) };
}

const page = (o: { title?: string; sources?: string; verified?: string } = {}) =>
  `---\ntitle: ${o.title ?? "A page"}\nsources: ${o.sources ?? "[a.ts]"}\nverified: ${o.verified ?? "abcdef1"}\nupdated: 2026-01-01\n---\nBody.\n`;

test("frontmatter: title, sources list and a hex verified sha are required; sources must be repo-relative", () => {
  assert.deepEqual(frontmatter(page({ sources: "[a.ts, src/b.ts]" })), { title: "A page", sources: ["a.ts", "src/b.ts"], verified: "abcdef1", updated: "2026-01-01" });
  assert.deepEqual((frontmatter(page({ sources: "[]" })) as any).sources, []);
  assert.match(frontmatter("# no frontmatter\n") as string, /missing frontmatter/);
  assert.match(frontmatter("---\nsources: []\nverified: abcdef1\n---\n") as string, /title/);
  assert.match(frontmatter("---\ntitle: x\nsources: a.ts\nverified: abcdef1\n---\n") as string, /sources/);
  assert.match(frontmatter(page({ sources: "[../etc/passwd]" })) as string, /repo-relative/);
  assert.match(frontmatter(page({ sources: "[/etc/passwd]" })) as string, /repo-relative/);
  assert.match(frontmatter(page({ verified: "HEAD" })) as string, /verified/);
  assert.match(frontmatter(page({ verified: "--output=x" })) as string, /verified/);
});

test("mechanical lint: frontmatter, index links both ways, size caps, allowed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-lint-"));
  mkdirSync(join(dir, "modules"));
  const put = (p: string, text: string) => writeFileSync(join(dir, p), text);
  put("SCHEMA.md", "s\n");
  put("log.md", "# Log\n");
  put("index.md", "# Index\n- [A](overview.md) — the overview\n- [M](modules/m.md) — a module\n");
  put("overview.md", page());
  put("modules/m.md", page({ title: "M" }));
  assert.deepEqual(lintDir(dir), []);

  put("modules/m.md", "no frontmatter\n");
  assert.deepEqual(lintDir(dir), ["modules/m.md: missing frontmatter (a --- block at the top)"]);
  put("modules/m.md", page());
  put("gotchas.md", page()); // not in the index
  assert.deepEqual(lintDir(dir), ["gotchas.md is not linked from index.md"]);
  put("index.md", "# Index\n- [A](overview.md) — x\n- [M](modules/m.md) — x\n- [G](gotchas.md) — x\n- [Gone](modules/gone.md) — x\n");
  assert.deepEqual(lintDir(dir), ["index.md links to modules/gone.md, which is not a content page"]);
  put("index.md", "# Index\n- [A](overview.md) — x\n- [M](modules/m.md) — x\n- [G](gotchas.md) — x\n");
  assert.deepEqual(lintDir(dir), []);

  put("gotchas.md", page() + "x".repeat(3500));
  assert.match(lintDir(dir)[0], /^gotchas\.md is \d+ chars \(at most 3500\)/);
  put("gotchas.md", page());
  put("index.md", `# Index\n- [A](overview.md) — x\n- [M](modules/m.md) — x\n- [G](gotchas.md) — x\n${"- filler\n".repeat(800)}`);
  assert.match(lintDir(dir)[0], /^index\.md is \d+ chars \(at most 6000\)/);
  put("index.md", "# Index\n- [A](overview.md) — x\n- [M](modules/m.md) — x\n- [G](gotchas.md) — x\n");

  put("notes.txt", "x");
  mkdirSync(join(dir, "src"));
  put("src/a.md", page());
  symlinkSync("/etc/hosts", join(dir, "howto.md"));
  assert.deepEqual(lintDir(dir), [
    "howto.md: not a regular file",
    "notes.txt: not allowed (only root .md files, modules/*.md and howto/*.md)",
    "src/a.md: not allowed (only root .md files, modules/*.md and howto/*.md)",
  ]);
});

test("the maintainer can read the code and edit the wiki copy, never the code checkout", async () => {
  assert.deepEqual(wikiTools.map((t) => t.def.name), ["read_file", "edit_file", "delete_file", "search"]); // no shell, no apply_patch
  const root = mkdtempSync(join(tmpdir(), "wiki-root-"));
  mkdirSync(join(root, "code"));
  mkdirSync(join(root, "wiki/.git"), { recursive: true });
  const ctx = { root, exec: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }), protectedPaths: WIKI_PROTECTED };
  const edit = (path: string) => runTool(wikiTools, { type: "tool_use", id: "1", name: "edit_file", input: { path, old_string: "", new_string: "x" } }, ctx);
  assert.match((await edit("code/a.ts")).content, /read-only \(protected path\)/);
  assert.match((await edit("wiki/.git/config")).content, /read-only \(protected path\)/); // its config could run commands on the host
  assert.match((await edit("../escape.md")).content, /outside the workspace/);
  assert.equal((await edit("wiki/index.md")).is_error, false);
});

test("the maintainer can delete a page; the commit drops it only together with its index line", async () => {
  const repo = tempRepo();
  const sha = sh(repo, "git rev-parse HEAD");
  const ws = "wiki-delete";
  await ensureWiki(ws);
  const root = mkdtempSync(join(tmpdir(), "wiki-del-"));
  mkdirSync(join(root, "code"));
  writeFileSync(join(root, "code/a.ts"), "x");
  await openCopy(ws, join(root, "wiki"));
  mkdirSync(join(root, "wiki/modules"));
  writeFileSync(join(root, "wiki/modules/old.md"), page({ sources: "[README.md]", verified: sha }));
  writeFileSync(join(root, "wiki/index.md"), "# Index\n- [Old](modules/old.md) — going away\n");
  assert.ok("sha" in (await finishCopy(ws, join(root, "wiki"), "add old", "## add", repo)));

  const ctx = { root, exec: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }), protectedPaths: WIKI_PROTECTED };
  const del = (path: string) => runTool(wikiTools, { type: "tool_use", id: "1", name: "delete_file", input: { path } }, ctx);
  assert.match((await del("code/a.ts")).content, /read-only \(protected path\)/);
  assert.match((await del("wiki/.git/config")).content, /read-only \(protected path\)/);
  assert.match((await del("wiki/modules/none.md")).content, /file not found/);
  assert.deepEqual(await del("wiki/modules/old.md"), { content: "deleted wiki/modules/old.md", is_error: false });
  assert.equal(existsSync(join(root, "wiki/modules/old.md")), false);
  assert.deepEqual(await finishCopy(ws, join(root, "wiki"), "drop old", "## drop", repo), { problems: ["index.md links to modules/old.md, which is not a content page"] });
  writeFileSync(join(root, "wiki/index.md"), "# Index\n");
  assert.ok("sha" in (await finishCopy(ws, join(root, "wiki"), "drop old", "## drop", repo)));
  assert.equal(sh(wikiDir(ws), "git ls-files"), "SCHEMA.md\nindex.md\nlog.md");
  assert.equal(sh(wikiDir(ws), "git status --porcelain"), "");
});

let w: Awaited<ReturnType<typeof workspace>>;

test("approve → one ingest run: demo page, index, log line and commit message in the wiki repo; the ticket is untouched", async () => {
  w = await workspace("wiki1");
  const { t, run } = await w.ticket("First change", "WIKI-NOTES");
  assert.equal((await call("GET", wiki(w.cookie), w.cookie)).body.pages.length, 0);
  await w.approve(t.id);
  const merge = sh(w.repo, "git rev-parse HEAD");
  await w.commits(2);
  await w.idle();
  const sha8 = merge.slice(0, 8);
  assert.deepEqual(w.wikiLog(), ["init wiki", `ingest WIK-1: First change (merge ${sha8})`]);
  assert.match(w.wikiFile("modules/demo.md"), new RegExp(`^---\ntitle: Demo module\nsources: \\[notes\\.txt\\]\nverified: ${merge}\nupdated: \\d{4}-\\d\\d-\\d\\d\n---`));
  assert.match(w.wikiFile("index.md"), /- \[Demo module\]\(modules\/demo\.md\) — written by the demo maintainer/);
  assert.match(w.wikiFile("log.md"), new RegExp(`# Log\n\n## \\[\\d{4}-\\d\\d-\\d\\d\\] ingest \\| WIK-1 First change \\(merge ${sha8}\\)$`));

  // The run is listed in the ticket (role wiki) but changes neither its status nor its totals.
  const d = await w.get(t.id);
  assert.deepEqual([d.status, d.run_count, d.runs.map((r: any) => r.role), d.runs[1].status, d.runs[1].branch], ["done", 1, ["worker", "wiki"], "passed", null]);
  const ev = events(d.runs[1].id);
  assert.deepEqual(ev.find((e) => e.type === "wiki")!.p, { op: "ingest", commit: sh(wikiDir(w.pid), "git rev-parse HEAD") });
  assert.deepEqual(ev.filter((e) => e.type === "tool_call").map((e) => e.p.name), ["read_file", "edit_file", "edit_file"]);
  assert.equal(d.runs[1].base_sha, merge);

  // What the maintainer was given: the merged diff and files, the worker's notes, the index; system prompt = the wiki prompt.
  const first = task(d.runs[1].id);
  assert.match(first, new RegExp(`code/\` is a read-only checkout at commit ${merge}`));
  assert.match(first, /# Ticket\n\nWIK-1 First change\n\nWIKI-NOTES/);
  assert.match(first, /# Files changed\n\nnotes\.txt\n/);
  assert.match(first, /# Merged diff\n\n```diff\ndiff --git a\/notes\.txt/);
  assert.match(first, /## Wiki notes\n- notes\.txt is written by the demo agent\./);
  assert.match(first, /# Current wiki\/index\.md\n\n# Index$/);
  // Nothing was left behind.
  assert.equal(sh(w.repo, "git worktree list").split("\n").length, 1);
  assert.equal(existsSync(d.runs[1].worktree), false);
  assert.equal(sh(wikiDir(w.pid), "git status --porcelain"), "");
  assert.equal(run.role, "worker");

  // The hidden ticket does not exist for the board.
  assert.equal((await call("GET", "/api/tickets", w.cookie)).body.length, 1);
});

test("the next run sees the wiki: snapshot in .polaris/wiki, index in the first message, read-only, git-excluded", async () => {
  const { t, run } = await w.ticket("Second change");
  const first = task(run.id);
  assert.match(first, /\n\n# Project wiki\n\nRead the pages relevant to your task \(\.polaris\/wiki\/<path>\) before exploring the code; trust code over the wiki when they disagree\.\n\n- \[Demo module\]\(\.polaris\/wiki\/modules\/demo\.md\) — written by the demo maintainer\n\n# Task/);
  assert.doesNotMatch(first, /may be stale/);
  assert.match(first, /Read-only paths \(changes there fail the run\): tests, evals, \.polaris\/wiki/);
  const wt = (await w.get(t.id)).runs[0].worktree;
  assert.match(readFileSync(join(wt, ".polaris/wiki/modules/demo.md"), "utf8"), /^---\ntitle: Demo module/);
  assert.equal(sh(wt, "git status --porcelain"), ""); // the snapshot is invisible to git (the run's change is committed)
  assert.equal(sh(wt, "git ls-files"), "README.md\nnotes.txt");
  // The system prompt (worker.md) never carries it.
  const sys = db.prepare("SELECT body FROM prompts WHERE workspace_id = ? AND role = 'worker'").get(w.ws) as { body: string };
  assert.doesNotMatch(sys.body, /modules\/demo\.md/);
  assert.match(sys.body, /## Wiki notes/);
  await call("POST", `/api/tickets/${t.id}/reject`, w.cookie, {}); // frees the worktree; a reject queues no ingest
  assert.equal(w.wikiLog().length, 2);
});

test("staleness: a page whose sources changed since verified is flagged in the index and in the API; an unknown sha is stale", async () => {
  sh(w.repo, `echo more >> notes.txt && ${GIT} commit -qam "touch notes"`);
  const { run } = await w.ticket("Third change");
  assert.match(task(run.id), /- \[Demo module\]\(\.polaris\/wiki\/modules\/demo\.md\) — written by the demo maintainer ⚠ may be stale: notes\.txt\n/);
  const api = (await call("GET", wiki(w.cookie), w.cookie)).body;
  assert.deepEqual(api.pages.map((p: any) => [p.path, p.stale, p.sources]), [["modules/demo.md", "notes.txt", ["notes.txt"]]]);
  assert.deepEqual(api.problems, []);

  // Pages unrelated to the change stay unflagged: edit the page's sources to a file nobody touched.
  const body = (await call("GET", wiki(w.cookie, "/page?path=modules/demo.md"), w.cookie)).body.body as string;
  const e = await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: body.replace("sources: [notes.txt]", "sources: [README.md]") });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((await call("GET", wiki(w.cookie), w.cookie)).body.pages[0].stale, null);
});

// Commits a page straight into the wiki repo, past the checks (a page written before sources were validated).
const legacy = (ws: string, path: string, text: string) => {
  writeFileSync(join(wikiDir(ws), path), text);
  sh(wikiDir(ws), `${GIT} commit -qam legacy`);
};

test("sources and verified must exist in the project repo: unknown ones are rejected, and flagged stale on older pages", async () => {
  const body = (await call("GET", wiki(w.cookie, "/page?path=modules/demo.md"), w.cookie)).body.body as string;
  const v8 = /verified: (\w{8})/.exec(body)![1];
  const put = (text: string) => call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: text });
  const noSha = await put(body.replace(/verified: \w+/, "verified: 1234567"));
  assert.deepEqual([noSha.status, noSha.body.problems], [400, ["modules/demo.md: verified commit 1234567 is not in the project repo"]]);
  const noFile = await put(body.replace("sources: [README.md]", "sources: [README.md, nope.ts]"));
  assert.deepEqual([noFile.status, noFile.body.problems], [400, [`modules/demo.md: source nope.ts does not exist at ${v8}`]]);
  assert.equal(w.wikiFile("modules/demo.md"), body.trimEnd());
  legacy(w.pid, "modules/demo.md", body.replace("sources: [README.md]", "sources: [nope.ts]"));
  assert.equal((await call("GET", wiki(w.cookie), w.cookie)).body.pages[0].stale, `source nope.ts does not exist at ${v8}`);
  legacy(w.pid, "modules/demo.md", body.replace(/verified: \w+/, "verified: 1234567"));
  assert.equal((await call("GET", wiki(w.cookie), w.cookie)).body.pages[0].stale, "verified commit 1234567 is not in the project repo");
});

test("lint run (Refresh stale pages) re-verifies the stale pages and commits; nothing stale → 409", async () => {
  const head = sh(w.repo, "git rev-parse HEAD");
  const before = w.wikiLog().length;
  const r = await call("POST", wiki(w.cookie, "/lint"), w.cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await w.commits(before + 1);
  await w.idle();
  assert.equal(w.wikiLog().at(-1), `lint: re-verify 1 stale page at ${head.slice(0, 8)}`);
  assert.match(w.wikiFile("modules/demo.md"), new RegExp(`verified: ${head}`));
  assert.match(w.wikiFile("log.md"), /\] lint \| re-verified modules\/demo\.md at /);
  assert.equal((await call("GET", wiki(w.cookie), w.cookie)).body.pages[0].stale, null);
  const again = await call("POST", wiki(w.cookie, "/lint"), w.cookie);
  assert.deepEqual([again.status, again.body.error], [409, "No page is stale."]);
  // The run hangs off the hidden ticket: listed by the wiki API, not on the board.
  const runs = (await call("GET", wiki(w.cookie), w.cookie)).body.runs;
  assert.deepEqual([runs[0].wiki_op, runs[0].status, runs[0].ticket_key, runs[0].result.commit?.length], ["lint", "passed", null, 40]);
  assert.equal((await call("GET", "/api/tickets", w.cookie)).body.every((t: any) => t.title !== "Project wiki"), true);
});

test("history and diff of the wiki repo; bad shas are rejected", async () => {
  const h = (await call("GET", wiki(w.cookie, "/history"), w.cookie)).body;
  assert.equal(h.at(-1).subject, "init wiki");
  assert.match(h[0].subject, /^lint: re-verify 1 stale page/);
  const d = (await call("GET", wiki(w.cookie, `/diff?sha=${h[0].sha}`), w.cookie)).body.diff as string;
  assert.match(d, /^lint: re-verify/);
  assert.match(d, /diff --git a\/modules\/demo\.md[\s\S]*\+verified: /);
  assert.equal((await call("GET", wiki(w.cookie, "/diff?sha=--output=x"), w.cookie)).status, 400);
  assert.equal((await call("GET", wiki(w.cookie, "/diff?sha=0123456789"), w.cookie)).status, 404);
});

test("human edit: PUT commits 'edit <path> by <email>' with a log entry; invalid edits and bad paths commit nothing", async () => {
  const before = w.wikiLog().length;
  const body = (await call("GET", wiki(w.cookie, "/page?path=modules/demo.md"), w.cookie)).body.body as string;
  const ok = await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: `${body}\nA human added this line.` });
  assert.equal(ok.status, 200);
  assert.equal(w.wikiLog().length, before + 1);
  assert.equal(w.wikiLog().at(-1), "edit modules/demo.md by wiki1@x.dev");
  assert.match(w.wikiFile("modules/demo.md"), /A human added this line\.$/);
  assert.match(w.wikiFile("log.md"), /\] edit \| modules\/demo\.md by wiki1@x\.dev$/);
  assert.equal(sh(wikiDir(w.pid), "git status --porcelain"), "");
  // Same text again: nothing to commit.
  assert.deepEqual((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: `${body}\nA human added this line.` })).body, { unchanged: true });
  assert.equal(w.wikiLog().length, before + 1);

  const bad = await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: "no frontmatter" });
  assert.deepEqual([bad.status, bad.body.problems], [400, ["modules/demo.md: missing frontmatter (a --- block at the top)"]]);
  assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "index.md", body: "# Index\n" })).status, 400); // would unlink the demo page
  assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: page({ sources: "[../x]" }) })).status, 400);
  assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: page() + "x".repeat(3500) })).status, 400);
  for (const path of ["../x.md", "/etc/passwd", "modules/../../x.md", "modules/../index.md", "notes.txt", ".git/config", "modules/a/b.md", "src/x.md", ""]) {
    assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path, body: page() })).status, 400, `PUT ${path}`);
    assert.equal((await call("GET", wiki(w.cookie, `/page?path=${encodeURIComponent(path)}`), w.cookie)).status, 400, `GET ${path}`);
  }
  for (const path of ["log.md", "modules/new.md"]) assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path, body: page() })).status, 400, `PUT ${path}`); // the harness's, and not an existing page
  assert.equal((await call("GET", wiki(w.cookie, "/page?path=modules/none.md"), w.cookie)).status, 404);
  assert.equal(w.wikiLog().length, before + 1);
  assert.equal(sh(wikiDir(w.pid), "git status --porcelain"), "");
});

test("a human edit of a page that changed since it was opened is refused: the ingest in between is kept", async () => {
  const opened = (await call("GET", wiki(w.cookie, "/page?path=modules/demo.md"), w.cookie)).body.body as string;
  const { t } = await w.ticket("Fourth change");
  const before = w.wikiLog().length;
  await w.approve(t.id);
  await w.commits(before + 1);
  await w.idle();
  const ingested = w.wikiFile("modules/demo.md");
  assert.notEqual(ingested, opened.trimEnd());
  const late = await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: `${opened}Late line.\n`, base: opened });
  assert.deepEqual([late.status, late.body.error], [400, "modules/demo.md changed since you opened it: reload it and edit again"]);
  assert.equal(w.wikiFile("modules/demo.md"), ingested);
  const fresh = (await call("GET", wiki(w.cookie, "/page?path=modules/demo.md"), w.cookie)).body.body as string;
  assert.equal((await call("PUT", wiki(w.cookie, "/page"), w.cookie, { path: "modules/demo.md", body: `${fresh}Late line.\n`, base: fresh })).status, 200);
  assert.match(w.wikiFile("modules/demo.md"), /Late line\.$/);
});

test("other workspaces see and edit only their own wiki; each project has its own", async () => {
  const w = await workspace("wikimine");
  const x = await workspace("wiki-other");
  const api = (await call("GET", wiki(x.cookie), x.cookie)).body;
  assert.deepEqual([api.pages, api.enabled], [[], true]);
  assert.equal((await call("GET", wiki(x.cookie, "/page?path=modules/demo.md"), x.cookie)).status, 404);
  assert.match(sh(wikiDir(x.pid), "git log --format=%s"), /^init wiki$/);
  for (const [m, path] of [["GET", ""], ["GET", "/page?path=index.md"], ["PUT", "/page"], ["POST", "/bootstrap"], ["GET", "/history"]])
    assert.equal((await call(m, wiki(w.cookie, path), x.cookie, m === "PUT" ? { path: "index.md", body: "# Index\n" } : undefined)).status, 404, `${m} ${path}: another workspace's project`);
  assert.equal((await call("GET", wiki(x.cookie))).status, 401);
  assert.notEqual(wikiDir(w.pid), wikiDir(x.pid));
});

test("bootstrap writes overview.md at the base branch head; the planner and the reviewer see the index too", async () => {
  const x = await workspace("wiki2", { model_review: true });
  const r = await call("POST", wiki(x.cookie, "/bootstrap"), x.cookie);
  assert.equal(r.status, 201);
  await x.commits(2);
  await x.idle();
  assert.equal(x.wikiLog().at(-1), `bootstrap: ${sh(x.repo, "basename $PWD")} at main ${sh(x.repo, "git rev-parse --short=8 HEAD")}`);
  assert.match(x.wikiFile("overview.md"), /^---\ntitle: Overview\nsources: \[README\.md\]\nverified: [0-9a-f]{40}/);
  assert.match(x.wikiFile("log.md"), /\] ingest \| bootstrap from main \(/);

  // Reviewer: a ticket's run has a second run_started (the reviewer) whose first message carries the section.
  const { run } = await x.ticket("Reviewed");
  const starts = events(run.id).filter((e) => e.type === "run_started").map((e) => e.p.task as string);
  assert.equal(starts.length, 2);
  assert.ok(starts.every((s) => /# Project wiki\n[\s\S]*- \[Overview\]\(\.polaris\/wiki\/overview\.md\)/.test(s)));
  assert.match(starts[1], /# Change under review/);
  // Planner: an epic's round.
  const e = (await fileTicket(x.cookie, { title: "Plan it", kind: "epic" })).body;
  await call("POST", `/api/tickets/${e.id}/runs`, x.cookie);
  const round = await until("round", async () => (await x.get(e.id)).runs.find((r: any) => r.role === "planner" && r.status === "passed"));
  assert.match(task(round.id), /# Project wiki\n[\s\S]*- \[Overview\]\(\.polaris\/wiki\/overview\.md\)[\s\S]*# Epic\n\n# Plan it/);
});

test("wiki off: no snapshot, no section, no ingest, no bootstrap", async () => {
  const x = await workspace("wiki3");
  await call("POST", wiki(x.cookie, "/bootstrap"), x.cookie);
  await x.commits(2);
  await x.idle();
  assert.equal((await configure(x.cookie, { repo_path: x.repo, setup_command: "", test_command: "", wiki: false })).body.wiki, 0);
  assert.equal((await call("GET", "/api/settings", x.cookie)).body.wiki, 0);
  const { t, run } = await x.ticket("Without wiki");
  const first = task(run.id);
  assert.doesNotMatch(first, /Project wiki|\.polaris\/wiki/);
  const wt = (await x.get(t.id)).runs[0].worktree;
  assert.equal(existsSync(join(wt, ".polaris/wiki")), false);
  await x.approve(t.id);
  await x.idle();
  assert.equal((await x.get(t.id)).runs.length, 1);
  assert.equal(x.wikiLog().length, 2);
  const r = await call("POST", wiki(x.cookie, "/bootstrap"), x.cookie);
  assert.deepEqual([r.status, r.body.error], [409, "The project wiki is off. Turn it on in Settings."]);
  assert.equal((await call("GET", wiki(x.cookie), x.cookie)).body.enabled, false);
  // Omitted in a later save: unchanged.
  await configure(x.cookie, { repo_path: x.repo, setup_command: "", test_command: "" });
  assert.equal((await call("GET", "/api/settings", x.cookie)).body.wiki, 0);
});

test("ingests are serialized: two approvals in a row make two commits in order, no conflict", async () => {
  const x = await workspace("wiki4");
  const a = await x.ticket("Alpha");
  const b = await x.ticket("Beta");
  await x.approve(a.t.id);
  await x.approve(b.t.id);
  await x.commits(3);
  await x.idle();
  const log = x.wikiLog();
  assert.equal(log.length, 3);
  assert.match(log[1], /^ingest WIK-1: Alpha \(merge /);
  assert.match(log[2], /^ingest WIK-2: Beta \(merge /);
  const idx = x.wikiFile("index.md");
  assert.equal(idx.match(/modules\/demo\.md/g)!.length, 1);
  const lines = x.wikiFile("log.md").split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(lines.map((l) => l.replace(/\[.*?\] |\(merge.*/g, "").trim()), ["## ingest | WIK-1 Alpha", "## ingest | WIK-2 Beta"]);
  // The second ingest updated the page the first one created (verified = its own merge).
  assert.match(x.wikiFile("modules/demo.md"), new RegExp(`verified: ${sh(x.repo, "git rev-parse HEAD")}`));
  const runs = db.prepare("SELECT id FROM runs WHERE role = 'wiki' AND ticket_id IN (?, ?)").all(a.t.id, b.t.id) as { id: string }[];
  assert.equal(new Set(runs.map((r) => events(r.id).find((e) => e.type === "wiki")!.p.commit)).size, 2);
});

test("a wiki that fails the mechanical lint is not committed: fix rounds first, then rejected with an error event", async () => {
  const x = await workspace("wiki5");
  // WIKI-BAD: the agent never fixes the page → 3 rounds, rejected, nothing committed.
  const bad = await x.ticket("Broken wiki", "WIKI-BAD");
  await x.approve(bad.t.id);
  await x.idle();
  const run = (await x.get(bad.t.id)).runs.find((r: any) => r.role === "wiki");
  assert.equal(run.status, "failed");
  const ev = events(run.id);
  const problems = ["modules/bad.md: missing frontmatter (a --- block at the top)", "modules/bad.md is not linked from index.md"];
  assert.deepEqual(ev.find((e) => e.type === "wiki")!.p, { op: "ingest", problems });
  assert.match(ev.find((e) => e.type === "error")!.p.message, /^the wiki check failed after 2 fix rounds; nothing was committed:\nmodules\/bad\.md: missing frontmatter/);
  assert.equal(ev.filter((e) => e.type === "assistant_message").length, 4);
  assert.deepEqual(x.wikiLog(), ["init wiki"]);
  assert.equal(sh(wikiDir(x.pid), "git status --porcelain"), "");
  assert.equal(existsSync(join(wikiDir(x.pid), "modules")), false);
  assert.equal((await x.get(bad.t.id)).status, "done"); // approval stands

  // WIKI-FIXME: the check's problems go back into the same conversation and the agent repairs the page → committed.
  const fix = await x.ticket("Fixable wiki", "WIKI-FIXME");
  await x.approve(fix.t.id);
  await x.commits(2);
  await x.idle();
  const fixRun = (await x.get(fix.t.id)).runs.find((r: any) => r.role === "wiki");
  assert.equal(fixRun.status, "passed");
  const resumed = events(fixRun.id).filter((e) => e.type === "run_started");
  assert.equal(resumed.length, 2);
  assert.match(x.wikiFile("modules/bad.md"), /^---\ntitle: Bad/);
  assert.match(x.wikiLog().at(-1)!, /^ingest WIK-2: Fixable wiki /);
  assert.deepEqual((await call("GET", wiki(x.cookie), x.cookie)).body.problems, []);
});

test("a worker that writes .polaris/wiki fails the gate (protected path); edit_file refuses it too", async () => {
  const x = await workspace("wiki6");
  const t = (await fileTicket(x.cookie, { title: "Tamper", spec: "WIKI-WRITE" })).body;
  await call("POST", `/api/tickets/${t.id}/runs`, x.cookie);
  const failed = await until("failed", async () => (await x.get(t.id)).status === "failed" && (await x.get(t.id)));
  const gate = events(failed.runs[0].id).find((e) => e.type === "test_result")!.p;
  assert.deepEqual([gate.passed, gate.protected], [false, [".polaris/wiki/x"]]);
  assert.match(failed.runs[0].status, /failed/);
  const root = mkdtempSync(join(tmpdir(), "wiki-ro-"));
  mkdirSync(join(root, ".polaris/wiki"), { recursive: true });
  const r = await runTool(wikiTools, { type: "tool_use", id: "1", name: "edit_file", input: { path: ".polaris/wiki/x", old_string: "", new_string: "x" } }, { root, exec: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }), protectedPaths: [".polaris/wiki"] });
  assert.match(r.content, /read-only \(protected path\)/);
});

test("deleting a ticket is refused while its ingest run is active", async () => {
  const x = await workspace("wiki7");
  const { t } = await x.ticket("Busy");
  await x.approve(t.id);
  assert.equal((await call("DELETE", `/api/tickets/${t.id}`, x.cookie)).status, 409);
  await x.idle();
  assert.equal((await call("DELETE", `/api/tickets/${t.id}`, x.cookie)).status, 204);
});

let held: { x: Awaited<ReturnType<typeof workspace>>; a: string; b: string };
const runStatus = (id: string) => (db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;

test("a wiki run waiting for another of its workspace stays queued instead of holding a concurrency slot", async () => {
  const x = await workspace("wiki8");
  await call("POST", wiki(x.cookie, "/bootstrap"), x.cookie);
  await x.commits(2);
  await x.idle();
  sh(x.repo, `echo more >> README.md && ${GIT} commit -qam "touch readme"`);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const busy = wikiSerial(x.pid, () => gate); // e.g. a human edit in progress
  const a = await call("POST", wiki(x.cookie, "/lint"), x.cookie);
  const b = await call("POST", wiki(x.cookie, "/lint"), x.cookie); // still stale: the first has not run
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.deepEqual([runStatus(a.body.id), runStatus(b.body.id)], ["running", "queued"]);
  release();
  await busy;
  await x.idle();
  held = { x, a: a.body.id, b: b.body.id };
});

test("Refresh stale pages with nothing left to re-verify ends as passed (unchanged), not failed", async () => {
  const { x, a, b } = held;
  assert.deepEqual([runStatus(a), events(a).find((e) => e.type === "wiki")!.p.commit?.length], ["passed", 40]);
  assert.deepEqual([runStatus(b), events(b).find((e) => e.type === "wiki")!.p], ["passed", { op: "lint", unchanged: true }]);
  assert.match(x.wikiLog().at(-1)!, /^lint: re-verify 1 stale page/);
});
