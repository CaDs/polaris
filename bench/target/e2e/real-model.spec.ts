import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, signUp, tempRepo } from "./helpers.ts";

// Opt-in: REAL_MODEL=qwen3.8:27b-mlx npm run e2e:headed
// A real model makes a protected test pass inside the Docker sandbox; a human approves the merge.
test("real model: implement against protected tests, gate, review, approve", async ({ page }) => {
  test.setTimeout(45 * 60_000);
  const repo = tempRepo();
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2));
  writeFileSync(
    join(repo, "tests", "slugify.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../slugify.js";

test("slugify", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Crème Brûlée!  "), "creme-brulee");
  assert.equal(slugify("a--b__c"), "a-b-c");
  assert.equal(slugify(""), "");
});
`,
  );
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@x.dev", "commit", "-q", "-m", "add slugify test");

  await signUp(page, "Realmodel");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("npm test");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  // The model comes from an Ollama provider configured here, not from server env.
  const model = process.env.REAL_MODEL!;
  await page.getByRole("button", { name: "Add provider" }).click();
  const pd = page.getByRole("dialog");
  await pd.getByLabel("Name").fill("Local Ollama");
  await pd.getByLabel("Kind").selectOption("ollama");
  await pd.getByLabel("Base URL").fill("http://localhost:11434");
  await pd.getByRole("button", { name: "Add provider" }).click();
  await expect(pd).toBeHidden();
  // Workspace default too: reflection uses the run's model, proposals use the default.
  const providers = page.getByRole("region", { name: "Providers" });
  await providers.getByLabel("Default provider").selectOption({ label: "Local Ollama" });
  await providers.getByLabel("Default model").selectOption(model);
  await providers.getByRole("button", { name: "Save default" }).click();
  await expect(providers.getByRole("status")).toHaveText("Default saved");

  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill("Implement slugify");
  await dialog
    .getByLabel("Spec")
    .fill("Create slugify.js exporting slugify(s) so that `npm test` passes. tests/ is read-only: read tests/slugify.test.js, do not edit it.");
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await page.getByRole("button", { name: /Implement slugify/ }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Local Ollama" });
  await page.getByLabel("Model", { exact: true }).selectOption(model);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue(model);
  await page.getByRole("button", { name: "Run agent" }).click();

  const transcript = page.getByRole("region", { name: "Transcript" });
  await expect(transcript).toContainText("Sandbox harness-", { timeout: 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue(/review|failed/, { timeout: 18 * 60_000 });
  await expect(page.getByLabel("Status")).toHaveValue("review");

  await expect(page.getByLabel("Diff")).toContainText("slugify.js");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("done");
  expect(git(repo, "log", "--format=%s", "main")).toContain("REA-1: Implement slugify");
  expect(git(repo, "diff", "--name-only", "HEAD~1", "HEAD")).not.toContain("tests/");

  // M6 with the real model: the reflection wrote lessons; the approved ticket becomes an eval case
  // (slugify.js is absent at its base commit, so `npm test` fails there); v1 is evaluated; the model proposes v2.
  await page.getByRole("button", { name: "Add to evals" }).click();
  await expect(page.getByText("In evals")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("link", { name: "Improvement" }).click();
  await expect(page.getByRole("textbox", { name: "Lessons" })).not.toHaveValue("");
  const v1 = page.getByRole("article", { name: "Prompt v1" });
  await v1.getByRole("button", { name: "Run eval" }).click();
  await expect(v1.getByRole("list", { name: "Evals" })).toContainText(/Eval [01]\/1 passed/, { timeout: 15 * 60_000 });
  await page.getByRole("button", { name: "Propose improvement" }).click();
  const v2 = page.getByRole("article", { name: "Prompt v2" });
  await expect(v2).toContainText("Rationale:", { timeout: 10 * 60_000 });
  await expect(v2).toContainText(`proposed by ${model}`);
  console.log("lessons:\n" + (await page.getByRole("textbox", { name: "Lessons" }).inputValue()));
  console.log("v1 eval: " + (await v1.getByRole("list", { name: "Evals" }).innerText()));
  console.log("v2: " + (await v2.innerText()).slice(0, 1500));
});
