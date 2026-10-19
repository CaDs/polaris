import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, signUp, tempRepo } from "./helpers.ts";

// Opt-in: REAL_MODEL=qwen3.8:27b-mlx npm run e2e:headed
// A real model plans an epic into child tickets, workers implement them in the sandbox, auto-approve merges them.
// Each test skips while its module is missing, so the shared gate (`npm test`) can pass per child.
const testFile = (mod: string, fn: string, cases: [string, string][]) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("${fn}", { skip: !existsSync(new URL("../${mod}", import.meta.url)) && "${mod} not written yet" }, async () => {
  const { ${fn} } = await import("../${mod}");
${cases.map(([i, o]) => `  assert.equal(${fn}(${JSON.stringify(i)}), ${JSON.stringify(o)});`).join("\n")}
});
`;

test("real model: planner splits an epic, workers implement, auto-approve merges, epic done", async ({ page }) => {
  test.setTimeout(60 * 60_000);
  const repo = tempRepo();
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2));
  writeFileSync(join(repo, "tests", "slugify.test.js"), testFile("slugify.js", "slugify", [["Hello World", "hello-world"], ["  Crème Brûlée!  ", "creme-brulee"], ["a--b__c", "a-b-c"]]));
  writeFileSync(join(repo, "tests", "titlecase.test.js"), testFile("titlecase.js", "titleCase", [["hello world", "Hello World"], ["the LORD of the rings", "The Lord of the Rings"], ["", ""]]));
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=e2e", "-c", "user.email=e2e@x.dev", "commit", "-q", "-m", "add tests");

  const model = process.env.REAL_MODEL!;
  await signUp(page, "Planner");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("npm test");
  await page.getByLabel("Auto-approve child tickets").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Add provider" }).click();
  const pd = page.getByRole("dialog");
  await pd.getByLabel("Name").fill("Local Ollama");
  await pd.getByLabel("Kind").selectOption("ollama");
  await pd.getByLabel("Base URL").fill("http://localhost:11434");
  await pd.getByRole("button", { name: "Add provider" }).click();
  await expect(pd).toBeHidden();
  const providers = page.getByRole("region", { name: "Providers" });
  await providers.getByLabel("Default provider").selectOption({ label: "Local Ollama" });
  await providers.getByLabel("Default model").selectOption(model);
  await providers.getByRole("button", { name: "Save default" }).click();
  await expect(providers.getByRole("status")).toHaveText("Default saved");

  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Epic" }).check();
  await dialog.getByLabel("Title").fill("String utilities");
  await dialog
    .getByLabel("Spec")
    .fill(
      "Make every test in tests/ pass (tests/ is read-only). tests/slugify.test.js needs slugify.js exporting slugify(s); " +
        "tests/titlecase.test.js needs titlecase.js exporting titleCase(s). The two are independent: one ticket per utility.",
    );
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /String utilities/ }).click();
  await page.getByRole("button", { name: "Run planner" }).click();

  const status = page.getByLabel("Status");
  await expect(status).toHaveValue(/review|failed/, { timeout: 55 * 60_000 });
  console.log("epic summary/handoff: " + (await page.locator("main").innerText()).slice(0, 3000));
  await expect(status).toHaveValue("review");
  await expect(page.getByRole("list", { name: "Children" }).getByRole("listitem")).not.toHaveCount(0);
  await page.getByRole("region", { name: "Review" }).getByRole("button", { name: "Approve" }).click();
  await expect(status).toHaveValue("done");

  // main has both modules, and the full suite passes there with nothing skipped.
  const files = git(repo, "ls-tree", "-r", "--name-only", "main");
  expect(files).toContain("slugify.js");
  expect(files).toContain("titlecase.js");
  git(repo, "checkout", "-q", "main");
  const out = execFileSync("sh", ["-c", "node --test tests/*.test.js"], { cwd: repo, encoding: "utf8" });
  expect(out).toMatch(/pass 2/);
  expect(out).toMatch(/skipped 0/);
});
