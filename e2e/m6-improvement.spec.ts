import { test, expect } from "@playwright/test";
import { git, more, newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

test("M6: reflection → lessons, eval case from an approved ticket, eval-gated prompt promotion", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Improver");
  await saveSettings(page, repo, "test -f ok.txt");

  // Attempt 1 fails the gate (no ok.txt), the retry creates it and passes; approve. Its base commit has no ok.txt.
  await newTicket(page, "Make ok file", "create ok.txt");
  await openTicket(page, "Make ok file");
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

  // Lessons proposed by the reflection wait for Accept (POL-10), with history.
  await more(page, "Learning");
  const lessons = page.getByRole("textbox", { name: "Lessons" });
  await expect(lessons).toHaveValue("");
  const pending = page.getByRole("group", { name: "Pending lessons" });
  await expect(pending).toContainText("Pending: v1");
  await expect(pending.locator(".add")).toHaveText("+- APP-1 Make ok file: passed");
  await pending.getByRole("button", { name: "Accept" }).click();
  await expect(pending).toBeHidden();
  await expect(lessons).toHaveValue("- APP-1 Make ok file: passed");
  const history = page.getByRole("list", { name: "Lessons history" });
  await expect(history.getByRole("listitem", { name: "Lessons v1" })).toContainText("reflection on APP-1 (run #2)");

  // Human edit → v2 (diff shows the added line), then Restore v1 → v3.
  await lessons.fill("- APP-1 Make ok file: passed\n- Run the tests before finishing");
  await page.getByRole("button", { name: "Save lessons" }).click();
  const v2l = history.getByRole("listitem", { name: "Lessons v2" });
  await expect(v2l).toContainText("edited by");
  await v2l.getByText("Diff vs v1").click();
  await expect(v2l.locator(".add")).toHaveText("+- Run the tests before finishing");
  await history.getByRole("listitem", { name: "Lessons v1" }).getByRole("button", { name: "Restore" }).click();
  await expect(history.getByRole("listitem", { name: "Lessons v3" })).toContainText("restore of v1");
  await expect(lessons).toHaveValue("- APP-1 Make ok file: passed");

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
  await openTicket(page, "After promotion");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(transcript).toContainText("prompt v2");
  await expect(transcript).toContainText("the system prompt says so", { timeout: 60_000 });
  await expect(status).toHaveValue("review", { timeout: 60_000 });
});

test("M12: failure classes on the Improvement page; Mine failures drafts a ticket that shows where it was mined from", async ({ page }) => {
  test.setTimeout(180_000);
  await signUp(page, "Miner");
  await saveSettings(page, tempRepo(), "test -f ok.txt");

  // STUCK-LOOP: the stuck monitor stops attempt 1 of each ticket; the retry passes.
  for (const title of ["Loop one", "Loop two"]) {
    await newTicket(page, title, "STUCK-LOOP");
    await openTicket(page, title);
    await page.getByRole("button", { name: "Run agent" }).click();
    await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 90_000 });
  }

  await more(page, "Learning");
  const stuck = page.getByRole("table", { name: "Failure classes" }).getByRole("row", { name: "stuck", exact: true });
  await expect(stuck).toContainText("the stuck monitor stopped the attempt");
  await expect(stuck.getByRole("cell").nth(1)).toHaveText("2");
  await expect(stuck).toContainText("stuck: repeat_call (read_file");
  await expect(stuck.getByRole("img")).toHaveAccessibleName("stuck: runs per day, last 30 days");

  await page.getByRole("button", { name: "Mine failures" }).click();
  const result = page.getByRole("list", { name: "Mining result" });
  await expect(result).toContainText("Created APP-3 Stop stuck failures");
  await expect(stuck).toContainText("mined: APP-3");

  // A second click skips the class: its mined ticket is still open.
  await page.getByRole("button", { name: "Mine failures" }).click();
  await expect(result).toContainText("Skipped stuck: APP-3 is still open");

  await stuck.getByRole("button", { name: "APP-3" }).click();
  await expect(page.getByText("mined from stuck")).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveValue("todo");
  await expect(page.getByLabel("Spec")).toHaveValue(/## Mined from failures\n\nClass `stuck`/);
});
