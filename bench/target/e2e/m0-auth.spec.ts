import { test, expect } from "@playwright/test";

test("M0: sign up, create workspace, see board, sign out, sign back in", async ({ page }) => {
  const email = `me-${Date.now()}@x.dev`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByRole("button", { name: "No account? Create one" }).click();
  await page.getByLabel("Name").fill("Me");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();
  await page.getByLabel("Name").fill("Home Lab");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.locator("header strong")).toHaveText("Home Lab");
  for (const col of ["todo", "running", "review", "done", "failed"]) {
    await expect(page.getByRole("heading", { name: new RegExp(`^${col}`) })).toBeVisible();
  }

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("header strong")).toHaveText("Home Lab");
});

test("M0: wrong password shows an error", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("nobody@x.dev");
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});
