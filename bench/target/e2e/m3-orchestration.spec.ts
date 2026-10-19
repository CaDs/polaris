import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, signUp, tempRepo } from "./helpers.ts";

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

async function newTicket(page: Page, title: string, spec: string) {
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Spec").fill(spec);
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function openTicket(page: Page, title: string) {
  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
}

test("M3: settings, queue, docker sandbox, test gate retry, approve and reject", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Orchard");
  const transcript = page.getByRole("region", { name: "Transcript" });
  const status = page.getByLabel("Status");

  // Without a repository, Run agent explains what to do.
  await newTicket(page, "Make ok file", "create ok.txt");
  await openTicket(page, "Make ok file");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByRole("alert")).toContainText("No repository configured");

  // Settings: a bad path is rejected, the temp repo is accepted and the base branch defaults to its current branch.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill("/nonexistent/repo");
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("test -f ok.txt");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert")).toContainText("not a git repository");
  await page.getByLabel("Repository path").fill(repo);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByLabel("Base branch")).toHaveValue("main");
  await expect(page.getByLabel("Test command")).toHaveValue("test -f ok.txt");

  // Queue: a slow run holds the only slot (HARNESS_CONCURRENCY=1), so the next run waits as queued.
  await newTicket(page, "Blocker", "this one is slow");
  await openTicket(page, "Blocker");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript.getByText("sleep 30")).toBeVisible({ timeout: 60_000 });

  await openTicket(page, "Make ok file");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript).toContainText("Queued, waiting for a free slot");
  await page.getByRole("link", { name: "Board" }).click();
  await expect(column(page, "running").getByRole("button", { name: /Make ok file/ })).toContainText("queued");

  // Cancelling the slow run (killed inside its container) frees the slot.
  await openTicket(page, "Blocker");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(transcript).toContainText("Run cancelled");
  await expect(status).toHaveValue("todo");

  // Attempt 1 runs in the sandbox and fails the gate; attempt 2 gets the failure and passes.
  await openTicket(page, "Make ok file");
  await expect(page.getByRole("button", { name: "Show run #2" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Show run #1" }).click();
  await expect(transcript).toContainText("Worktree on branch harness/ORC-1-1-");
  await expect(transcript).toContainText("Sandbox harness-");
  await expect(transcript).toContainText("Tests failed: `test -f ok.txt` exited with code 1");
  await page.getByRole("button", { name: "Show run #2" }).click();
  await expect(transcript).toContainText("the previous attempt failed", { timeout: 60_000 });
  await expect(transcript).toContainText("Tests passed", { timeout: 60_000 });
  await expect(transcript).toContainText("Committed");
  await expect(status).toHaveValue("review", { timeout: 15_000 });

  // Review: the diff shows the new files; approve merges into main in the (clean, checked-out) repo.
  const diff = page.getByLabel("Diff");
  await expect(diff).toContainText("ok.txt");
  await expect(diff).toContainText("+hello from the demo agent");
  await expect(page.getByRole("region", { name: "Review" })).toContainText("→ main");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");
  expect(git(repo, "log", "--format=%s", "main")).toContain("ORC-1: Make ok file");
  expect(git(repo, "show", "main:ok.txt")).toBe("ok");
  expect(existsSync(join(repo, "ok.txt"))).toBe(true);
  expect(git(repo, "for-each-ref", "refs/heads/harness")).toBe("");

  // Reject: main now has ok.txt (gate passes on attempt 1) and notes.txt (the demo agent changes nothing, empty diff).
  // Rejecting returns the ticket to todo and deletes the branch.
  await newTicket(page, "Reject me", "another change");
  await openTicket(page, "Reject me");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(status).toHaveValue("review", { timeout: 60_000 });
  await expect(page.getByRole("region", { name: "Review" })).toContainText("No changes.");
  await page.getByRole("region", { name: "Review" }).getByRole("button", { name: "Reject" }).click();
  await page.getByRole("dialog").getByLabel("Note").fill("not needed");
  await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(status).toHaveValue("todo");
  await expect(page.getByRole("region", { name: "Review" })).toBeHidden();
  expect(git(repo, "for-each-ref", "refs/heads/harness")).toBe("");
  expect(git(repo, "log", "--format=%s", "main")).not.toContain("Reject me");
});
