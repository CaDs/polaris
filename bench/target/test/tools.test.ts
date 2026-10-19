import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExec, runTool, tools } from "../server/agent/tools.ts";

const root = mkdtempSync(join(tmpdir(), "tools-"));
const outside = mkdtempSync(join(tmpdir(), "outside-"));
writeFileSync(join(outside, "secret.txt"), "secret");
symlinkSync(outside, join(root, "link"));
symlinkSync(join(outside, "new.txt"), join(root, "dangling"));
const ctx = { root, exec: hostExec };
const call = (name: string, input: Record<string, unknown>) => runTool(tools, { type: "tool_use", id: "t", name, input }, ctx);

test("paths outside the root are rejected", async () => {
  for (const path of ["../x", join(outside, "secret.txt"), "link/secret.txt", "a/../../x"]) {
    const r = await call("read_file", { path });
    assert.equal(r.kind, "InvalidArguments", path);
    assert.match(r.content, /outside the workspace/);
  }
  const r = await call("edit_file", { path: "dangling", old_string: "", new_string: "pwned" });
  assert.equal(r.kind, "InvalidArguments");
  assert.equal(existsSync(join(outside, "new.txt")), false);
  assert.equal((await call("search", { pattern: "secret", path: "link" })).kind, "InvalidArguments");
});

test("edit_file creates, requires a unique match, and edits", async () => {
  assert.equal((await call("edit_file", { path: "d/f.txt", old_string: "", new_string: "a b a\n" })).is_error, false);
  const dup = await call("edit_file", { path: "d/f.txt", old_string: "a", new_string: "x" });
  assert.equal(dup.kind, "InvalidArguments");
  assert.match(dup.content, /occurs 2 times/);
  assert.equal((await call("edit_file", { path: "d/f.txt", old_string: "a b", new_string: "$& c" })).is_error, false);
  assert.equal((await call("read_file", { path: "d/f.txt" })).content, "1\t$& c a\n\t");
});

test("read_file numbers the first and every 10th line", async () => {
  mkdirSync(join(root, "r"));
  writeFileSync(join(root, "r/long.txt"), Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join("\n"));
  const r = await call("read_file", { path: "r/long.txt", offset: 5, limit: 10 });
  const lines = r.content.split("\n");
  assert.equal(lines[0], "5\tL5");
  assert.equal(lines[1], "\tL6");
  assert.equal(lines[5], "10\tL10");
  assert.match(r.content, /lines 5-14 of 25/);
});

test("shell captures output and exit code; timeout is classified", async () => {
  const ok = await call("shell", { command: "echo hi; echo err >&2; exit 3" });
  assert.equal(ok.is_error, false);
  assert.match(ok.content, /exit code: 3\nstdout:\nhi\n\nstderr:\nerr/);
  const t0 = Date.now();
  const slow = await call("shell", { command: "sleep 1; sleep 10", timeout: 0.3 });
  assert.equal(slow.kind, "Timeout");
  assert.ok(Date.now() - t0 < 3000, "process group killed promptly");
});

test("search finds matches and reports bad patterns", async () => {
  writeFileSync(join(root, "s.ts"), "export const needle = 1;\n");
  assert.match((await call("search", { pattern: "needle", glob: "*.ts" })).content, /s\.ts:1:export const needle/);
  assert.equal((await call("search", { pattern: "zzz_nothing" })).content, "no matches");
  assert.equal((await call("search", { pattern: "(" })).kind, "InvalidArguments");
  assert.equal((await call("nope", {})).kind, "InvalidArguments");
});

test("edit_file refuses protected paths (also via symlinks), other paths still work", async () => {
  mkdirSync(join(root, "tests"));
  symlinkSync(join(root, "tests"), join(root, "t-link"));
  const pctx = { ...ctx, protectedPaths: ["tests", "evals"] };
  const edit = (path: string) => runTool(tools, { type: "tool_use", id: "p", name: "edit_file", input: { path, old_string: "", new_string: "x" } }, pctx);
  for (const path of ["tests/a.test.ts", "./evals/e.json", "t-link/b.ts", "evals"]) {
    const r = await edit(path);
    assert.equal(r.kind, "InvalidArguments", path);
    assert.match(r.content, /read-only/);
  }
  assert.equal(existsSync(join(root, "tests/a.test.ts")), false);
  assert.equal((await edit("testsuite/ok.ts")).is_error, false);
});
