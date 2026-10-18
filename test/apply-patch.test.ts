import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExec, runTool, tools, toolsFor } from "../server/agent/tools.ts";

const root = mkdtempSync(join(tmpdir(), "patch-"));
const outside = mkdtempSync(join(tmpdir(), "patch-out-"));
symlinkSync(outside, join(root, "link"));
mkdirSync(join(root, "tests"));
writeFileSync(join(root, "tests/t.js"), "keep\n");
const ctx = { root, exec: hostExec, protectedPaths: ["tests"] };
const patch = (body: string) => runTool(toolsFor("openai"), { type: "tool_use", id: "t", name: "apply_patch", input: { patch: `*** Begin Patch\n${body}\n*** End Patch` } }, ctx);
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("tool sets per family", () => {
  const names = (k?: string) => toolsFor(k).map((t) => t.def.name);
  assert.deepEqual(names("openai"), ["read_file", "apply_patch", "shell", "search"]);
  for (const k of ["anthropic", "ollama", undefined]) assert.deepEqual(names(k), tools.map((t) => t.def.name));
});

test("add, multi-hunk update, delete", async () => {
  assert.equal((await patch("*** Add File: src/a.txt\n+one\n+two\n+three\n+four\n+five\n+six")).is_error, false);
  assert.equal(read("src/a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  const r = await patch("*** Update File: src/a.txt\n@@\n one\n-two\n+TWO\n three\n@@ four\n five\n-six\n+SIX\n+seven");
  assert.equal(r.is_error, false, r.content);
  assert.equal(read("src/a.txt"), "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n");
  writeFileSync(join(root, "b.txt"), "x\n");
  assert.equal((await patch("*** Delete File: b.txt\n*** Add File: c.txt\n+c")).content, "deleted b.txt\nadded c.txt");
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(read("c.txt"), "c\n");
});

test("a hunk that does not apply fails clearly and writes nothing", async () => {
  const before = read("src/a.txt");
  const r = await patch("*** Add File: new.txt\n+n\n*** Update File: src/a.txt\n@@\n one\n-nope\n+x");
  assert.equal(r.kind, "InvalidArguments");
  assert.match(r.content, /hunk 1 does not apply/);
  assert.match(r.content, /nope/);
  assert.equal(read("src/a.txt"), before);
  assert.equal(existsSync(join(root, "new.txt")), false);
  assert.match((await patch("*** Update File: missing.txt\n@@\n-a\n+b")).content, /file not found/);
  assert.match((await patch("*** Add File: c.txt\n+x")).content, /already exists/);
  assert.equal((await runTool(toolsFor("openai"), { type: "tool_use", id: "t", name: "apply_patch", input: { patch: "garbage" } }, ctx)).kind, "InvalidArguments");
});

test("paths outside the root and protected paths are rejected", async () => {
  for (const p of ["../x.txt", "link/x.txt", "/etc/passwd"]) {
    const r = await patch(`*** Add File: ${p}\n+pwned`);
    assert.match(r.content, /outside the workspace/, p);
  }
  assert.equal(existsSync(join(outside, "x.txt")), false);
  for (const op of ["*** Add File: tests/new.js\n+x", "*** Delete File: tests/t.js", "*** Update File: tests/t.js\n@@\n-keep\n+gone"])
    assert.match((await patch(op)).content, /protected path/, op);
  assert.equal(read("tests/t.js"), "keep\n");
});

test("a trailing blank line in a hunk is ignored; a whitespace-fuzzy match keeps the file's context lines", async () => {
  writeFileSync(join(root, "p.txt"), "one\ntwo\nthree\n");
  const r = await patch("*** Update File: p.txt\n@@\n one\n-two\n+TWO\n");
  assert.equal(r.is_error, false, r.content);
  assert.equal(read("p.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(root, "ind.ts"), "function f() {\n    const a = 1;\n    return a;\n}\n");
  assert.equal((await patch("*** Update File: ind.ts\n@@\n  const a = 1;\n-  return a;\n+    return a + 1;")).is_error, false);
  assert.equal(read("ind.ts"), "function f() {\n    const a = 1;\n    return a + 1;\n}\n");
});
