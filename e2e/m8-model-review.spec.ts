import { test, expect } from "@playwright/test";
import { git, newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

test("M8: the model review asks for a fix, the worker fixes it in the same run, the second review approves", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Review");
  const transcript = page.getByRole("region", { name: "Transcript" });

  await saveSettings(page, repo, "test -f notes.txt");
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Model review before human review")).toBeChecked();
  // M12: a separate reviewer model for the workspace (the picker needs a provider; the fake one here is set by model name).
  await expect(page.getByRole("heading", { name: "Reviewer model" })).toBeVisible();
  await expect(page.getByLabel("Reviewer Provider")).toHaveValue("");
  expect((await page.request.put("/api/settings/review-provider", { data: { model: "demo-reviewer" } })).ok()).toBe(true);

  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Reviewed change", "REVIEW-ONCE: write the notes");
  await openTicket(page, "Reviewed change");
  await page.getByRole("button", { name: "Run agent" }).click();

  await expect(transcript.getByRole("separator").filter({ hasText: "Model review round 1 by demo-reviewer" })).toBeVisible({ timeout: 60_000 });
  await expect(transcript).toContainText("Model review requested changes", { timeout: 60_000 });
  await expect(transcript).toContainText("notes.txt:1 — The demo reviewer wants a fixed.txt. → Create fixed.txt.");
  await expect(transcript).toContainText("Approved by model review", { timeout: 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Show run #2" })).toHaveCount(0); // fixed within run #1
  await expect(page.getByLabel("Diff")).toContainText("fixed.txt");
  expect(git(repo, "for-each-ref", "refs/heads/polaris")).toContain("polaris/");

  // A reviewer that writes files: the snapshot is restored and the transcript says so, between the review round and its verdict.
  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Tampered review", "REVIEW-WRITES change");
  await openTicket(page, "Tampered review");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript.getByRole("separator").filter({ hasText: "Model review round 1" })).toBeVisible({ timeout: 60_000 });
  await expect(transcript).toContainText("The reviewer changed files; its changes were undone.", { timeout: 60_000 });
  await expect(transcript).toContainText("Approved by model review");
});
