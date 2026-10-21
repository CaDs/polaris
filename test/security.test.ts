import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills } from "../server/agent/context.ts";
import { writeWorkspaceSkills } from "../server/skills.ts";
import { hostExec, isProtected, readAt, refuseSymlinks, runTool, spill, tools, toolsFor, writeAt } from "../server/agent/tools.ts";
import { runAgent } from "../server/agent/loop.ts";
import { fakeProvider } from "../server/agent/providers/fake.ts";
import { addWorktree, changedLines, changedPaths, commitAll, git, nestedRepos, protectedChanges, restore, snapshot } from "../server/git.ts";

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

test("host git never runs a nested repo's filter, and commitAll refuses nested repos", async () => {
  const base = tmp("sec-nested-");
  const repo = repoWith(join(base, "repo"));
  const wt = join(base, "wt");
  const sha = await addWorktree(repo, "main", wt, "polaris/nested");
  // What the agent can do in the sandbox: a repo of its own with a clean filter, then a change git must re-hash.
  const marker = join(base, "MARKER");
  const sub = repoWith(join(wt, "sub"));
  sh(sub, `git config filter.x.clean "sh -c 'touch ${marker}; cat'" && echo '* filter=x' > .gitattributes && git add -A && git -c user.name=t -c user.email=t@t commit -q -m f`);
  sh(sub, "sleep 1 && echo changed >> a && rm -f " + marker);

  assert.deepEqual(await nestedRepos(wt), ["sub/"]);
  await changedPaths(wt, sha);
  await changedLines(wt, sha);
  await protectedChanges(wt, sha, ["tests/"]);
  await restore(wt, await snapshot(wt));
  await assert.rejects(commitAll(wt, "msg"), /nested git repositories: sub\//);
  // Second layer: a gitlink that did reach the index (one appeared after the gate) is not recursed into either.
  await git(wt, ["add", "-A"]);
  await git(wt, ["diff", "--name-only", sha]);
  await git(wt, ["status", "--porcelain"]);
  assert.equal(existsSync(marker), false, "the nested repo's filter ran on the host");
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

test("file tools refuse FIFOs and oversized files without blocking the event loop (POL-6)", async () => {
  const root = tmp("sec-fifo-");
  execFileSync("mkfifo", [join(root, "p")]);
  writeFileSync(join(root, "big"), ""), truncateSync(join(root, "big"), 1024 ** 3); // sparse: costs no disk
  const t0 = Date.now();
  for (const [name, input] of [["read_file", { path: "p" }], ["edit_file", { path: "p", old_string: "x", new_string: "y" }], ["edit_file", { path: "p", old_string: "", new_string: "y" }]] as const) {
    const r = await call(root, name, input);
    assert.match(JSON.stringify(r), /not a regular file/);
  }
  assert.match(JSON.stringify(await call(root, "read_file", { path: "big" })), /file too large/);
  assert.ok(Date.now() - t0 < 1000);
  // changedLines counts neither (and does not hang on the FIFO)
  repoWith(root + "-repo");
  const repo = root + "-repo";
  const base = sh(repo, "git rev-parse HEAD");
  execFileSync("mkfifo", [join(repo, "q")]);
  writeFileSync(join(repo, "big"), ""), truncateSync(join(repo, "big"), 1024 ** 3);
  writeFileSync(join(repo, "n.txt"), "1\n2\n");
  assert.equal(await changedLines(repo, base), 2);
});

// The parent-dir race: `a` flips between a real dir and a symlink to a dir outside, while the tools hammer a/x.
test("a parent dir swapped for a symlink never lets a file tool touch a file outside the root (POL-7)", async () => {
  const outside = tmp("sec-race-out-");
  writeFileSync(join(outside, "x"), "SENTINEL");
  const root = tmp("sec-race-");
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real/x"), "inside");
  // The swapper is its own process: a loop in this thread could never interleave with the (synchronous) tool I/O.
  const swapper = spawn("sh", ["-c", `while :; do rm -rf a; ln -s '${outside}' a; rm a; mkdir a; echo inside > a/x; done`], { cwd: root, stdio: "ignore" });
  let leaked = 0;
  for (let i = 0; i < 2000; i++) {
    const r = JSON.stringify(await call(root, "read_file", { path: "a/x" }));
    if (r.includes("SENTINEL")) leaked++;
    await call(root, "edit_file", { path: "a/x", old_string: "SENTINEL", new_string: "PWNED" });
    await call(root, "edit_file", { path: "a/x", old_string: "inside", new_string: "edited" });
  }
  swapper.kill();
  assert.equal(leaked, 0);
  assert.equal(readFileSync(join(outside, "x"), "utf8"), "SENTINEL");
  assert.deepEqual(readdirSync(outside), ["x"]);
});

test("a symlinked .polaris fails skill/wiki setup and nothing outside is touched (POL-20)", () => {
  const target = tmp("sec-polaris-target-");
  mkdirSync(join(target, "workspace-skills"));
  writeFileSync(join(target, "workspace-skills/keep.md"), "keep");
  const root = tmp("sec-polaris-");
  symlinkSync(target, join(root, ".polaris"));
  assert.throws(() => writeWorkspaceSkills("ws-none", root), /\.polaris in the repository is a symlink/);
  assert.throws(() => refuseSymlinks(root, ".polaris/wiki"), /symlink/);
  assert.deepEqual(readdirSync(target), ["workspace-skills"]);
  assert.equal(readFileSync(join(target, "workspace-skills/keep.md"), "utf8"), "keep");
  // a symlinked child, and a fine tree
  const r2 = tmp("sec-polaris-");
  mkdirSync(join(r2, ".polaris"));
  symlinkSync(target, join(r2, ".polaris/wiki"));
  assert.throws(() => refuseSymlinks(r2, ".polaris/wiki"), /\.polaris\/wiki in the repository is a symlink/);
  refuseSymlinks(r2, ".polaris/workspace-skills"); // absent: fine
});

test("skills that are symlinks leaving the checkout are skipped (POL-20)", () => {
  const outside = tmp("sec-skill-out-");
  writeFileSync(join(outside, "secret.md"), "---\nname: stolen\ndescription: host file\n---\n");
  const root = tmp("sec-skill-");
  mkdirSync(join(root, ".polaris/skills"), { recursive: true });
  writeFileSync(join(root, ".polaris/skills/ok.md"), "---\nname: ok\ndescription: fine\n---\n");
  symlinkSync(join(outside, "secret.md"), join(root, ".polaris/skills/x.md"));
  assert.deepEqual(listSkills(root, "worker").map((s) => s.name), ["ok"]);
  rmSync(join(root, ".polaris/skills"), { recursive: true });
  symlinkSync(outside, join(root, ".polaris/skills"));
  assert.deepEqual(listSkills(root, "worker"), []);
});
