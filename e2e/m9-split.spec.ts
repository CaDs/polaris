import { test, expect } from "@playwright/test";
import { git, newTicket, openTicket, saveSettings, saveTab, signUp, tempRepo } from "./helpers.ts";

// SPLIT-ME: the demo worker also writes tests/broken.txt, so every attempt fails the gate and the harness splits the ticket.
// The "Split:" epic's demo planner creates part1.txt and part2.txt, each with its own test command; the workspace test
// command (the epic gate) needs both. Runs in the real Docker sandbox; children are auto-approved.
test("M9: a ticket that fails every attempt is split into an epic whose children pass and whose epic gate passes", async ({ page }) => {
  test.setTimeout(420_000);
  const repo = tempRepo();
  await signUp(page, "Splitter");
  const status = page.getByLabel("Status");
  const transcript = page.getByRole("region", { name: "Transcript" });

  await saveSettings(page, repo, "test -f part1.txt && test -f part2.txt");
  await saveTab(page, "Automation", async () => {
    await page.getByLabel("Auto-approve child tickets").check();
    await expect(page.getByLabel("Split tickets that fail into smaller ones")).toBeChecked();
    await expect(page.getByLabel("Child size hint")).toHaveValue("at most 3 files and about 60 changed lines, finishable in 20 agent turns");
  });
  await expect(page.getByLabel("Split tickets that fail into smaller ones")).toBeChecked();
  // Triage and escalation are model phases (off by default), next to the other phases.
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Triage Provider")).toHaveValue("");
  await expect(page.getByLabel("Escalation Provider")).toHaveValue("");

  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Big change", "Write both parts. SPLIT-ME");
  await openTicket(page, "Big change");
  await page.getByRole("button", { name: "Run agent" }).click();

  // Three attempts fail the gate (protected path), then the ticket is replaced by a "Split:" epic.
  await expect(transcript).toContainText("Tests failed: modified protected path tests/broken.txt", { timeout: 60_000 });
  await expect(page.getByText("Escalated to")).toBeVisible({ timeout: 150_000 });
  await expect(status).toHaveValue("failed");
  await expect(page.getByRole("button", { name: "Show run #3" })).toBeVisible();
  await page.getByText("Escalated to").getByRole("button", { name: "APP-2" }).click();

  // The epic links back, its planner splits the work into two children with their own gates.
  await expect(page.getByLabel("Title")).toHaveValue("Split: Big change");
  await expect(page.getByText("Split from")).toBeVisible();
  await expect(page.getByLabel("Spec")).toHaveValue(/## Previous direct attempt[\s\S]*Attempt 3: failed \(modified protected path tests\/broken\.txt\)/);
  const kids = page.getByRole("list", { name: "Children" });
  await expect(kids.getByRole("listitem", { name: "APP-3", exact: true })).toContainText("Create part1.txt", { timeout: 60_000 });
  await expect(kids.getByRole("listitem", { name: "APP-4", exact: true })).toContainText("Create part2.txt");

  // Children pass their own gates and are merged; the epic gate passes on main; the epic waits for a human.
  await expect(status).toHaveValue("review", { timeout: 180_000 });
  for (const key of ["APP-3", "APP-4"]) await expect(kids.getByRole("listitem", { name: key, exact: true })).toContainText("done");
  await expect(transcript).toContainText("Epic gate passed: test -f part1.txt && test -f part2.txt");
  await expect(page.getByLabel("Summary")).toContainText("Done: APP-3 Create part1.txt; APP-4 Create part2.txt.");
  expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["README.md", "part1.txt", "part2.txt"]);

  await page.getByText("Split from").getByRole("button", { name: "APP-1" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Big change");
  await expect(page.getByText("Escalated to")).toContainText("APP-2");
});
