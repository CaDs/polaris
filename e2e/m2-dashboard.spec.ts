import { test, expect } from "@playwright/test";
import { tempRepo } from "./helpers.ts";

test("M2: tickets, live agent run, cancel, theme, delete", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "No account? Create one" }).click();
  await page.getByLabel("Name").fill("Me");
  await page.getByLabel("Email").fill(`m2-${Date.now()}@x.dev`);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();
  await page.getByLabel("Name").fill("Homestead");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("header strong")).toHaveText("Homestead");
  // Since M3 runs need a repository; the gate checks the demo agent's notes.txt.
  const saved = await page.request.put("/api/settings", { data: { repo_path: tempRepo(), setup_command: "", test_command: "test -f notes.txt", model_review: false } });
  expect(saved.ok()).toBeTruthy();

  // Create one ticket with the button, one with the C shortcut; Esc closes the dialog.
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("First ticket");
  await page.getByLabel("Spec").fill("write a notes file");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

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

  await page.getByRole("link", { name: "Board" }).click();
  await expect(column("review").getByRole("button", { name: /First ticket edited/ })).toBeVisible();
  await expect(column("review")).toContainText("480 tok");

  // A slow run can be cancelled; the ticket goes back to todo.
  await column("todo").getByRole("button", { name: /Slow ticket/ }).click();
  await page.getByRole("button", { name: "Run agent" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(transcript).toContainText("cancelled");
  await expect(page.getByLabel("Status")).toHaveValue("todo");

  // Theme: persisted across reload.
  await page.getByLabel("Theme").selectOption("Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(16, 16, 18)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(16, 16, 18)");
  await page.getByLabel("Theme").selectOption("Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  // Delete through the in-app confirm.
  await page.getByRole("button", { name: "Delete ticket" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(column("todo").getByRole("button")).toHaveCount(0);
});
