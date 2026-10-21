import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, newTicket, openTicket, putSettings, signUp, tempRepo } from "./helpers.ts";

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("M3: settings, queue, docker sandbox, test gate retry, approve and reject", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Orchard");
  const transcript = page.getByRole("region", { name: "Transcript" });
  const status = page.getByLabel("Status");

  // No project yet, so no ticket: New ticket waits for one.
  await expect(page.getByRole("button", { name: "New ticket" })).toBeDisabled();

  // A project: a bad path is rejected, the temp repo is accepted and the base branch defaults to its current branch.
  const form = page.locator("details.new-project");
  await form.getByLabel("Name").fill("Orchard");
  await expect(form.getByLabel("Key")).toHaveValue("ORC"); // suggested from the name
  await form.getByLabel("Repository path").fill("/nonexistent/repo");
  await expect(form.getByRole("status")).toContainText("does not exist"); // the rest of the form waits for a repository
  await expect(form.getByLabel("Test command")).toBeDisabled();
  await form.getByLabel("Repository path").fill(repo);
  await form.getByLabel("Setup command").fill("");
  await form.getByLabel("Test command").fill("test -f ok.txt");
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/p\/ORC$/);
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByLabel("Base branch")).toHaveValue("main");
  await expect(page.getByLabel("Test command")).toHaveValue("test -f ok.txt");
  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Make ok file", "create ok.txt");

  // Queue: a slow run holds the only slot (POLARIS_CONCURRENCY=1), so the next run waits as queued.
  await newTicket(page, "Blocker", "this one is slow");
  await openTicket(page, "Blocker");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript.getByText("sleep 30").first()).toBeVisible({ timeout: 60_000 }); // the call (the status line names it too)

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
  await expect(transcript).toContainText("Worktree on branch polaris/ORC-1-1-");
  await expect(transcript).toContainText("Sandbox polaris-");
  await expect(transcript).toContainText("Tests failed: `test -f ok.txt` exited with code 1");
  await page.getByRole("button", { name: "Show run #2" }).click();
  await expect(transcript).toContainText("the previous attempt failed", { timeout: 60_000 });
  await expect(transcript).toContainText("Tests passed", { timeout: 60_000 });
  await expect(transcript).toContainText("Approved by model review");
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
  expect(git(repo, "for-each-ref", "refs/heads/polaris")).toBe("");

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
  await expect(transcript.locator(".note.err")).toContainText("Rejected");
  await expect(transcript.locator(".note.err")).toContainText("not needed");
  expect(git(repo, "for-each-ref", "refs/heads/polaris")).toBe("");
  expect(git(repo, "log", "--format=%s", "main")).not.toContain("Reject me");
});

test("M3: a failed gate is fixed in the same run; the ticket's own test command round-trips", async ({ page }) => {
  test.setTimeout(120_000);
  const repo = tempRepo();
  await signUp(page, "Gatefix");
  await putSettings(page, { repo_path: repo, setup_command: "", test_command: "test -f never.txt", model_review: false });
  const transcript = page.getByRole("region", { name: "Transcript" });

  // The New ticket dialog takes an optional test command; the ticket view shows it and saves changes like the spec.
  await newTicket(page, "Fix in run", "GATE-FIX-ONCE", (d) => d.getByLabel("Test command (optional)").fill("test -f ok.txt"));
  await openTicket(page, "Fix in run");
  const command = page.getByLabel("Test command", { exact: true });
  await expect(command).toHaveValue("test -f ok.txt");
  await command.fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".hint .mono", { hasText: "test -f never.txt" })).toBeVisible();
  await page.reload();
  await expect(command).toHaveValue("");
  await expect(command).toHaveAttribute("placeholder", "test -f never.txt");
  await command.fill("test -f ok.txt");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await expect(command).toHaveValue("test -f ok.txt");

  // The first finish leaves the gate failing; the worker is resumed with the failure and the second gate passes: one run.
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript.getByRole("separator").filter({ hasText: "Tests failed — fixing in the same run" })).toBeVisible({ timeout: 60_000 });
  await expect(transcript.locator("details.gate.ok")).toContainText("Tests passed", { timeout: 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Show run #2" })).toHaveCount(0);
  await expect(transcript.locator("details.gate.err")).toContainText("Tests failed: `test -f ok.txt` exited with code 1");
});
