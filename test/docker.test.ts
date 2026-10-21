import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Real Docker sandbox. Skipped when `docker info` fails (no daemon). The first run builds polaris-sandbox:1.
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "docker-data-"));
delete process.env.POLARIS_SANDBOX;
const { openSandbox, removeStaleContainers, SANDBOX_IMAGE } = await import("../server/sandbox.ts");
const { readOnlyPaths } = await import("../server/agent/tools.ts");

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
    assert.match(docker("inspect", "-f", "{{index .Config.Labels \"polaris\"}}", sb.name), /^1$/);
    const r = await run("pwd; cat a.txt; echo made > b.txt; which git rg");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\/work\nfrom host\n/);
    assert.match(r.stdout, /git\n.*rg/s);
    assert.equal(readFileSync(join(wt, "b.txt"), "utf8"), "made\n");
    assert.equal(statSync(join(wt, "b.txt")).uid, process.getuid!()); // the host user's, not root's (Docker Desktop maps it)

    // Non-root, no capabilities, writable HOME and npm cache: a setup command like `npm ci` works.
    const pkg = { name: "t", version: "1.0.0" };
    writeFileSync(join(wt, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(wt, "package-lock.json"), JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } }));
    const user = await run("id -u; grep CapEff /proc/self/status; npm --version && touch ~/.w ~/.npm/.w && npm ci --no-audit --no-fund");
    assert.equal(user.code, 0, user.stderr);
    assert.doesNotMatch(user.stdout, /^0\n/);
    assert.match(user.stdout, /^CapEff:\s+0{16}$/m);

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

test("a read-only path missing at start is made read-only too; add-only mode leaves it writable (POL-29)", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  const ro = await openSandbox(randomUUID(), wt, readOnlyPaths(["evals"], "read_only", [".polaris/wiki"]), SANDBOX_IMAGE);
  try {
    const r = await ro.exec("echo x > evals/new.txt", { cwd: wt, timeoutMs: 30_000 });
    assert.match(r.stderr, /Read-only file system/);
  } finally {
    await ro.close();
  }
  const wt2 = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  mkdirSync(join(wt2, "tests"));
  const add = await openSandbox(randomUUID(), wt2, readOnlyPaths(["tests"], "add_only"), SANDBOX_IMAGE);
  try {
    assert.equal((await add.exec("echo x > tests/new.txt", { cwd: wt2, timeoutMs: 30_000 })).code, 0);
    assert.equal(readFileSync(join(wt2, "tests/new.txt"), "utf8"), "x\n");
  } finally {
    await add.close();
  }
});

test("startup sweep removes stale containers of this data dir only", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  const mine = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE);
  const other = `polaris-other-${randomUUID()}`;
  docker("run", "-d", "--name", other, "--label", "polaris=1", "--label", "polaris.data=/elsewhere", SANDBOX_IMAGE, "sleep", "infinity");
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
  const wt = join(process.env.POLARIS_DATA_DIR!, "wt-git");
  await addWorktree(repo, "main", wt, "polaris/git-test");
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


// Interfaces of the container's current network namespace (/sys/class/net keeps showing the one it started in).
const NICS = "awk -F: 'NR>2{print $1}' /proc/net/dev | tr -d ' ' | grep -E '^(lo|eth)' | sort";

test("network: setup-only has one until endSetup, none never (POL-8)", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  for (const network of ["setup-only", "none"]) {
    const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE, { cpus: 1, memory_gb: 1, network });
    const run = (c: string) => sb.exec(c, { cwd: wt, timeoutMs: 30_000 });
    try {
      assert.equal((await run(NICS)).stdout.trim(), network === "none" ? "lo" : "eth0\nlo");
      await sb.endSetup();
      assert.equal((await run(NICS)).stdout.trim(), "lo");
      for (const url of ["https://example.com", "http://host.docker.internal:11434", "http://169.254.169.254"])
        assert.equal((await run(`node -e "fetch('${url}',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))"`)).code, 1, url);
    } finally {
      await sb.close();
    }
  }
  const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE, { cpus: 1, memory_gb: 1, network: "full" });
  try {
    await sb.endSetup();
    assert.equal((await sb.exec(NICS, { cwd: wt, timeoutMs: 30_000 })).stdout.trim(), "eth0\nlo");
  } finally {
    await sb.close();
  }
});

test("each repository has its own npm cache volume (POL-18)", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  const seen = async (repo: string, write: boolean) => {
    const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE, undefined, repo);
    try {
      const r = await sb.exec(`${write ? "touch ~/.npm/marker; " : ""}ls ~/.npm`, { cwd: wt, timeoutMs: 30_000 });
      assert.equal(r.code, 0, r.stderr);
      return r.stdout.includes("marker");
    } finally {
      await sb.close();
    }
  };
  const a = `/repo/a-${randomUUID()}`;
  assert.equal(await seen(a, true), true);
  assert.equal(await seen(`/repo/b-${randomUUID()}`, false), false);
  assert.equal(await seen(a, false), true);
});

test("the sandbox's git has no remotes and no host path, but log and diff work (POL-19)", { skip, timeout: 600_000 }, async () => {
  const { addWorktree } = await import("../server/git.ts");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "docker-repo-")));
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init && git remote add origin https://user:token@example.com/x.git"], { cwd: repo });
  const wt = join(process.env.POLARIS_DATA_DIR!, "wt-nogit");
  await addWorktree(repo, "main", wt, "polaris/nogit-test");
  const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE, undefined, repo);
  const run = (command: string) => sb.exec(command, { cwd: wt, timeoutMs: 30_000 });
  try {
    writeFileSync(join(wt, "a.txt"), "changed\n");
    const r = await run("git config --get-regexp remote; git log --oneline main; git diff --stat; cat /proc/self/mountinfo");
    assert.doesNotMatch(r.stdout, /remote|token/);
    assert.match(r.stdout, /init\n a\.txt \| 2/);
    assert.ok(!r.stdout.includes(repo) && !r.stdout.includes(join(repo, ".git")), "the repo's host path is in the mount table");
    assert.equal((await run("git commit -qam x; echo pwned >> .git/config")).code !== 0, true);
  } finally {
    await sb.close();
  }
});

test("hardening: orphans are reaped, the root is read-only, a runaway worktree ends the run (POL-21)", { skip, timeout: 600_000 }, async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "docker-wt-")));
  const sb = await openSandbox(randomUUID(), wt, [], SANDBOX_IMAGE);
  const run = (c: string, timeoutMs = 60_000) => sb.exec(c, { cwd: wt, timeoutMs });
  try {
    // 700 orphans that exit at once: without a reaping PID 1 their zombies fill the 512-pid limit.
    await run("for i in $(seq 700); do (sleep 0.01 &); done; sleep 1");
    assert.equal((await run("echo ok")).stdout.trim(), "ok");
    assert.notEqual((await run("touch /usr/x")).code, 0);
    assert.equal((await run("touch /tmp/x ~/y .z")).code, 0);
    process.env.POLARIS_WORKTREE_MAX_MB = "50";
    await assert.rejects(run("dd if=/dev/zero of=big bs=1M count=200 2>/dev/null; sleep 60"), /grew past 50 MB/);
    await assert.rejects(run("echo again"), /grew past 50 MB/);
  } finally {
    delete process.env.POLARIS_WORKTREE_MAX_MB;
    await sb.close();
  }
});
