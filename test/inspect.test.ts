import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// POL-29: POST /api/projects/inspect: repo detection states, branches, protected-path candidates, command suggestions.
process.env.POLARIS_PROVIDER = "fake";
const { call, sh, tempRepo, user } = await import("./helpers.ts");
const me = await user("ins");
const inspect = (repo_path: string, base_branch?: string) => call("POST", "/api/projects/inspect", me, { repo_path, base_branch });

const files = (n: number, dir: string, ext = "a.test.ts") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/${i}${ext.slice(1)}`, "x\n"]));

test("detection states", async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "plain-")));
  const repo = tempRepo({ "sub/a.txt": "x\n" });
  const fresh = realpathSync(mkdtempSync(join(tmpdir(), "fresh-")));
  sh(fresh, "git init -q -b main");
  let r = await inspect(join(plain, "nope"));
  assert.deepEqual([r.status, r.body.state], [400, "not_found"]);
  r = await inspect(plain);
  assert.deepEqual([r.status, r.body.state], [400, "not_a_repo"]);
  r = await inspect(join(repo, "sub"));
  assert.deepEqual([r.status, r.body.state, r.body.root], [400, "inside_repo", repo]);
  assert.match(r.body.error, /use its root/);
  assert.equal((await inspect(fresh)).body.state, "no_commits");
  assert.equal((await inspect("relative/path")).status, 400);
});

test("ok: branches by last commit, current, run branches left out; suggestions from the base branch only", async () => {
  const repo = tempRepo({
    ...files(3, "test"), "e2e/x.spec.ts": "x\n", "package-lock.json": "{}", "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    ...files(3, "src/util", "a.test.ts"), "src/a.ts": "x\n", "top.test.js": "x\n", "docs/readme.md": "x\n",
  });
  sh(repo, "git checkout -q -b feature && GIT_COMMITTER_DATE=2099-01-01T00:00:00 git -c user.name=t -c user.email=t@t commit -q --allow-empty -m 'later work' && git branch polaris/POL-1-1-abcd && git checkout -q main");
  sh(repo, "echo dirty > test/dirty.txt"); // working tree is never read
  const r = (await inspect(repo)).body;
  assert.equal(r.state, "ok");
  assert.equal(r.current, "main");
  assert.equal(r.base_branch, "main");
  assert.deepEqual(r.branches.map((b: any) => [b.name, b.current]), [["feature", false], ["main", true]]);
  assert.ok(!r.branches.some((b: any) => b.name.startsWith("polaris/")));
  assert.equal(r.branches.find((b: any) => b.name === "feature").subject, "later work");
  const byPath = Object.fromEntries(r.protected.map((c: any) => [c.path, c]));
  assert.deepEqual(byPath["test/"], { path: "test/", files: 3, pattern: "*.test.ts", suggested: true });
  assert.equal(byPath["e2e/"].suggested, true);
  assert.equal(byPath["src/util/"].files, 3);
  assert.deepEqual(byPath["top.test.js"], { path: "top.test.js", files: 1, pattern: "*.test.js", suggested: false });
  assert.ok(!byPath["docs/"] && !byPath["src/"]);
  assert.deepEqual([r.setup_command, r.test_command], [{ value: "npm ci", why: "package-lock.json" }, { value: "npm test", why: "package.json scripts.test" }]);
  assert.equal((await inspect(repo, "nope")).body.base_exists, false);
});

test("command suggestions by lockfile; npm's default test script is no test", async () => {
  const pnpm = (await inspect(tempRepo({ "pnpm-lock.yaml": "x", "package.json": JSON.stringify({ scripts: { test: "vitest" } }) }))).body;
  assert.deepEqual([pnpm.setup_command.value, pnpm.test_command.value], ["pnpm install --frozen-lockfile", "pnpm test"]);
  const none = (await inspect(tempRepo({ "package-lock.json": "{}", "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }))).body;
  assert.deepEqual([none.setup_command.value, none.test_command], ["npm ci", null]);
  assert.deepEqual([(await inspect(tempRepo({ "go.mod": "x" }))).body.test_command.value, (await inspect(tempRepo())).body.setup_command], ["go test ./...", null]);
});

test("nothing in the repository is executed or written: a nested repo's filter leaves no marker", async () => {
  const repo = tempRepo({ "test/a.test.ts": "x\n" });
  const marker = join(repo, "marker");
  sh(repo, `git config filter.evil.clean 'touch ${marker}' && echo '* filter=evil' > .gitattributes && git config core.fsmonitor 'touch ${marker}'`);
  mkdirSync(join(repo, "nested/.git"), { recursive: true });
  writeFileSync(join(repo, "test/b.test.ts"), "dirty\n");
  assert.equal((await inspect(repo)).body.state, "ok");
  assert.equal(existsSync(marker), false);
});

test("check_paths: protected paths with no file at the base branch come back as missing", async () => {
  const repo = tempRepo({ "test/a.test.ts": "x\n", "e2e.config.ts": "x\n" });
  const r = (await call("POST", "/api/projects/inspect", me, { repo_path: repo, check_paths: ["test/", "evals", "e2e", "e2e.config.ts"] })).body;
  assert.deepEqual(r.missing, ["evals", "e2e"]);
});
