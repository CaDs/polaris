import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
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
  assert.equal((await call("read_file", { path: "d/f.txt" })).content, "1\t$& c a\n2\t");
});

test("read_file numbers every line; /work/... paths (the sandbox mount) resolve to the workspace", async () => {
  mkdirSync(join(root, "r"));
  writeFileSync(join(root, "r/long.txt"), Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join("\n"));
  const r = await call("read_file", { path: "r/long.txt", offset: 5, limit: 10 });
  const lines = r.content.split("\n");
  assert.equal(lines[0], "5\tL5");
  assert.equal(lines[1], "6\tL6");
  assert.equal(lines[5], "10\tL10");
  assert.match(r.content, /lines 5-14 of 25/);
  assert.equal((await call("read_file", { path: "/work/r/long.txt", limit: 1 })).content.split("\n")[0], "1\tL1");
  assert.match((await call("read_file", { path: "/work/../x" })).content, /outside the workspace/);
  assert.match((await call("read_file", { path: "/workx/r/long.txt" })).content, /outside the workspace/);
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

test("a bad input shape says which input the tool expects; other InvalidArguments do not", async () => {
  const r = await call("shell", { cmd: "ls" });
  assert.equal(r.kind, "InvalidArguments");
  assert.match(r.content, /"command" must be a string\nExpected input: \{command: string, timeout\?: number\}$/);
  assert.doesNotMatch((await call("read_file", { path: "../x" })).content, /Expected input/);
  assert.doesNotMatch((await call("read_file", { path: "no-such-file" })).content, /Expected input/);
});

test("read_file: an offset past the end, an empty file and a binary file say so", async () => {
  writeFileSync(join(root, "five.txt"), "1\n2\n3\n4\n5");
  const past = await call("read_file", { path: "five.txt", offset: 9 });
  assert.equal(past.kind, "InvalidArguments");
  assert.match(past.content, /offset 9 is past the end of five\.txt \(5 lines\)/);
  assert.equal((await call("read_file", { path: "five.txt", offset: -2 })).content, "4\t4\n5\t5"); // from the end
  assert.equal((await call("read_file", { path: "five.txt", offset: -99 })).content.split("\n")[0], "1\t1");
  writeFileSync(join(root, "empty.txt"), "");
  assert.equal((await call("read_file", { path: "empty.txt" })).content, "(empty file)");
  writeFileSync(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 10]));
  const bin = await call("read_file", { path: "img.png" });
  assert.equal(bin.kind, "InvalidArguments");
  assert.match(bin.content, /img\.png is a binary file/);
});

test("edit_file matches a CRLF file and keeps its line endings", async () => {
  writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\nc\r\n");
  const r = await call("edit_file", { path: "crlf.txt", old_string: "a\nb", new_string: "x\ny" });
  assert.equal(r.is_error, false, r.content);
  assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), "x\r\ny\r\nc\r\n");
});

test("search still returns its matches when some file can't be read", async () => {
  mkdirSync(join(root, "sr"));
  writeFileSync(join(root, "sr/ok.txt"), "needle\n");
  writeFileSync(join(root, "sr/locked.txt"), "needle\n");
  chmodSync(join(root, "sr/locked.txt"), 0);
  const r = await call("search", { pattern: "needle", path: "sr" });
  assert.equal(r.is_error, false, r.content);
  assert.match(r.content, /sr\/ok\.txt:1:needle/);
  assert.match(r.content, /locked\.txt: Permission denied/);
});

test("shell: a UTF-8 character split across output chunks survives; timeout 0 means the default", async () => {
  const r = await call("shell", { command: "printf '\\342\\202'; sleep 0.2; printf '\\254 done'" });
  assert.match(r.content, /stdout:\n€ done\n/);
  const z = await call("shell", { command: "echo hi", timeout: 0 });
  assert.equal(z.is_error, false, z.content);
});

test("truncated tool output never ends with half of a surrogate pair", async () => {
  writeFileSync(join(root, "emoji.txt"), "x" + "😀".repeat(20_000));
  const r = await call("read_file", { path: "emoji.txt" });
  assert.match(r.content, /chars truncated/);
  assert.ok(r.content.isWellFormed());
});
