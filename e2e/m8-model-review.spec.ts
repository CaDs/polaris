import { test, expect } from "@playwright/test";
import { git, signUp, tempRepo } from "./helpers.ts";

test("M8: the model review asks for a fix, the worker fixes it in the same run, the second review approves", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Review");
  const transcript = page.getByRole("region", { name: "Transcript" });

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("test -f notes.txt");
  await expect(page.getByLabel("Model review before human review")).toBeChecked();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByLabel("Model review before human review")).toBeChecked();

  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill("Reviewed change");
  await dialog.getByLabel("Spec").fill("REVIEW-ONCE: write the notes");
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: /Reviewed change/ }).click();
  await page.getByRole("button", { name: "Run agent" }).click();

  await expect(transcript).toContainText("Model review requested changes", { timeout: 60_000 });
  await expect(transcript).toContainText("notes.txt:1 — The demo reviewer wants a fixed.txt. → Create fixed.txt.");
  await expect(transcript).toContainText("Approved by model review", { timeout: 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Show run #2" })).toHaveCount(0); // fixed within run #1
  await expect(page.getByLabel("Diff")).toContainText("fixed.txt");
  expect(git(repo, "for-each-ref", "refs/heads/harness")).toContain("harness/");
});
