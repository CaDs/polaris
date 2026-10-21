import { test, expect } from "@playwright/test";
import { addProvider, more, newTicket, openTicket, saveSettings, signUp, tempRepo } from "./helpers.ts";

test("ChatGPT connection, per-ticket GPT/local switching and complete token reporting", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const repo = tempRepo({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/check.js" } }),
    "tests/check.js": "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('note.txt','utf8').trim(), 'hello');\n",
  });
  await signUp(page, "Subscription");
  await saveSettings(page, repo, "npm test");
  await page.request.put("/api/settings", { data: { wiki: false } });
  const localUrl = (await (await page.request.get("/api/e2e/ollama")).json()).url;
  await addProvider(page, { name: "Local", kind: "ollama", baseUrl: localUrl });
  const providers = page.getByRole("region", { name: "Providers" });
  await page.getByLabel("Default provider").selectOption({ label: "Local" });
  await page.getByRole("button", { name: "Save settings" }).click();
  await providers.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await dialog.getByLabel("Name", { exact: true }).fill("My GPT");
  await dialog.getByLabel("Kind").selectOption("openai");
  await dialog.getByLabel("Auth type").selectOption("oauth");
  await expect(dialog.getByLabel("Base URL")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add provider" }).click();
  const popup = page.waitForEvent("popup");
  await providers.getByRole("button", { name: "Continue with ChatGPT" }).click();
  const login = await popup;
  await expect(login.getByText("Signed in. Return to Polaris.")).toBeVisible();
  await login.close();
  await expect(page.getByRole("dialog", { name: "You're using your ChatGPT plan" })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(providers).toContainText("browser@example.com");
  await expect(page.getByLabel("Default provider").locator("option:checked")).toHaveText("Local");
  await page.getByLabel("Reviewer Provider").selectOption({ label: "My GPT" });
  await expect(page.getByLabel("Reviewer Model")).toHaveValue("gpt-browser");
  await page.getByRole("button", { name: "Save settings" }).click();

  await page.getByRole("link", { name: "Board", exact: true }).click();
  await newTicket(page, "GPT ticket", "Create note.txt containing hello.");
  await openTicket(page, "GPT ticket");
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "My GPT" });
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-browser");
  await expect(page.getByText("Using ChatGPT plan")).toBeVisible();
  await page.getByRole("button", { name: "Run agent", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("review", { timeout: 60_000 });
  await expect(page.getByLabel("Ticket token usage")).toContainText("72 total processed tokens · 18 background");
  await expect(page.getByRole("table").first()).toContainText("ChatGPT plan");

  await page.getByRole("link", { name: "Board", exact: true }).click();
  await newTicket(page, "Local ticket", "Create note.txt containing hello.");
  await openTicket(page, "Local ticket");
  await page.getByRole("button", { name: "Run agent", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("review", { timeout: 60_000 });
  await expect(page.getByLabel("Ticket token usage")).toContainText("72 total processed tokens · 18 background");
  await more(page, "Usage");
  await expect(page.getByRole("region", { name: "By activity", exact: true })).toContainText("reflection (background)");
  await expect(page.getByRole("region", { name: "Per model", exact: true })).toContainText("My GPT / gpt-browser");
  await expect(page.getByRole("region", { name: "Per model", exact: true })).toContainText("Local / local-browser");
  await expect(page.getByRole("link", { name: "Manage ChatGPT plan usage" })).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  const usage = await (await page.request.get("/api/usage")).json();
  expect(usage.totals.tokens_total).toBe(144);
  expect(usage.background.tokens_total).toBe(36);
  expect(usage.models.find((m: any) => m.model === "gpt-browser").tokens_total).toBe(90); // GPT worker + both GPT reviews + GPT reflection
  expect(usage.models.find((m: any) => m.model === "local-browser").tokens_total).toBe(54); // local worker + local reflection
  expect(usage.totals.tokens_total).toBe(usage.execution.tokens_total + usage.background.tokens_total);
});
