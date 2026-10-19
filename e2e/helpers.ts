import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

export const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

// A one-commit repo on branch main for the harness to work in, with these files besides README.md.
export function tempRepo(files: Record<string, string> = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "polaris-e2e-repo-")));
  for (const [f, body] of Object.entries({ "README.md": "# e2e repo\n", ...files })) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@x.dev", "commit", "-q", "-m", "init");
  return repo;
}

// Signs up a fresh user and creates the workspace; returns the email.
export async function signUp(page: Page, workspace: string) {
  const email = `${workspace.toLowerCase().replace(/\W/g, "")}-${Date.now()}@x.dev`;
  await page.goto("/");
  await page.getByRole("button", { name: "No account? Create one" }).click();
  await page.getByLabel("Name").fill("Me");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();
  await page.getByLabel("Name").fill(workspace);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("header strong")).toHaveText(workspace);
  return email;
}

// Settings through the API, for specs that do not test the Settings page.
export async function putSettings(page: Page, data: Record<string, unknown>) {
  expect((await page.request.put("/api/settings", { data })).ok()).toBe(true);
}

// Settings through the Settings page (General tab): repository, no setup command, this test command.
export async function saveSettings(page: Page, repo: string, testCommand: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill(testCommand);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
}

// Another Settings tab (General must be saved first): open it, `fill` its fields, save.
export async function saveTab(page: Page, tab: string, fill: () => Promise<unknown>) {
  await page.getByRole("link", { name: tab, exact: true }).click();
  await fill();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
}

// Creates a ticket through the New ticket dialog; `more` fills other fields of the dialog.
export async function newTicket(page: Page, title: string, spec?: string, more?: (dialog: Locator) => Promise<void>) {
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  if (spec !== undefined) await dialog.getByLabel("Spec").fill(spec);
  await more?.(dialog);
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden();
}

export async function openTicket(page: Page, title: string) {
  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
}

// Adds a provider on the Models tab of the Settings page (from anywhere in Settings).
export async function addProvider(page: Page, f: { name: string; kind: string; baseUrl?: string; apiKey?: string }) {
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Add provider" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(f.name);
  await d.getByLabel("Kind").selectOption(f.kind);
  if (f.baseUrl) await d.getByLabel("Base URL").fill(f.baseUrl);
  if (f.apiKey) await d.locator("input[name=api_key]").fill(f.apiKey);
  await d.getByRole("button", { name: "Add provider" }).click();
  await expect(d).toBeHidden();
}
