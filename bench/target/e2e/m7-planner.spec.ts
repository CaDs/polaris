import { test, expect, type Page } from "@playwright/test";
import { git, signUp, tempRepo } from "./helpers.ts";

// The demo planner creates "Create a.txt" and "Create b.txt" (after a.txt); the demo worker creates the file its ticket
// names and hands off. The gate passes once either file exists; children run in the real Docker sandbox.
async function setup(page: Page, workspace: string, autoApprove: boolean) {
  const repo = tempRepo();
  await signUp(page, workspace);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("test -f a.txt || test -f b.txt");
  if (autoApprove) await page.getByLabel("Auto-approve child tickets").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  return repo;
}

async function newEpic(page: Page, title: string, spec: string) {
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Epic" }).check();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Spec").fill(spec);
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("link", { name: "Board" }).click();
  const card = page.getByRole("button", { name: new RegExp(title) });
  await expect(card).toContainText("Epic");
  await card.click();
}

test("M7: epic → planner round → children with a dependency → approvals drive new rounds → epic review → done", async ({ page }) => {
  test.setTimeout(300_000);
  const repo = await setup(page, "Planner", false);
  await newEpic(page, "Two files", "Add a.txt and b.txt.");
  const status = page.getByLabel("Status");
  const transcript = page.getByRole("region", { name: "Transcript" });
  const kids = page.getByRole("list", { name: "Children" });
  const kid = (key: string) => kids.getByRole("listitem", { name: key, exact: true });

  // Round 1: a read-only checkout; the planner creates two tickets, B depending on A, and finishes the round.
  await page.getByRole("button", { name: "Run planner" }).click();
  await expect(transcript).toContainText("Planner round #1");
  await expect(transcript).toContainText("Read-only checkout at", { timeout: 60_000 });
  await expect(transcript.locator(".call", { hasText: "create_ticket" })).toHaveCount(2, { timeout: 30_000 });
  await expect(transcript).toContainText("Round 1 finished");
  await expect(kid("PLA-2")).toContainText("Create a.txt");
  await expect(kid("PLA-3")).toContainText("Create b.txt");
  await expect(kid("PLA-3")).toContainText("← PLA-2");
  await expect(kid("PLA-3")).toContainText("waiting on PLA-2");
  await expect(page.getByText("waiting for children")).toBeVisible();

  // A runs (B waits) and passes; its handoff shows in the epic view.
  await expect(kid("PLA-2")).toContainText("in review", { timeout: 90_000 });
  await expect(kid("PLA-3")).toContainText("waiting on PLA-2");
  await kid("PLA-2").getByText("Handoff").click();
  await expect(kid("PLA-2").locator("pre")).toContainText("Results: created a.txt");

  // The board shows the children with their parent key, and the epic's progress.
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("region", { name: "review", exact: true }).getByRole("button", { name: /Create a\.txt/ })).toContainText("PLA-1");
  await expect(page.getByRole("region", { name: "todo", exact: true }).getByRole("button", { name: /Create b\.txt/ })).toContainText("PLA-1");
  const epicCard = page.getByRole("region", { name: "running", exact: true }).getByRole("button", { name: /Two files/ });
  await expect(epicCard).toContainText("0/2 done");
  await expect(epicCard).toContainText("waiting for children");

  // Approve A (auto-approve is off): B is queued from the updated main and runs.
  await page.getByRole("button", { name: /Create a\.txt/ }).click();
  await expect(transcript).toContainText("Handoff to the planner");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");
  await page.getByRole("button", { name: "PLA-1", exact: true }).click();
  await expect(kid("PLA-3")).toContainText("in review", { timeout: 90_000 });
  await kid("PLA-3").getByRole("button", { name: "PLA-3" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");

  // The settled children woke the planner: a later round sees both handoffs and completes the epic → review.
  await page.getByRole("button", { name: "PLA-1", exact: true }).click();
  await expect(status).toHaveValue("review", { timeout: 90_000 });
  await expect(page.getByLabel("Summary")).toContainText("Done: PLA-2 Create a.txt; PLA-3 Create b.txt.");
  await expect(transcript).toContainText("Epic completed");
  await expect(page.getByRole("button", { name: "Show run #2" })).toBeVisible();
  await kid("PLA-3").getByText("Handoff").click();
  await expect(kid("PLA-3").locator("pre")).toContainText("Results: created b.txt");
  await expect(page.getByLabel("Epic usage")).toContainText("planner + children");

  await page.getByRole("region", { name: "Review" }).getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");
  expect(git(repo, "show", "main:a.txt")).toBe("a");
  expect(git(repo, "show", "main:b.txt")).toBe("b");
  expect(git(repo, "for-each-ref", "refs/heads/harness")).toBe("");
  expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
});

test("M7: with auto-approve on, an epic runs to review without child approvals", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = await setup(page, "Autopilot", true);
  await newEpic(page, "Two files", "Add a.txt and b.txt.");
  await page.getByRole("button", { name: "Run planner" }).click();
  const status = page.getByLabel("Status");
  await expect(status).toHaveValue("review", { timeout: 180_000 });
  const kids = page.getByRole("list", { name: "Children" });
  await expect(kids.getByRole("listitem")).toHaveCount(2);
  for (const key of ["AUT-2", "AUT-3"]) await expect(kids.getByRole("listitem", { name: key, exact: true })).toContainText("done");
  await expect(page.getByLabel("Summary")).toContainText("Done: AUT-2 Create a.txt; AUT-3 Create b.txt.");
  await page.getByRole("region", { name: "Review" }).getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");
  expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["README.md", "a.txt", "b.txt"]);
});
