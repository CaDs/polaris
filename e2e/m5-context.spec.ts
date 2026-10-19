import { test, expect } from "@playwright/test";
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

  // The diff has the real change and none of the harness's scratch files; skills stay in the repo.
  const diff = page.getByLabel("Diff");
  await expect(diff).toContainText("notes.txt");
  await expect(diff).not.toContainText(".polaris");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("done");
  expect(git(repo, "ls-tree", "-r", "--name-only", "main")).toBe(".polaris/skills/lint.md\nREADME.md\nnotes.txt");

  // Usage page.
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
});
