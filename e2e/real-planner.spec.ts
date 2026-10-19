import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { addProvider, git, newTicket, openTicket, saveSettings, saveTab, signUp, tempRepo } from "./helpers.ts";

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
  const repo = tempRepo({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2),
    "tests/slugify.test.js": testFile("slugify.js", "slugify", [["Hello World", "hello-world"], ["  Crème Brûlée!  ", "creme-brulee"], ["a--b__c", "a-b-c"]]),
    "tests/titlecase.test.js": testFile("titlecase.js", "titleCase", [["hello world", "Hello World"], ["the LORD of the rings", "The Lord of the Rings"], ["", ""]]),
  });

  const model = process.env.REAL_MODEL!;
  await signUp(page, "Planner");
  await saveSettings(page, repo, "npm test");
  await saveTab(page, "Automation", () => page.getByLabel("Auto-approve child tickets").check());
  await addProvider(page, { name: "Local Ollama", kind: "ollama", baseUrl: "http://localhost:11434" });
  const providers = page.getByRole("region", { name: "Providers" });
  await page.getByLabel("Default provider").selectOption({ label: "Local Ollama" });
  await page.getByLabel("Default model").selectOption(model);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();

  await page.getByRole("link", { name: "Board" }).click();
  const spec =
    "Make every test in tests/ pass (tests/ is read-only). tests/slugify.test.js needs slugify.js exporting slugify(s); " +
    "tests/titlecase.test.js needs titlecase.js exporting titleCase(s). The two are independent: one ticket per utility.";
  await newTicket(page, "String utilities", spec, (d) => d.getByRole("radio", { name: "Epic" }).check());
  await openTicket(page, "String utilities");
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
