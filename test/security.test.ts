import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExec, isProtected, readAt, runTool, spill, tools, toolsFor, writeAt } from "../server/agent/tools.ts";
import { runAgent } from "../server/agent/loop.ts";
import { fakeProvider } from "../server/agent/providers/fake.ts";
import { addWorktree, changedPaths, commitAll, git } from "../server/git.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const repoWith = (dir: string) => (mkdirSync(dir, { recursive: true }), sh(dir, "git init -q -b main && echo hi > a && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"), dir);
// A fsmonitor "hook" that leaves a marker when git runs it.
function fsmonitor(dir: string) {
  const marker = join(dir, "MARKER");
  writeFileSync(join(dir, "hook.sh"), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(dir, "hook.sh"), 0o755);
  return { hook: join(dir, "hook.sh"), marker };
}
const call = (root: string, name: string, input: Record<string, unknown>, protectedPaths: string[] = [], all = tools) =>
  runTool(all, { type: "tool_use", id: "t", name, input }, { root, exec: hostExec, protectedPaths });

test("agent tools never write .git (file, dir, nested), whatever the case", async () => {
  const root = tmp("sec-git-");
  writeFileSync(join(root, ".git"), "gitdir: /somewhere\n");
  mkdirSync(join(root, "sub/.git"), { recursive: true });
  for (const [path, old_string] of [[".git", "gitdir"], ["./.git", "gitdir"], ["sub/.git/config", ""], ["sub/.git/hooks/pre-commit", ""], ["wiki/.git/config", ""]]) {
    const r = await call(root, "edit_file", { path, old_string, new_string: "gitdir: /tmp/evil\n" });
    assert.equal(r.kind, "InvalidArguments", path);
    assert.match(r.content, /read-only/, path);
  }
  const del = await call(root, "apply_patch", { patch: "*** Begin Patch\n*** Delete File: .git\n*** End Patch" }, [], toolsFor("openai"));
  assert.match(del.content, /read-only/);
  assert.equal(existsSync(join(root, ".git")), true);
  assert.equal(existsSync(join(root, "sub/.git/config")), false);
});

test("case-insensitive filesystem: TESTS/ is tests/, .GIT is .git", { skip: process.platform !== "darwin" }, async () => {
  const root = tmp("sec-case-");
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, ".git"), "gitdir: /somewhere\n");
  for (const path of ["TESTS/x.txt", "Tests/new/x.txt"]) {
    const r = await call(root, "edit_file", { path, old_string: "", new_string: "x" }, ["tests"]);
    assert.match(r.content, /read-only/, path);
  }
  assert.match((await call(root, "edit_file", { path: ".GIT", old_string: "gitdir", new_string: "gitdir: /tmp/evil" })).content, /read-only/);
  assert.deepEqual(readdirSync(join(root, "tests")), []);
  assert.equal(isProtected("TESTS/x.txt", ["tests"]), true); // the gate's check on git's paths
});

test("host git ignores a hostile .git pointer in the worktree and never runs its fsmonitor", async () => {
  const base = tmp("sec-wt-");
  const repo = repoWith(join(base, "repo"));
  const wt = join(base, "wt");
  const sha = await addWorktree(repo, "main", wt, "polaris/x");
  const evil = repoWith(join(base, "evil"));
  const { hook, marker } = fsmonitor(base);
  sh(evil, `git config core.fsmonitor '${hook}'`);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  writeFileSync(join(wt, "new.txt"), "x\n");
  assert.deepEqual(await changedPaths(wt, sha), ["new.txt"]);
  const commit = await commitAll(wt, "msg");
  assert.equal(existsSync(marker), false, "fsmonitor ran on the host");
  assert.equal(sh(repo, "git rev-parse polaris/x"), commit, "committed in the real repository");
});

test("host git never runs a repo-local core.fsmonitor", async () => {
  const dir = tmp("sec-fsm-");
  const { hook, marker } = fsmonitor(dir);
  const r = repoWith(join(dir, "r"));
  sh(r, `git config core.fsmonitor '${hook}'`);
  await git(r, ["status", "--porcelain"]);
  assert.equal(existsSync(marker), false);
});

test("spill refuses a planted symlink (dir or file) and writes nothing outside", () => {
  const outside = tmp("sec-out-");
  const big = "x".repeat(9000);
  const r1 = tmp("sec-spill-");
  mkdirSync(join(r1, ".polaris"));
  symlinkSync(outside, join(r1, ".polaris/outputs"));
  assert.throws(() => spill({ root: r1, exec: hostExec, turn: 1, tool: "shell", callId: "c" }, big));
  const r2 = tmp("sec-spill-");
  mkdirSync(join(r2, ".polaris/outputs"), { recursive: true });
  symlinkSync(join(outside, "f.txt"), join(r2, ".polaris/outputs/1-shell-c.txt"));
  assert.throws(() => spill({ root: r2, exec: hostExec, turn: 1, tool: "shell", callId: "c" }, big));
  assert.deepEqual(readdirSync(outside), []);
});

// The swap race: a symlink planted after resolveIn checked the path (resolveIn returned the real, link-free path).
test("file tools never follow a symlink swapped in after the path was checked", () => {
  const outside = tmp("sec-out-");
  writeFileSync(join(outside, "secret.txt"), "secret");
  const r = tmp("sec-swap-");
  symlinkSync(join(outside, "secret.txt"), join(r, "a.txt"));
  symlinkSync(join(outside, "new.txt"), join(r, "b.txt"));
  assert.throws(() => readAt(join(r, "a.txt")), /symlink/);
  assert.throws(() => writeAt(join(r, "a.txt"), "pwned"), /symlink/);
  assert.throws(() => writeAt(join(r, "b.txt"), "pwned"), /symlink/);
  assert.deepEqual(readdirSync(outside), ["secret.txt"]);
  assert.equal(readAt(join(outside, "secret.txt"))!.toString(), "secret");
});

test("compaction refuses a planted .polaris/history symlink and writes nothing outside", async () => {
  const outside = tmp("sec-out-");
  const root = tmp("sec-hist-");
  const shell = (id: string, command: string) => [{ type: "tool_use" as const, id, name: "shell", input: { command } }];
  const fake = fakeProvider(
    [shell("c1", `mkdir -p .polaris && ln -s '${outside}' .polaris/history`), shell("c2", "true"), [{ type: "text", text: "S" }], [{ type: "text", text: "done" }]],
    (req) => ({ input: 100 * req.messages.length, output: 20, cache_read: 300 * req.messages.length, cache_write: 0 }),
  );
  const r = await runAgent({ provider: fake.provider, model: "fake", system: "s", task: "T", tools, root, compactAt: 1000, budget: { maxTurns: 20, maxTokens: 1e6 }, onEvent: () => {} });
  assert.equal(r.status, "failed");
  assert.deepEqual(readdirSync(outside), []);
});
