import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bench grader (bench/run.ts) on L1 without a model: base fails, base + answer key passes, and a branch that rewrote
// the locked test to pass trivially still fails (the grader restores it). Real Docker; skipped without a daemon.
process.env.POLARIS_DATA_DIR = mkdtempSync(join(tmpdir(), "bench-grade-data-"));
delete process.env.POLARIS_SANDBOX;
const { applyKey, grade, LEVELS, prepare, SETUP } = await import("../bench/run.ts");

let skip: string | false = false;
try {
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"]);
} catch {
  skip = "docker is not available";
}

test("bench grader: locked tests decide, the agent's copy of them does not", { skip, timeout: 600_000 }, async () => {
  const l1 = LEVELS.find((l) => l.level === "L1")!;
  const repo = prepare(l1);
  try {
    applyKey(l1, repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("checkout", "-q", "-b", "tampered", "main");
    writeFileSync(join(repo, l1.test_files[0]), 'import { test } from "node:test";\ntest("ok", () => {});\n');
    git("commit", "-qam", "make the locked test pass");
    // Only the locked test, with the target's own test env (its full suite is what the bench runs; ~70s more each).
    const script: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.test;
    const command = `${SETUP} && ${script.replace("'test/**/*.test.ts'", l1.test_files.join(" "))}`;
    const [base, key, tampered] = [await grade(l1, repo, "main", command), await grade(l1, repo, "key", command), await grade(l1, repo, "tampered", command)];
    assert.equal(key.pass, true, key.tail);
    assert.equal(base.pass, false);
    assert.equal(tampered.pass, false);
    assert.match(tampered.tail, /status/); // the real locked test ran
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("bench --provider: Ollama by default; API-key providers read the key from the environment; the plan is refused", async () => {
  const { providerBody } = await import("../bench/run.ts");
  const o = { provider: "ollama", ollama: "http://localhost:11434" };
  assert.deepEqual(providerBody(o, {}), { name: "Ollama", kind: "ollama", base_url: "http://localhost:11434" });
  assert.deepEqual(providerBody({ ...o, provider: "anthropic" }, { ANTHROPIC_API_KEY: " sk-ant-x " }), { name: "anthropic", kind: "anthropic", auth_type: "api_key", api_key: "sk-ant-x" });
  assert.deepEqual(providerBody({ ...o, provider: "openai", "api-key-env": "MY_KEY" }, { MY_KEY: "sk-y" }), { name: "openai", kind: "openai", auth_type: "api_key", api_key: "sk-y" });
  assert.throws(() => providerBody({ ...o, provider: "openai" }, {}), /needs an API key in \$OPENAI_API_KEY/);
  assert.throws(() => providerBody({ ...o, provider: "openai", "api-key-env": "sk-pasted-by-mistake" }, {}), (e: Error) => /variable named by --api-key-env is empty/.test(e.message) && !e.message.includes("sk-pasted"));
  assert.throws(() => providerBody({ ...o, provider: "chatgpt" }, {}), /ChatGPT plan can't be benchmarked/);
  assert.throws(() => providerBody({ ...o, provider: "litellm" }, {}), /needs --base-url/);
  assert.deepEqual(providerBody({ ...o, provider: "litellm", "base-url": "http://127.0.0.1:4000" }, {}), { name: "litellm", kind: "litellm", auth_type: "none", base_url: "http://127.0.0.1:4000" });
});
