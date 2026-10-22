import { test, expect } from "@playwright/test";
import { newTicket, openSection, openTicket, saveSettings, settingsTab, signUp, tempRepo } from "./helpers.ts";

test("M10: Build wiki and edit a page; approving a ticket remembers what the reviewer confirmed; the next run gets both", async ({ page }) => {
  test.setTimeout(240_000);
  const repo = tempRepo();
  await signUp(page, "Wikis");

  await saveSettings(page, repo, "test -f notes.txt");
  await settingsTab(page, "Automation");
  await expect(page.getByLabel("Keep a project wiki")).toBeChecked();

  // Build wiki: the maintainer's page in the index, and its commit in the history.
  await page.getByRole("link", { name: "Wiki" }).click();
  await expect(page.getByRole("region", { name: "Memory" })).toContainText("Nothing remembered yet.");
  await page.getByRole("button", { name: "Build wiki" }).click();
  const index = page.getByRole("region", { name: "Index" });
  await expect(index.getByRole("button", { name: "Overview" })).toBeVisible({ timeout: 60_000 });
  await expect(index).not.toContainText("may be stale");
  await expect(page.getByRole("region", { name: "History" })).toContainText(/bootstrap: .* at main [0-9a-f]{8}/);
  await page.getByRole("region", { name: "History" }).getByRole("button", { name: /bootstrap/ }).click();
  await expect(page.getByRole("region", { name: "History" })).toContainText("+title: Overview");

  await index.getByRole("button", { name: "Overview" }).click();
  const view = page.getByRole("region", { name: "Page" });
  await expect(view).toContainText("overview.md");
  await expect(view).toContainText("Notes written by the demo maintainer.");
  await expect(view).toContainText("sources: [README.md]");

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
  await expect(page.getByRole("region", { name: "History" })).toContainText(/edit overview\.md by wikis-\d+@x\.dev/);

  // A page that changed while it was open (another tab) is refused inline, with a reload.
  await view.getByRole("button", { name: "Edit" }).click();
  const [project] = await (await page.request.get("/api/projects")).json();
  const wiki = `/api/projects/${project.id}/wiki`;
  const latest = (await (await page.request.get(`${wiki}/page?path=overview.md`)).json()).body;
  expect((await page.request.put(`${wiki}/page`, { data: { path: "overview.md", body: `${latest}\nA line from elsewhere.` } })).ok()).toBe(true);
  await view.getByLabel("Page text").fill(`${latest}\nMy stale line.`);
  await view.getByRole("button", { name: "Save" }).click();
  await expect(view.getByRole("alert")).toHaveText("overview.md changed since you opened it: reload it and edit again");
  await view.getByRole("button", { name: /Reload page/ }).click();
  await expect(view).toContainText("A line from elsewhere.");
  await expect(view).not.toContainText("My stale line.");
  await page.getByRole("button", { name: "Lint" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Lint passed" })).toBeVisible();

  // Creates the ticket from the board and runs it to review.
  const runTicket = async (title: string, spec: string) => {
    await page.getByRole("link", { name: "Board" }).click();
    await newTicket(page, title, spec);
    await openTicket(page, title);
    await page.getByRole("button", { name: "Run agent" }).click();
    await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 90_000 });
  };

  // The review card proposes a memory entry; the reviewer rewrites its title before approving.
  await runTicket("Add notes", "Add a notes file.\n\nREMEMBER: Notes live in notes.txt");
  const remember = page.getByRole("region", { name: "Will remember" });
  await expect(remember.getByLabel("Memory 1 title")).toHaveValue("Notes live in notes.txt");
  await remember.getByLabel("Memory 1 title").fill("Notes live in notes.txt at the repository root");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("done");
  await openSection(page, "How it got here");
  const transcript = page.getByRole("region", { name: "Transcript" });
  await expect(transcript.locator(".note.ok").filter({ hasText: "Remembered" })).toContainText("memory/0001-notes-live-in-notes-txt-at-the-repository-root.md");

  // The Wiki page lists it; Remember this adds a rule by hand.
  await page.getByRole("link", { name: "Wiki" }).click();
  const memory = page.getByRole("region", { name: "Memory" });
  await expect(memory).toContainText("Notes live in notes.txt at the repository root");
  await expect(memory).toContainText("APP-1");
  await memory.getByRole("button", { name: "Remember this" }).click();
  const form = page.getByRole("form", { name: "Remember this" });
  await form.getByLabel("Title").fill("Never push to main");
  await form.getByLabel("Text").fill("Changes go through a pull request.");
  await form.getByRole("button", { name: "Remember" }).click();
  await expect(memory).toContainText("Never push to main");
  await memory.getByRole("button", { name: "Never push to main" }).click();
  await expect(page.getByRole("region", { name: "Page" })).toContainText("Changes go through a pull request.");

  // A second ticket: its first message has the wiki index and the project memory.
  await runTicket("Second change", "plain");
  await openSection(page, "How it got here");
  await page.getByRole("region", { name: "Transcript" }).getByText("First message").first().click();
  const first = page.getByRole("region", { name: "Transcript" }).locator("pre").first();
  await expect(first).toContainText("# Project wiki");
  await expect(first).toContainText("- [Overview](.polaris/wiki/overview.md) — written by the demo maintainer");
  await expect(first).toContainText("# Project memory");
  await expect(first).toContainText("- rule: Never push to main (.polaris/wiki/memory/0002-never-push-to-main.md, wikis-");
  await expect(first).toContainText("- decision: Notes live in notes.txt at the repository root (.polaris/wiki/memory/0001-notes-live-in-notes-txt-at-the-repository-root.md, APP-1)");
  await expect(first).toContainText("Read-only paths (changes there fail the run): tests, evals, .polaris/wiki");
});
