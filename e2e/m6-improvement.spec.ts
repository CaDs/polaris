import { test, expect, type Page } from "@playwright/test";
import { git, signUp, tempRepo } from "./helpers.ts";

async function newTicket(page: Page, title: string, spec: string) {
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Spec").fill(spec);
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
}

test("M6: reflection → lessons, eval case from an approved ticket, eval-gated prompt promotion", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Improver");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("test -f ok.txt");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // Attempt 1 fails the gate (no ok.txt), the retry creates it and passes; approve. Its base commit has no ok.txt.
  await newTicket(page, "Make ok file", "create ok.txt");
  const status = page.getByLabel("Status");
  const transcript = page.getByRole("region", { name: "Transcript" });
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(status).toHaveValue("review", { timeout: 90_000 });
  await expect(transcript).toContainText("prompt v1");
  await expect(transcript).toContainText("Reflection: lessons updated (v1");
  await page.getByRole("button", { name: "Show run #1" }).click();
  await expect(transcript).toContainText("Tests failed: `test -f ok.txt` exited with code 1");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");

  // Add to evals: validated in a clean worktree + Docker sandbox at the base commit, where the test command fails.
  await page.getByRole("button", { name: "Add to evals" }).click();
  await expect(page.getByText("In evals")).toBeVisible({ timeout: 60_000 });

  // Lessons written by the reflection, with history.
  await page.getByRole("link", { name: "Improvement" }).click();
  const lessons = page.getByRole("textbox", { name: "Lessons" });
  await expect(lessons).toHaveValue("- IMP-1 Make ok file: passed");
  const history = page.getByRole("list", { name: "Lessons history" });
  await expect(history.getByRole("listitem", { name: "Lessons v1" })).toContainText("reflection on IMP-1 (run #2)");

  // Human edit → v2 (diff shows the added line), then Restore v1 → v3.
  await lessons.fill("- IMP-1 Make ok file: passed\n- Run the tests before finishing");
  await page.getByRole("button", { name: "Save lessons" }).click();
  const v2l = history.getByRole("listitem", { name: "Lessons v2" });
  await expect(v2l).toContainText("edited by");
  await v2l.getByText("Diff vs v1").click();
  await expect(v2l.locator(".add")).toHaveText("+- Run the tests before finishing");
  await history.getByRole("listitem", { name: "Lessons v1" }).getByRole("button", { name: "Restore" }).click();
  await expect(history.getByRole("listitem", { name: "Lessons v3" })).toContainText("restore of v1");
  await expect(lessons).toHaveValue("- IMP-1 Make ok file: passed");

  // Eval of the active v1: the demo agent does not create ok.txt on a first attempt → 0/1.
  const v1 = page.getByRole("article", { name: "Prompt v1" });
  await expect(v1.locator(".badge")).toHaveText("active");
  await v1.getByRole("button", { name: "Run eval" }).click();
  await expect(v1.getByRole("list", { name: "Evals" })).toContainText("Eval 0/1 passed", { timeout: 60_000 });

  // Propose improvement → v2 (inactive, with rationale); Promote is disabled until v2 has an eval.
  await page.getByRole("button", { name: "Propose improvement" }).click();
  const v2 = page.getByRole("article", { name: "Prompt v2" });
  await expect(v2).toContainText("Rationale:");
  await expect(v2).toContainText("proposed by demo");
  await expect(v2.getByRole("button", { name: "Promote" })).toBeDisabled();
  await expect(v2.getByLabel("Promotion")).toContainText("Run an eval of v2");
  await v2.getByText(/^Prompt \(\d+ chars\)$/).click();
  await expect(v2.locator("pre")).toContainText("ALWAYS-CREATE-OK");

  // Eval of v2 (its prompt makes the demo create ok.txt) → 1/1 beats 0/1: Promote is enabled.
  await v2.getByRole("button", { name: "Run eval" }).click();
  await expect(v2.getByRole("list", { name: "Evals" })).toContainText("Eval 1/1 passed", { timeout: 60_000 });
  await expect(v2.getByLabel("Promotion")).toContainText("Higher pass rate");
  // The eval case runs are viewable: a detached worktree at the case's base commit.
  await page.getByRole("table", { name: "Eval runs" }).getByRole("button", { name: "Transcript" }).first().click();
  await expect(page.getByRole("region", { name: "Transcript" })).toContainText("Detached worktree at");
  await v2.getByRole("button", { name: "Promote" }).click();
  await expect(v2.locator(".badge")).toHaveText("active");
  await expect(v1.getByRole("button", { name: "Promote" })).toBeDisabled();

  // The source ticket was never touched; the next run uses prompt v2.
  expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  await newTicket(page, "After promotion", "anything");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript).toContainText("prompt v2");
  await expect(transcript).toContainText("the system prompt says so", { timeout: 60_000 });
  await expect(status).toHaveValue("review", { timeout: 60_000 });
});
