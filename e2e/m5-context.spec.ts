import { test, expect, type Route } from "@playwright/test";
import { git, newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

test("M5: spilled output, compaction, skills, cache hit rate and the Usage page", async ({ page }) => {
  test.setTimeout(180_000);
  // A committed skill the run should be offered.
  const repo = tempRepo({ ".polaris/skills/lint.md": "---\nname: lint\ndescription: How to run the linter\n---\nRun npm run lint.\n" });
  await signUp(page, "Context");

  // Settings: repo, a gate that needs the demo agent's notes.txt, and a tiny compaction cap.
  await saveSettings(page, repo, "test -f notes.txt", async () => {
    await expect(page.getByLabel("Compact at (tokens)")).toHaveValue("150000");
    await page.getByLabel("Compact at (tokens)").fill("1000");
    await page.getByLabel("Model review before human review").uncheck(); // this spec counts the worker's tokens
  });
  await expect(page.getByLabel("Compact at (tokens)")).toHaveValue("1000");

  // Provider dialog: context window with a per-kind default.
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  const window = dialog.locator("input[name=context_window]");
  await expect(window).toHaveValue("1000000");
  await dialog.getByLabel("Kind").selectOption("ollama");
  await expect(window).toHaveValue(""); // ollama: auto-detected
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A session that prints 4000 lines and then crosses the compaction threshold.
  await newTicket(page, "Long session", "please compact along the way");
  await openTicket(page, "Long session");
  await page.getByRole("button", { name: "Run agent" }).click();

  const transcript = page.getByRole("region", { name: "Transcript" });
  await expect(transcript.getByLabel("Skills offered")).toContainText("lint");
  await expect(transcript).toContainText("Output too long: saved to .polaris/outputs/1-shell-1.txt");
  const divider = transcript.getByRole("separator");
  await expect(divider).toContainText("Context compacted (#1)");
  await expect(divider).toContainText(".polaris/history/1.md");
  await expect(transcript).toContainText("Summary: printed the numbers");
  await expect(transcript).toContainText("Tests passed", { timeout: 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 15_000 });

  // Cache hit rate: 75% in the runs table and the transcript header.
  await expect(page.getByRole("table").locator("tbody tr").first()).toContainText("75%");
  await expect(transcript.getByLabel("Token usage")).toContainText("cache hit 75%");

  // Run metrics and stuck notes. The demo run never gets stuck, so a nudge is always injected into the replay;
  // run_metrics (and the runs' metrics) only while the server does not produce them, so this also passes unmocked.
  const metrics = {
    turns: 6, tool_calls: 5, tool_errors: 1, repeated_calls: 0, repeated_reads: 0, compactions: 1, first_edit_turn: 3, files_changed: 1,
    turns_pct: 12, minutes_pct: null, input: 400, output: 80, cache_read: 1200, stuck: null,
  };
  const sse = (e: object) => `data: ${JSON.stringify(e)}`;
  const events = async (route: Route) => {
    const chunks = (await (await route.fetch()).text()).split("\n\n").filter(Boolean);
    const at = (type: string) => chunks.findIndex((c) => c.includes(`"type":"${type}"`));
    chunks.splice(at("tool_call") + 1, 0, sse({ seq: 9001, type: "stuck", payload: { turn: 2, signal: "repeat_call", detail: "same shell call 3 times", action: "nudge" } }));
    if (at("run_metrics") < 0) chunks.splice(at("run_finished"), 0, sse({ seq: 9002, type: "run_metrics", payload: metrics }));
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: chunks.join("\n\n") + "\n\n" });
  };
  const detail = async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const t = await res.json();
    for (const r of t.runs) r.metrics ??= metrics;
    await route.fulfill({ response: res, json: t });
  };
  await page.route("**/api/runs/*/events", events);
  await page.route("**/api/tickets/*", detail);
  await page.reload();
  await expect(transcript.getByLabel("Run metrics")).toHaveText(/^\d+ turns? \(\d+%\) · \d+ tool calls? · \d+ errors? · \d+ repeated · (first edit at turn \d+|no edits)/);
  const stuck = transcript.getByRole("note", { name: "Stuck" });
  await expect(stuck).toHaveClass(/\bwarn\b/);
  await expect(stuck).toContainText("Stuck at turn 2, nudged · repeat_call");
  await expect(stuck).toContainText("same shell call 3 times");
  await expect(page.getByRole("table").locator("tbody tr").first().getByTitle(/^\d+ turns? \(\d+%\) · /)).toContainText(/\d+ turns? · \d+ err/);
  await page.setViewportSize({ width: 390, height: 844 }); // phone width: the Metrics column does not push the page sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.unroute("**/api/runs/*/events", events);
  await page.unroute("**/api/tickets/*", detail);

  // The diff has the real change and none of the harness's scratch files; skills stay in the repo.
  const diff = page.getByLabel("Diff");
  await expect(diff).toContainText("notes.txt");
  await expect(diff).not.toContainText(".polaris");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("done");
  expect(git(repo, "ls-tree", "-r", "--name-only", "main")).toBe(".polaris/skills/lint.md\nREADME.md\nnotes.txt");

  // Usage page. The Runs section is driven by a mocked /api/metrics, so its numbers are exact.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const row = { cancelled: 0, stuck: 0, mean_files_changed: null };
  await page.route((u) => u.pathname === "/api/metrics", (r) => r.fulfill({ json: { days: 14, rows: [
    { ...row, day: yesterday, model: "demo", runs: 1, passed: 1, failed: 0, measured: 1, sum_turns_pct: 60, tool_calls: 20, tool_errors: 1, mean_files_changed: 4 },
    { ...row, day: today, model: "demo", runs: 4, passed: 2, failed: 1, cancelled: 1, measured: 4, sum_turns_pct: 120, tool_calls: 40, tool_errors: 4, mean_files_changed: 2 },
    { ...row, day: today, model: "other-model", runs: 2, passed: 0, failed: 2, stuck: 2, measured: 2, sum_turns_pct: 200, tool_calls: 0, tool_errors: 0 },
  ] } }));
  await page.getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  const totals = page.getByRole("region", { name: "Totals" });
  await expect(totals).toContainText("Cache hit rate");
  await expect(totals).toContainText("75%");
  await expect(totals).toContainText("Tokens in");
  const days = page.getByRole("region", { name: "Per day" });
  await expect(days.locator("tbody tr")).toHaveCount(14);
  await expect(days.locator("tbody tr").first()).toContainText(new Date().toISOString().slice(0, 10));
  await expect(days.locator("tbody tr").first()).toContainText("75%");
  await expect(page.getByRole("region", { name: "Per model" })).toContainText("demo");
  await expect(page.getByRole("region", { name: "Top tickets" })).toContainText("CON-1");
  await expect(page.getByRole("region", { name: "Top tickets" })).toContainText("Long session");

  // Runs: per model pass rate, stuck, mean turns %, tool-error rate, mean files (weighted by runs); bars by status per day.
  const runs = page.getByRole("region", { name: "Runs" });
  await expect(runs.locator("tbody tr")).toHaveCount(2);
  await expect(runs.locator("tbody tr").nth(0).locator("td")).toHaveText(["demo", "5", "75%", "0", "36%", "8.3%", "2.4"]);
  await expect(runs.locator("tbody tr").nth(1).locator("td")).toHaveText(["other-model", "2", "0%", "2", "100%", "—", "—"]);
  const bars = runs.getByRole("img", { name: "Runs per day by status, last 14 days" });
  await expect(bars.locator("> div")).toHaveCount(14);
  await expect(bars.getByTitle(today)).toHaveAttribute("title", `${today}: 2 passed, 1 failed, 2 stuck, 1 cancelled`);
  await expect(bars.getByTitle(yesterday)).toHaveAttribute("title", `${yesterday}: 1 passed, 0 failed, 0 stuck, 0 cancelled`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Spending caps: a monthly cap in Settings, its bar on the Usage page, a ticket over it fails with the reason; an epic's cap", async ({ page }) => {
  test.setTimeout(120_000);
  const repo = tempRepo();
  await signUp(page, "Capped");
  // The demo worker's first call uses 520 tokens and leaves the gate failing (no ok.txt): its fix round is over the cap.
  await saveSettings(page, repo, "test -f ok.txt", async () => {
    await expect(page.getByLabel("Monthly cap (tokens)")).toHaveValue("");
    await page.getByLabel("Monthly cap (tokens)").fill("500");
    await page.getByLabel("Model review before human review").uncheck();
  });
  await expect(page.getByLabel("Monthly cap (tokens)")).toHaveValue("500");

  await page.getByRole("link", { name: "Usage" }).click();
  const cap = page.getByRole("region", { name: "Spending cap" });
  await expect(cap).toContainText("Tokens: 0 of 500");

  await newTicket(page, "Over budget", "GATE-FIX-ONCE");
  await openTicket(page, "Over budget");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("failed", { timeout: 60_000 });
  const month = new Date().toISOString().slice(0, 7);
  const transcript = page.getByRole("region", { name: "Transcript" });
  await expect(transcript).toContainText("Tests failed");
  await expect(transcript).toContainText(`SpendingCap: spending cap reached: workspace ${month} tokens 520/500`);
  await expect(transcript).toContainText(`Run failed (SpendingCap: spending cap reached: workspace ${month} tokens 520/500) after 4 turns.`);
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1); // not retried

  await page.getByRole("link", { name: "Usage" }).click();
  await expect(cap).toContainText("Tokens: 520 of 500 — reached, new runs are refused");
  await expect(cap.getByRole("meter", { name: "Tokens cap used" })).toHaveAttribute("aria-valuenow", "100");

  // An epic's own cap, edited in its header: "spent … of …" over its whole tree (nothing yet).
  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Capped epic", undefined, (d) => d.getByRole("radio", { name: "Epic" }).check());
  await openTicket(page, "Capped epic");
  await page.getByLabel("Epic cap (tokens)").fill("1000");
  await page.getByLabel("Epic cap (tokens)").blur();
  await expect(page.getByLabel("Epic cap", { exact: true })).toHaveText("spent 0 of 1.0k tokens");
  await page.reload();
  await expect(page.getByLabel("Epic cap (tokens)")).toHaveValue("1000");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
