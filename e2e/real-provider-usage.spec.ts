import { test, expect } from "@playwright/test";
import { addProvider, git, newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

// REAL_MODEL=qwen3.8:27b-mlx npm run e2e -- e2e/real-provider-usage.spec.ts
test("live Ollama: protected test, model review, approval and complete usage", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const repo = tempRepo({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.js" } }),
    "tests/check.test.js": "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('note.txt','utf8').trim(), 'hello');\n",
  });
  await signUp(page, "Liveusage");
  await saveSettings(page, repo, "npm test");
  await page.request.put("/api/settings", { data: { wiki: false, auto_split: false, max_turns: 20, max_minutes: 10 } });
  await addProvider(page, { name: "Local Ollama", kind: "ollama", baseUrl: "http://localhost:11434" });
  const providers = page.getByRole("region", { name: "Providers" });
  await page.getByLabel("Default provider").selectOption({ label: "Local Ollama" });
  await page.getByLabel("Default model").selectOption(process.env.REAL_MODEL!);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await newTicket(page, "Create greeting", "Create note.txt containing hello and make npm test pass. The tests/ directory is read-only; do not edit tests.");
  await openTicket(page, "Create greeting");
  await page.getByRole("button", { name: "Run agent", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue(/review|failed/, { timeout: 12 * 60_000 });
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("review");
  await expect(page.getByLabel("Diff")).toContainText("note.txt");
  const usage = await (await page.request.get("/api/usage")).json();
  expect(usage.execution.tokens_total).toBeGreaterThan(0);
  expect(usage.background.tokens_total).toBeGreaterThan(0);
  expect(usage.totals.tokens_total).toBe(usage.execution.tokens_total + usage.background.tokens_total);
  expect(usage.purposes.some((p: any) => p.purpose === "reviewer" && p.tokens_total > 0)).toBe(true);
  expect(usage.totals.unavailable).toBe(0);
  expect(usage.models.every((p: any) => p.billing_mode === "local")).toBe(true);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("done");
  expect(git(repo, "show", "main:note.txt")).toBe("hello");
  expect(git(repo, "diff", "--name-only", "HEAD~1", "HEAD")).not.toContain("tests/");
  console.log(JSON.stringify({ repo, model: process.env.REAL_MODEL, execution: usage.execution.tokens_total, background: usage.background.tokens_total, total: usage.totals.tokens_total }));
});
