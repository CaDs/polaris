import { test, expect } from "@playwright/test";
import { newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

test("M10: approving a ticket ingests it into the wiki; the next run's first message carries the index", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Wikis");

  await saveSettings(page, repo, "test -f notes.txt", () => expect(page.getByLabel("Keep a project wiki")).toBeChecked());

  // Creates the ticket from the board and runs it to review.
  const runTicket = async (title: string, spec: string) => {
    await page.getByRole("link", { name: "Board" }).click();
    await newTicket(page, title, spec);
    await openTicket(page, title);
    await page.getByRole("button", { name: "Run agent" }).click();
    await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 90_000 });
  };

  await runTicket("Add notes", "WIKI-NOTES");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("done");
  await expect(page.getByRole("button", { name: "Show wiki run" })).toBeVisible({ timeout: 60_000 }); // listed with the ticket's runs

  // The Wiki page: the maintainer's page in the index, and its commit in the history.
  await page.getByRole("link", { name: "Wiki" }).click();
  const index = page.getByRole("region", { name: "Index" });
  await expect(index.getByRole("button", { name: "Demo module" })).toBeVisible({ timeout: 60_000 });
  await expect(index).not.toContainText("may be stale");
  await expect(page.getByRole("region", { name: "History" })).toContainText(/ingest WIK-1: Add notes \(merge [0-9a-f]{8}\)/);
  await page.getByRole("region", { name: "History" }).getByRole("button", { name: /ingest WIK-1/ }).click();
  await expect(page.getByRole("region", { name: "History" })).toContainText("+title: Demo module");

  await index.getByRole("button", { name: "Demo module" }).click();
  const view = page.getByRole("region", { name: "Page" });
  await expect(view).toContainText("modules/demo.md");
  await expect(view).toContainText("Notes written by the demo maintainer.");
  await expect(view).toContainText("sources: [notes.txt]");

  // Edit: an invalid page is refused with the problem; a valid one is committed as an edit.
  await view.getByRole("button", { name: "Edit" }).click();
  await view.getByLabel("Page text").fill("no frontmatter");
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("alert")).toContainText("missing frontmatter");
  await view.getByRole("button", { name: "Cancel" }).click();
  await view.getByRole("button", { name: "Edit" }).click();
  await view.getByLabel("Page text").fill(`${await view.getByLabel("Page text").inputValue()}\nA human line.`);
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view).toContainText("A human line.");
  await expect(page.getByRole("region", { name: "History" })).toContainText(/edit modules\/demo\.md by wikis-\d+@x\.dev/);

  // A page that changed while it was open (an ingest, another tab) is refused inline, with a reload.
  await view.getByRole("button", { name: "Edit" }).click();
  const latest = (await (await page.request.get("/api/wiki/page?path=modules/demo.md")).json()).body;
  expect((await page.request.put("/api/wiki/page", { data: { path: "modules/demo.md", body: `${latest}\nA line from elsewhere.` } })).ok()).toBe(true);
  await view.getByLabel("Page text").fill(`${latest}\nMy stale line.`);
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("alert")).toHaveText("modules/demo.md changed since you opened it: reload it and edit again");
  await view.getByRole("button", { name: /Reload page/ }).click();
  await expect(view).toContainText("A line from elsewhere.");
  await expect(view).not.toContainText("My stale line.");
  await page.getByRole("button", { name: "Lint" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Lint passed" })).toBeVisible();

  // A second ticket: its first message has the "Project wiki" section with the index.
  await runTicket("Second change", "plain");
  await page.getByRole("region", { name: "Transcript" }).getByText("First message").first().click();
  const first = page.getByRole("region", { name: "Transcript" }).locator("pre").first();
  await expect(first).toContainText("# Project wiki");
  await expect(first).toContainText("- [Demo module](.polaris/wiki/modules/demo.md) — written by the demo maintainer");
  await expect(first).toContainText("Read the pages relevant to your task (.polaris/wiki/<path>)");
  await expect(first).toContainText("Read-only paths (changes there fail the run): tests, evals, .polaris/wiki");
});
