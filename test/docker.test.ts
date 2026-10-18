import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Real Docker sandbox. Skipped when `docker info` fails (no daemon). The first run builds agent-harness-sandbox:1.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "docker-data-"));
delete process.env.HARNESS_SANDBOX;
const { openSandbox, removeStaleContainers, SANDBOX_IMAGE } = await import("../server/sandbox.ts");

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
let skip: string | false = false;
try {
  docker("info", "--format", "{{.ServerVersion}}");
} catch {
  skip = "docker is not available";
}

test("container per run: /work mount, read-only protected dirs, in-container kill, removal", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  writeFileSync(join(wt, "a.txt"), "from host\n");
  mkdirSync(join(wt, "tests"));
  writeFileSync(join(wt, "tests/t.txt"), "keep\n");
  const sb = await openSandbox(randomUUID(), wt, ["tests", "evals"], SANDBOX_IMAGE);
  const run = (command: string, timeoutMs = 30_000, signal?: AbortSignal) => sb.exec(command, { cwd: wt, timeoutMs, signal });
  try {
    assert.match(docker("inspect", "-f", "{{index .Config.Labels \"agent-harness\"}}", sb.name), /^1$/);
    const r = await run("pwd; cat a.txt; echo made > b.txt; which git rg");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\/work\nfrom host\n/);
    assert.match(r.stdout, /git\n.*rg/s);
    assert.equal(readFileSync(join(wt, "b.txt"), "utf8"), "made\n");

    const ro = await run("echo pwned > tests/t.txt");
    assert.notEqual(ro.code, 0);
    assert.match(ro.stderr, /Read-only file system/);
    assert.equal(readFileSync(join(wt, "tests/t.txt"), "utf8"), "keep\n");

    const sleeping = () => docker("exec", sb.name, "ps", "-eo", "args").split("\n").filter((l) => /^sleep 3\d$/.test(l.trim()));
    // Timeout: the in-container process group is killed, not just the local docker CLI.
    const t0 = Date.now();
    const slow = await run("sleep 30 & sleep 31; echo never", 1000);
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - t0 < 10_000);
    assert.doesNotMatch(slow.stdout, /never/);
    assert.deepEqual(sleeping(), []);

    // Abort, including one that fires before the pid file exists.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    await run("sleep 30", 60_000, ac.signal);
    const early = new AbortController();
    early.abort();
    await run("sleep 31", 60_000, early.signal);
    assert.deepEqual(sleeping(), []);
  } finally {
    await sb.close();
  }
  assert.equal(docker("ps", "-aq", "--filter", `name=${sb.name}`), "");
});

test("startup sweep removes stale containers of this data dir only", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  const mine = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE);
  const other = `harness-other-${randomUUID()}`;
  docker("run", "-d", "--name", other, "--label", "agent-harness=1", "--label", "agent-harness.data=/elsewhere", SANDBOX_IMAGE, "sleep", "infinity");
  try {
    await removeStaleContainers();
    assert.equal(docker("ps", "-aq", "--filter", `name=${mine.name}`), "");
    assert.notEqual(docker("ps", "-aq", "--filter", `name=${other}`), "");
  } finally {
    docker("rm", "-f", other);
  }
});

test("git works read-only inside the sandbox of a worktree", { skip, timeout: 600_000 }, async () => {
  const { addWorktree } = await import("../server/git.ts");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "docker-repo-")));
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init"], { cwd: repo });
  const wt = join(process.env.HARNESS_DATA_DIR!, "wt-git");
  await addWorktree(repo, "main", wt, "harness/git-test");
  const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE);
  const run = (command: string) => sb.exec(command, { cwd: wt, timeoutMs: 30_000 });
  try {
    writeFileSync(join(wt, "a.txt"), "changed\n");
    const r = await run("git log --oneline -1 && git status --short && git diff --stat");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /init\n M a\.txt\n a\.txt \| 2/);
    assert.notEqual((await run("git -c user.name=t -c user.email=t@t commit -qam x")).code, 0); // the harness commits, not the agent
  } finally {
    await sb.close();
  }
});
