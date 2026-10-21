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
