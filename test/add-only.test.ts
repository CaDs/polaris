import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// POL-29 add-only protection: the projects column, the gate's diff check, the agent file tools, and the prompts.
process.env.POLARIS_PROVIDER = "fake";
const { call, db, events: all, fileTicket, sh, tempRepo, until, user, workspace } = await import("./helpers.ts");
const { hostExec, runTool, toolsFor, wikiTools } = await import("../server/agent/tools.ts");
const { addWorktree, protectedChanges, protectedFilesAt } = await import("../server/git.ts");
const { plannerTask } = await import("../server/planner.ts");
const { protectedLines } = await import("../server/runs.ts");

const files = { "README.md": "hi\n", "tests/existing.txt": "keep\n", "docs/a.md": "x\n" };

test("migration and validation: existing projects stay read_only, new ones are add_only, a bad value is a 400", async () => {
  const me = await user("ao-api");
  const repo = tempRepo();
  const post = (extra: object) => call("POST", "/api/projects", me, { name: "P", key: "PAA", repo_path: repo, ...extra });
  const made = await post({});
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.protected_mode, "add_only");
  assert.match((await post({ key: "PAB", protected_mode: "sometimes" })).body.error, /protected_mode must be one of/);
  const patched = await call("PATCH", `/api/projects/${made.body.id}`, me, { protected_mode: "read_only" });
  assert.equal(patched.body.protected_mode, "read_only");
  assert.equal((await call("PATCH", `/api/projects/${made.body.id}`, me, { protected_mode: "x" })).status, 400);
  assert.equal((await call("PATCH", `/api/projects/${made.body.id}`, me, { protected_mode: null })).body.protected_mode, "add_only"); // null = default
  // A row from before the column (no value) reads back read_only.
  db.prepare("INSERT INTO projects (id, workspace_id, key, name, repo_path, base_branch) SELECT 'old', workspace_id, 'OLD', 'Old', repo_path, 'main' FROM projects WHERE id = ?").run(made.body.id);
  assert.equal((await call("GET", "/api/projects/old", me)).body.protected_mode, "read_only");
});

test("protectedChanges: add_only allows added files and edits of the run's own, fails M/D/T and renames of existing ones", async () => {
  const repo = tempRepo(files);
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "ao-wt-"))), "wt");
  const sha = await addWorktree(repo, "main", wt, "polaris/ao");
  const run = (cmd: string) => sh(wt, cmd);
  const check = (mode = "add_only") => protectedChanges(wt, sha, ["tests"], mode, [".polaris/x"]);
  run("mkdir -p tests && echo n > tests/new.test.ts && echo a > tests/own.txt && echo b >> tests/own.txt");
  assert.deepEqual(await check(), []);
  assert.deepEqual((await check("read_only")).sort(), ["tests/new.test.ts", "tests/own.txt"]);
  run("echo c >> tests/existing.txt");
  assert.deepEqual(await check(), ["tests/existing.txt"]);
  run("git checkout tests/existing.txt && rm tests/existing.txt");
  assert.deepEqual(await check(), ["tests/existing.txt"]);
  run("git checkout tests/existing.txt && mv tests/existing.txt tests/moved.txt");
  assert.deepEqual(await check(), ["tests/existing.txt"]); // the add of moved.txt is fine, the delete is not
  run("git checkout tests/existing.txt && rm tests/moved.txt && ln -s ../README.md tests/existing.txt.tmp && rm tests/existing.txt && ln -s ../README.md tests/existing.txt");
  assert.deepEqual(await check(), ["tests/existing.txt"]); // type change
  run("rm tests/existing.txt && git checkout tests/existing.txt && mkdir -p .polaris && echo x > .polaris/x");
  assert.deepEqual(await check(), [".polaris/x"]); // fixed paths bind in both modes
  assert.deepEqual([...(await protectedFilesAt(wt, sha, ["tests"]))], ["tests/existing.txt"]);
});

test("file tools in add_only mode: new files yes, existing protected ones no, .git and fixed paths always", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ao-tools-")));
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, ".polaris/wiki"), { recursive: true });
  writeFileSync(join(root, "tests/existing.txt"), "keep\n");
  const ctx = { root, exec: hostExec, protectedPaths: [".polaris/wiki"], addOnly: { paths: ["tests"], existing: new Set(["tests/existing.txt"]) } };
  const call = (name: string, input: Record<string, unknown>) => runTool([...toolsFor("openai"), ...toolsFor(), ...wikiTools], { type: "tool_use", id: "t", name, input }, ctx);
  assert.match((await call("edit_file", { path: "tests/new.txt", old_string: "", new_string: "n\n" })).content, /created/);
  assert.match((await call("edit_file", { path: "tests/new.txt", old_string: "n", new_string: "m" })).content, /edited/); // its own file
  for (const r of [
    await call("edit_file", { path: "tests/existing.txt", old_string: "keep", new_string: "x" }),
    await call("delete_file", { path: "tests/existing.txt" }),
    await call("apply_patch", { patch: "*** Begin Patch\n*** Delete File: tests/existing.txt\n*** End Patch" }),
    await call("apply_patch", { patch: "*** Begin Patch\n*** Update File: tests/existing.txt\n@@\n-keep\n+x\n*** End Patch" }),
  ]) assert.match(r.content, /existed before this run under a protected path: add new files instead of changing it/);
  assert.match((await call("apply_patch", { patch: "*** Begin Patch\n*** Add File: tests/n2.txt\n+a\n*** End Patch" })).content, /added|Added|n2/i);
  for (const path of [".polaris/wiki/x", ".git/config", "tests/.git/config"])
    assert.match((await call("edit_file", { path, old_string: "", new_string: "x" })).content, /read-only \(protected path\)/);
});

test("the worker, planner and gate-fix messages describe the mode", () => {
  assert.deepEqual(protectedLines(["tests"], "add_only", [".polaris/wiki"]), [
    "- Protected paths (add new files there, e.g. regression tests; changing or deleting existing files fails the run): tests",
    "- Read-only paths (changes there fail the run): .polaris/wiki",
  ]);
  assert.deepEqual(protectedLines(["tests"], "read_only", [".polaris/wiki"]), ["- Read-only paths (changes there fail the run): tests, .polaris/wiki"]);
  assert.deepEqual(protectedLines([], "add_only"), []);
  const epic = { id: "e", workspace_id: "w", key: "E-1", title: "t", spec: "", parent_id: null, provider_id: null, model: null };
  const o = { repo: "r", base: "main", sha: "abcdef12", gate: "npm test", sizeHint: "", autoSplit: false, protectedPaths: ["tests"], skills: [], round: 1, notes: [], since: 0 };
  assert.match(plannerTask(epic, { ...o, protectedMode: "add_only" }), /changing or deleting existing files under tests fails it \(new files there/);
  assert.match(plannerTask(epic, { ...o, protectedMode: "read_only" }), /changes under tests fail it/);
});

// Gate through real runs with the demo provider: the ticket's PROT-* word picks what its shell does to tests/.
const { cookie: me, repo, settings } = await workspace("aogate", { test_command: "test -f notes.txt", protected_paths: "tests", protected_mode: "add_only", model_review: false, auto_split: false, wiki: false });
sh(repo, "mkdir -p tests && echo keep > tests/existing.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m tests");
const run = async (title: string) => {
  const t = (await fileTicket(me, { title })).body;
  assert.equal((await call("POST", `/api/tickets/${t.id}/runs`, me)).status, 201);
  const done = await until("review or failed", async () => {
    const x = (await call("GET", `/api/tickets/${t.id}`, me)).body;
    return ["review", "failed"].includes(x.status) && x;
  });
  const gates = all(done.runs[0].id).filter((e) => e.type === "test_result").map((e) => e.p);
  return { status: done.status, gates, reason: all(done.runs[0].id).find((e) => e.type === "run_finished")?.p.reason as string };
};

test("gate, add_only: adding tests passes; editing, deleting or renaming an existing one fails; a run's own file may be edited", async () => {
  await settings();
  for (const word of ["PROT-ADD", "PROT-OWN"]) { const r = await run(`${word} change`); assert.equal(r.status, "review", JSON.stringify(r)); }
  for (const [word, path] of [["PROT-EDIT", "tests/existing.txt"], ["PROT-DEL", "tests/existing.txt"], ["PROT-MV", "tests/existing.txt"]]) {
    const r = await run(`${word} change`);
    assert.equal(r.status, "failed", word);
    assert.deepEqual(r.gates[0].protected, [path], word);
    assert.match(r.reason, new RegExp(`modified protected path ${path}`));
  }
});

test("gate, read_only: any change under a protected path fails, new files too", async () => {
  await settings({ protected_mode: "read_only" });
  const r = await run("PROT-ADD again");
  assert.equal(r.status, "failed");
  assert.deepEqual(r.gates[0].protected, ["tests/new.test.ts"]);
});
