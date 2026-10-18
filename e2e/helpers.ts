import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

// A one-commit repo on branch main for the harness to work in.
export function tempRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "harness-e2e-repo-")));
  writeFileSync(join(repo, "README.md"), "# e2e repo\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@x.dev", "commit", "-q", "-m", "init");
  return repo;
}

export async function signUp(page: Page, workspace: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "No account? Create one" }).click();
  await page.getByLabel("Name").fill("Me");
  await page.getByLabel("Email").fill(`${workspace.toLowerCase()}-${Date.now()}@x.dev`);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();
  await page.getByLabel("Name").fill(workspace);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("header strong")).toHaveText(workspace);
}
