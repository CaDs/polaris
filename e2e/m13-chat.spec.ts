import { test, expect } from "@playwright/test";
import { newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

// The demo chat agent reads README.md, proposes a ticket titled after the message, then replies (demo.ts chatScript).
test("M13: chat on a ticket page → @-mention → proposal card → File → the new ticket", async ({ page }) => {
  await signUp(page, "Chatter");
  await saveSettings(page, tempRepo(), "test -f notes.txt");
  await newTicket(page, "Notes are missing", "We need a notes file.");
  await openTicket(page, "Notes are missing");

  await page.keyboard.press("ControlOrMeta+j");
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText("On APP-1")).toBeVisible();
  const box = chat.getByRole("textbox", { name: "Message" });
  await box.pressSequentially("Like @APP");
  await expect(chat.getByRole("listbox", { name: "Tickets" })).toContainText("Notes are missing");
  await box.press("Tab");
  await box.pressSequentially("but write notes.txt");
  await expect(box).toHaveValue("Like @APP-1 but write notes.txt");
  await box.press("Enter");

  const log = chat.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("Like @APP-1 but write notes.txt");
  await expect(log).toContainText("Looked at README.md");
  const card = log.getByRole("article", { name: "Proposal P1" });
  await expect(card).toContainText("Like @APP-1 but write notes.txt");
  await expect(log).toContainText("File it when it looks right");

  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Title").fill("Write notes.txt");
  await card.getByRole("button", { name: "File", exact: true }).click();
  await expect(card).toContainText("Filed as APP-2");
  await expect(card.getByLabel("Title")).toBeHidden(); // filing ends editing
  await card.getByRole("link", { name: "APP-2" }).click();
  await expect(page.getByRole("heading", { name: "APP-2" })).toBeVisible();

  // The panel stays open and the chat replays after a reload.
  await page.reload();
  await expect(page.getByRole("region", { name: "Chat" }).getByRole("log", { name: "Messages" })).toContainText("Filed as APP-2");
  await expect(page.getByRole("article", { name: "Proposal P1" })).toContainText("Write notes.txt");
  await page.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("region", { name: "Chat" })).toBeHidden();
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("button", { name: /Write notes\.txt/ })).toBeVisible();
});

// M17: the full-width Agent page, a starting example, and a skill created in the composer and attached to a message.
test("Agent page: example, a skill created and attached from the composer, the reply", async ({ page }) => {
  await signUp(page, "Agents");
  await saveSettings(page, tempRepo(), "true");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/agent$/);
  const chat = page.getByRole("region", { name: "Chat" });
  await chat.getByRole("button", { name: /Explain the code/ }).click();
  const box = chat.getByRole("textbox", { name: "Message" });
  await expect(box).toHaveValue(/How does … work/);
  await chat.getByRole("button", { name: /^Skills/ }).click();
  await chat.getByRole("button", { name: "Create skill" }).click();
  const d = page.getByRole("dialog", { name: "Create skill" });
  await d.getByLabel("Name", { exact: true }).fill("Point to files");
  await d.locator("input[name=description]").fill("Answer with file paths");
  await d.locator("textarea[name=body]").fill("Cite every claim with a file:line.");
  await d.getByRole("button", { name: "Create skill" }).click();
  await expect(chat.locator(".chat-compose .chip", { hasText: "Point to files" })).toBeVisible();
  await box.fill("NO-PROPOSAL where does the board live?");
  await chat.getByRole("button", { name: "Send" }).click();
  const log = chat.getByRole("log", { name: "Messages" });
  await expect(log.locator(".chat-user .chip", { hasText: "Point to files" })).toBeVisible();
  await expect(log.locator(".chat-model").first()).toBeVisible();
  await expect(chat.locator(".chat-compose .chip", { hasText: "Point to files" })).toHaveCount(0); // attached once, then cleared
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("region", { name: "Skills" })).toContainText("Point to files");
});
