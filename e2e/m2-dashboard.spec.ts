import { test, expect } from "@playwright/test";
import { newTicket, putSettings, signUp, tempRepo } from "./helpers.ts";

test("M2: tickets, live agent run, cancel, theme, delete", async ({ page }) => {
  await signUp(page, "Homestead");
  // Since M3 runs need a repository; the gate checks the demo agent's notes.txt.
  await putSettings(page, { repo_path: tempRepo(), setup_command: "", test_command: "test -f notes.txt", model_review: false });

  // Create one ticket with the button, one with the C shortcut; Esc closes the dialog.
  await newTicket(page, "First ticket", "write a notes file");

  await page.keyboard.press("c");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.keyboard.press("c");
  await page.getByLabel("Title").fill("Slow ticket");
  await page.getByLabel("Spec").fill("this one is slow");
  await page.getByRole("button", { name: "Create ticket" }).click();

  const column = (name: string) => page.getByRole("region", { name, exact: true });
  await expect(column("todo").getByRole("button")).toHaveCount(2);
  await expect(column("todo")).toContainText("HOM-2");

  // Edit the first ticket's title, then run the agent and watch the transcript stream.
  await column("todo").getByRole("button", { name: /First ticket/ }).click();
  await expect(page).toHaveURL(/\/t\/1$/);
  await page.getByLabel("Title").fill("First ticket edited");
  await page.getByLabel("Title").blur();
  await page.getByRole("button", { name: "Run agent" }).click();

  const transcript = page.getByRole("region", { name: "Transcript" });
  const tokens = page.getByRole("status", { name: "Token usage" });
  await expect(transcript.getByText("edit_file")).toBeVisible();
  await expect(tokens).toContainText(/out [1-9]/); // live: counter moves before the run ends
  await expect(transcript.getByText("read_file")).toBeVisible();
  await expect(tokens).toContainText("in 400 · out 80 · cached 40");
  await expect(page.getByLabel("Status")).toHaveValue("review");
  await expect(page.getByLabel("Status").locator("option")).toHaveText(["review", "todo"]); // by hand, review only goes back to todo

  // M12: the bell got the review notification over the workspace stream; a comment shows up in the list and does not notify its author.
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName("Notifications (1 unread)");
  await bell.click();
  await page.getByRole("button", { name: "HOM-1 is ready for review" }).click();
  await expect(page).toHaveURL(/\/t\/1$/);
  await expect(bell).toHaveAccessibleName("Notifications");
  await page.getByLabel("New comment").fill("Looks good, merging after lunch.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comments = page.getByRole("region", { name: "Comments" });
  await expect(comments).toContainText("Looks good, merging after lunch.");
  await expect(comments).toContainText("homestead-");
  await expect(bell).toHaveAccessibleName("Notifications");

  await page.getByRole("link", { name: "Board" }).click();
  await expect(column("review").getByRole("button", { name: /First ticket edited/ })).toBeVisible();
  await expect(column("review")).toContainText("580 tok"); // 480 input/output + 40 cache reads + 60 background reflection

  // A slow run can be cancelled; the ticket goes back to todo.
  await column("todo").getByRole("button", { name: /Slow ticket/ }).click();
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByLabel("Status")).toBeDisabled(); // a running ticket's status belongs to its run
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(transcript).toContainText("cancelled");
  await expect(page.getByLabel("Status")).toHaveValue("todo");

  // Changed elsewhere (another tab, the CLI): the workspace event stream moves the card without a focus or a reload.
  await page.getByRole("link", { name: "Board" }).click();
  await expect(column("todo").getByRole("button", { name: /Slow ticket/ })).toBeVisible();
  await page.waitForLoadState("networkidle"); // the board's own fetches are done: only the stream can refresh it now
  const slow = (await (await page.request.get("/api/tickets")).json()).find((t: { title: string }) => t.title === "Slow ticket");
  expect((await page.request.patch(`/api/tickets/${slow.id}`, { data: { status: "failed" } })).ok()).toBe(true);
  await expect(column("failed").getByRole("button", { name: /Slow ticket/ })).toBeVisible();
  await column("failed").getByRole("button", { name: /Slow ticket/ }).click();

  // Theme: persisted across reload.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 15, 29)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 15, 29)");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  // Delete through the in-app confirm.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Delete ticket" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(column("todo").getByRole("button")).toHaveCount(0);
  await expect(column("failed").getByRole("button")).toHaveCount(0);
});
