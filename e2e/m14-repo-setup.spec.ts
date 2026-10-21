import { test, expect } from "@playwright/test";
import { git, signUp, tempRepo } from "./helpers.ts";

// POL-29: the project form detects the repository, offers its branches, suggests protected paths and commands from the base
// branch, warns about settings that protect or gate nothing, and saves the add-only / read-only mode.
const testFiles = Object.fromEntries([0, 1, 2].map((i) => [`test/${i}.test.ts`, "x\n"]));

test("project form: detection, branch select, suggestions, warnings, protection mode", async ({ page }) => {
  await signUp(page, "Setup");
  const repo = tempRepo({ ...testFiles, "src/a.ts": "x\n", "package-lock.json": "{}", "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  git(repo, "branch", "feature");
  git(repo, "branch", "polaris/SET-1-1-abcd");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects", exact: true }).click();
  const form = page.locator("details.new-project");
  await form.waitFor();
  if ((await form.getAttribute("open")) === null) await form.locator("> summary").click();
  await form.getByLabel("Name", { exact: true }).fill("Setup");

  // A subfolder of the repository offers its root; a plain folder says what is wrong.
  const path = form.getByLabel("Repository path");
  await path.fill(`${repo}/src`);
  await expect(form.getByRole("status")).toContainText(`This folder is inside the repository at ${repo}`);
  await expect(form.getByLabel("Test command")).toBeDisabled();
  await form.getByRole("button", { name: "Use the root" }).click();
  await expect(path).toHaveValue(repo);
  await expect(form.getByRole("status")).toContainText("git repository · 2 branches · on main"); // the polaris/ run branch is not a base
  await path.fill("/nonexistent/folder");
  await expect(form.getByRole("status")).toContainText("does not exist");
  await path.fill(repo);
  await expect(form.getByRole("status")).toContainText("git repository");

  // The checked-out branch is preselected; another branch is a choice. Suggestions come from the base branch.
  const branch = form.getByLabel("Base branch", { exact: true });
  await expect(branch).toHaveValue("main");
  await expect(branch.locator("option")).toHaveCount(3); // main, feature, Other…
  await expect(form.getByLabel("Setup command")).toHaveValue("npm ci");
  await expect(form.getByLabel("Test command")).toHaveValue("npm test");
  await expect(form.getByRole("checkbox", { name: /test\// })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /src\// })).toHaveCount(0);
  await expect(form.getByLabel("Agents may add new files here (recommended)")).toBeChecked();
  await branch.selectOption("feature");
  await expect(form.getByRole("status")).toContainText("git repository");
  await branch.selectOption("main");

  // Warnings: a path that is not in the repository, no test command.
  await form.getByLabel("Add a path").fill("evals");
  await form.getByLabel("Add a path").press("Enter");
  await expect(form.getByText("evals isn't in this repository: it protects nothing.")).toBeVisible();
  await form.getByLabel("Test command").fill("");
  await expect(form.getByText("No test command: every run passes the gate.")).toBeVisible();
  await form.getByLabel("Test command").fill("npm test");
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/p\/SET$/);

  // The project page: the saved settings, the warning again, the mode round-trips.
  await page.goto("/p/SET/overview");
  const repoForm = page.locator("form", { has: page.getByLabel("Repository path") });
  await expect(repoForm.getByRole("checkbox", { name: /test\// })).toBeChecked();
  await expect(repoForm.getByText("evals isn't in this repository: it protects nothing.")).toBeVisible();
  await repoForm.getByLabel("Agents can't touch these paths at all").check();
  await repoForm.getByRole("button", { name: "Save repository" }).click();
  await expect(repoForm.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.reload();
  await expect(repoForm.getByLabel("Agents can't touch these paths at all")).toBeChecked();

  // A saved base branch that was deleted is shown as missing, with a warning.
  await repoForm.getByLabel("Base branch", { exact: true }).selectOption("feature");
  await repoForm.getByRole("button", { name: "Save repository" }).click();
  await expect(repoForm.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  git(repo, "branch", "-D", "feature");
  await page.reload();
  await expect(repoForm.getByText("The base branch feature no longer exists in this repository.")).toBeVisible();
  await expect(repoForm.getByLabel("Base branch", { exact: true })).toHaveValue("feature");
});
