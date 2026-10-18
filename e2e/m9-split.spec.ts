import { test, expect } from "@playwright/test";
import { git, signUp, tempRepo } from "./helpers.ts";

// SPLIT-ME: the demo worker also writes tests/broken.txt, so every attempt fails the gate and the harness splits the ticket.
// The "Split:" epic's demo planner creates part1.txt and part2.txt, each with its own test command; the workspace test
// command (the epic gate) needs both. Runs in the real Docker sandbox; children are auto-approved.
test("M9: a ticket that fails every attempt is split into an epic whose children pass and whose epic gate passes", async ({ page }) => {
  test.setTimeout(420_000);
  const repo = tempRepo();
  await signUp(page, "Splitter");
  const status = page.getByLabel("Status");
  const transcript = page.getByRole("region", { name: "Transcript" });

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("test -f part1.txt && test -f part2.txt");
  await page.getByLabel("Auto-approve child tickets").check();
  await expect(page.getByLabel("Split tickets that fail into smaller ones")).toBeChecked();
  await expect(page.getByLabel("Child size hint")).toHaveValue("at most 3 files and about 60 changed lines, finishable in 20 agent turns");
  await expect(page.getByLabel("Triage model")).toHaveValue("");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByLabel("Split tickets that fail into smaller ones")).toBeChecked();

  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill("Big change");
  await dialog.getByLabel("Spec").fill("Write both parts. SPLIT-ME");
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /Big change/ }).click();
  await page.getByRole("button", { name: "Run agent" }).click();

  // Three attempts fail the gate (protected path), then the ticket is replaced by a "Split:" epic.
  await expect(transcript).toContainText("Tests failed: modified protected path tests/broken.txt", { timeout: 60_000 });
  await expect(page.getByText("Escalated to")).toBeVisible({ timeout: 150_000 });
  await expect(status).toHaveValue("failed");
  await expect(page.getByRole("button", { name: "Show run #3" })).toBeVisible();
  await page.getByText("Escalated to").getByRole("button", { name: "SPL-2" }).click();

  // The epic links back, its planner splits the work into two children with their own gates.
  await expect(page.getByLabel("Title")).toHaveValue("Split: Big change");
  await expect(page.getByText("Split from")).toBeVisible();
  await expect(page.getByLabel("Spec")).toHaveValue(/## Previous direct attempt[\s\S]*Attempt 3: failed \(modified protected path tests\/broken\.txt\)/);
  const kids = page.getByRole("list", { name: "Children" });
  await expect(kids.getByRole("listitem", { name: "SPL-3", exact: true })).toContainText("Create part1.txt", { timeout: 60_000 });
  await expect(kids.getByRole("listitem", { name: "SPL-4", exact: true })).toContainText("Create part2.txt");

  // Children pass their own gates and are merged; the epic gate passes on main; the epic waits for a human.
  await expect(status).toHaveValue("review", { timeout: 180_000 });
  for (const key of ["SPL-3", "SPL-4"]) await expect(kids.getByRole("listitem", { name: key, exact: true })).toContainText("done");
  await expect(transcript).toContainText("Epic gate passed: test -f part1.txt && test -f part2.txt");
  await expect(page.getByLabel("Summary")).toContainText("Done: SPL-3 Create part1.txt; SPL-4 Create part2.txt.");
  expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["README.md", "part1.txt", "part2.txt"]);

  await page.getByText("Split from").getByRole("button", { name: "SPL-1" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Big change");
  await expect(page.getByText("Escalated to")).toContainText("SPL-2");
});
