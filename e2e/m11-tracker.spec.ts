import { test, expect, type Page } from "@playwright/test";
import { newTicket as create, signUp } from "./helpers.ts";

// The tracker without agents: labels, a project with a milestone, a current cycle, tickets with properties, filter chips that
// live in the URL, "/" search and key jump, list grouping, the properties sidebar with shortcuts, the command palette, a saved
// view, and both themes (screenshots attached to the report).
const newTicket = (page: Page, title: string, o: { priority?: string; labels?: string[]; project?: string; cycle?: boolean; due?: string } = {}) =>
  create(page, title, undefined, async (d) => {
    if (o.priority) await d.getByLabel("Priority").selectOption({ label: o.priority });
    for (const l of o.labels ?? []) await d.getByRole("checkbox", { name: l }).check();
    if (o.project) await d.getByLabel("Project").selectOption({ label: o.project });
    if (o.cycle) await d.getByLabel("Cycle").selectOption({ label: "Cycle 1 (current)" });
    if (o.due) await d.getByLabel("Due date").fill(o.due);
  });

async function addFilter(page: Page, field: string, option: string) {
  await page.getByRole("button", { name: "+ Filter" }).click();
  await page.locator(".popover").getByRole("button", { name: field, exact: true }).click();
  await page.locator(".popover").getByRole("checkbox", { name: option }).check();
  await page.keyboard.press("Escape");
  await expect(page.locator(".popover")).toBeHidden();
}

test("M11: labels, project, cycle, ticket properties, URL filters, search, list groups, palette, saved view, themes", async ({ page }, info) => {
  // Screenshots land in the test's output dir (test-results/…) and in the report.
  const shot = async (name: string) => {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(name, { path, contentType: "image/png" });
  };
  await signUp(page, "Tracker");

  // Labels (Settings).
  await page.getByRole("link", { name: "Settings" }).click();
  const labels = page.getByRole("region", { name: "Labels" });
  for (const [name, color] of [["bug", "red"], ["frontend", "blue"]]) {
    await labels.getByLabel("New label", { exact: true }).fill(name);
    await labels.getByLabel("New label color").selectOption(color);
    await labels.getByRole("button", { name: "Add label" }).click();
    await expect(labels.locator(".chip", { hasText: name })).toBeVisible();
  }
  await labels.getByLabel("New label", { exact: true }).fill("BUG");
  await labels.getByRole("button", { name: "Add label" }).click();
  await expect(labels.getByRole("alert")).toHaveText('A label named "bug" already exists');
  // API error codes and server failures read as sentences (one helper for every screen).
  await page.route("/api/labels", (r) => r.fulfill({ status: 403, json: { error: "forbidden_origin" } }), { times: 1 });
  await labels.getByRole("button", { name: "Add label" }).click();
  await expect(labels.getByRole("alert")).toHaveText(/^Refused: the request did not come from this Polaris page/);
  await page.route("/api/labels", (r) => r.fulfill({ status: 500, body: "boom" }), { times: 1 });
  await labels.getByRole("button", { name: "Add label" }).click();
  await expect(labels.getByRole("alert")).toHaveText(/^Something went wrong on the server/);

  // A project with a milestone.
  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByLabel("Project name").fill("Checkout");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("table", { name: "Projects" }).getByRole("button", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
  await page.getByLabel("New milestone").fill("Beta");
  await page.getByRole("button", { name: "Add milestone" }).click();
  await expect(page.getByLabel("Milestone Beta", { exact: true })).toHaveValue("Beta");

  // A cycle starting today (the form's default) is the current one.
  await page.getByRole("link", { name: "Cycles", exact: true }).click();
  await page.getByRole("button", { name: "Create cycle" }).click();
  await expect(page.getByRole("region", { name: "Current" })).toContainText("Cycle 1");
  await expect(page.getByRole("link", { name: "Current cycle" })).toBeVisible();
  // A second (upcoming) cycle is deleted after a confirmation.
  await page.getByRole("button", { name: "Create cycle" }).click();
  await page.getByRole("region", { name: "Upcoming" }).getByRole("button", { name: "Cycle 2" }).click();
  await page.getByRole("button", { name: "Delete cycle" }).click();
  await expect(page.getByRole("dialog", { name: "Delete cycle?" })).toContainText("Its 0 tickets stay, without a cycle.");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/cycles$/);
  await expect(page.getByRole("region", { name: "Current" })).toContainText("Cycle 1");
  await expect(page.getByRole("region", { name: "Upcoming" })).toHaveCount(0);

  // Tickets with properties from the dialog; cards show them.
  await page.getByRole("link", { name: "Board" }).click();
  await newTicket(page, "Fix checkout crash", { priority: "Urgent", labels: ["bug"], project: "Checkout", cycle: true, due: "2026-11-30" });
  await newTicket(page, "Polish cart button", { priority: "Low", labels: ["frontend"], project: "Checkout" });
  await newTicket(page, "Write release notes");
  const todo = page.getByRole("region", { name: "todo", exact: true });
  await expect(todo.getByRole("button")).toHaveCount(3);
  const crash = todo.getByRole("button", { name: /Fix checkout crash/ });
  await expect(crash).toContainText("bug");
  await expect(crash).toContainText("2026-11-30");
  await expect(crash.getByRole("img", { name: "Urgent" })).toBeVisible();

  // Filter chips: AND across fields, OR within one; the state is the URL, so a reload (or a shared link) keeps it.
  await addFilter(page, "Labels", "bug");
  await expect(page).toHaveURL(/[?&]label=/);
  await expect(todo.getByRole("button")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove Labels filter" })).toBeVisible();
  await expect(todo.getByRole("button")).toHaveCount(1);
  await addFilter(page, "Priority", "Low");
  await expect(page.getByText("No matching tickets.")).toBeVisible();
  await page.getByRole("button", { name: "Remove Labels filter" }).click();
  await expect(todo.getByRole("button")).toHaveCount(1);
  await expect(todo).toContainText("Polish cart button");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(todo.getByRole("button")).toHaveCount(3);
  await page.goBack(); // history: back to the Low filter
  await expect(page).toHaveURL(/priority=4/);
  await expect(todo.getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  // "/" focuses search; results are ranked full-text; Enter on a key opens that ticket.
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search")).toBeFocused();
  await page.keyboard.type("release");
  await expect(page).toHaveURL(/q=release/);
  await expect(todo.getByRole("button")).toHaveCount(1);
  await expect(todo).toContainText("Write release notes");
  await page.getByLabel("Search").fill("TRA-1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/t\/1$/);

  // Properties sidebar with single-key shortcuts.
  const props = page.getByRole("complementary", { name: "Properties" });
  await expect(page.getByLabel("Priority")).toHaveValue("1");
  await page.locator("h1").click();
  await page.keyboard.press("p");
  await expect(page.getByLabel("Priority")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByLabel("Priority").selectOption({ label: "High" });
  await expect(page.getByLabel("Priority")).toHaveValue("2");
  await page.locator("h1").click();
  await page.keyboard.press("a");
  await expect(page.getByLabel("Assignee")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByLabel("Assignee").selectOption({ label: "Me (me)" });
  await page.getByLabel("Milestone").selectOption({ label: "Beta" });
  await page.getByLabel("Estimate").selectOption({ label: "3 points" });
  // A typed date saves once, when the field is left (not on every keystroke that makes a valid date).
  const patches: string[] = [];
  const onPatch = (r: { method(): string; url(): string; postData(): string | null }) => r.method() === "PATCH" && r.url().includes("/api/tickets/") && patches.push(r.postData() ?? "");
  page.on("request", onPatch);
  await page.getByLabel("Due date").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp"); // each step is a valid date (an input event)
  const due = await page.getByLabel("Due date").inputValue();
  expect(due).not.toBe("2026-11-30");
  expect(patches).toEqual([]);
  await page.getByLabel("Due date").blur();
  await expect.poll(() => patches).toEqual([JSON.stringify({ due_date: due })]);
  page.off("request", onPatch);
  await page.locator("h1").click();
  await page.keyboard.press("l");
  await page.getByLabel("Find or create label").fill("regression");
  await page.keyboard.press("Enter");
  await expect(props.locator(".menu-anchor > .chip", { hasText: "regression" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Status")).toHaveValue("todo"); // the status select moved into the sidebar
  // Only the moves allowed by hand are offered; a refusal (e.g. a run started meanwhile) reads as a sentence.
  await expect(page.getByLabel("Status").locator("option")).toHaveText(["todo", "done", "failed"]);
  await page.route("**/api/tickets/*", (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 409, json: { error: "invalid_transition", from: "running", to: "done" } }) : r.fallback(), { times: 1 });
  await page.getByLabel("Status").selectOption("done");
  await expect(props.getByRole("alert")).toHaveText(/^A running ticket can't be set to done by hand\./);
  await page.getByLabel("Status").selectOption("done");
  await expect(page.getByLabel("Status").locator("option")).toHaveText(["done", "todo", "failed"]);
  await page.getByLabel("Status").selectOption("todo");
  await expect(page.getByLabel("Status")).toHaveValue("todo");
  await expect(page.getByRole("button", { name: "Run agent" })).toBeVisible(); // agent controls unchanged
  await shot("ticket-properties");

  // List layout grouped by priority.
  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(/layout=list/);
  await page.getByLabel("Group by").selectOption("priority");
  await expect(page.locator(".list h2")).toHaveText([/High 1/, /Low 1/, /No priority 1/]);
  await expect(page.getByRole("region", { name: "High" })).toContainText("TRA-1");
  await expect(page.getByRole("region", { name: "High" }).locator(".lrow")).toContainText("regression");

  // Save the view (project filter + list grouped by priority), then reopen it from Views.
  await addFilter(page, "Project", "Checkout");
  await page.getByRole("button", { name: "Save view" }).click();
  await page.getByRole("dialog").getByLabel("View name").fill("Checkout by priority");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await shot("list-layout");

  // Command palette: jump to a ticket by title, then go to Views.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Command").fill("release");
  await expect(palette.getByRole("option").first()).toContainText("TRA-3");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/t\/3$/);
  await page.keyboard.press("Control+k");
  await palette.getByLabel("Command").fill("views");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/views$/);
  await page.getByRole("listitem", { name: "Checkout by priority" }).getByRole("button", { name: "Checkout by priority", exact: true }).click();
  await expect(page).toHaveURL(/layout=list/);
  await expect(page).toHaveURL(/group=priority/);
  await expect(page.locator(".list h2")).toHaveText([/High 1/, /Low 1/]);

  // Edit the view: regroup the board, then rename and update it in place from the filter bar.
  await expect(page).toHaveURL(/view=/);
  await page.getByLabel("Group by").selectOption("label");
  await page.getByRole("button", { name: "Edit view: Checkout by priority" }).click();
  const edit = page.getByRole("dialog", { name: "Edit view" });
  await expect(edit.getByLabel("View name")).toHaveValue("Checkout by priority");
  await edit.getByLabel("View name").fill("Checkout by label");
  await edit.getByRole("button", { name: "Update view" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit view: Checkout by label" })).toBeVisible();
  await page.getByRole("link", { name: "Views" }).click();
  const saved = page.getByRole("listitem", { name: "Checkout by label" });
  await expect(saved).toContainText("group=label");
  await expect(page.getByRole("listitem", { name: "Checkout by priority" })).toHaveCount(0);
  // Edit from the Views page opens the same dialog on the board; Cancel leaves the view as it was.
  await saved.getByRole("button", { name: "Edit view Checkout by label" }).click();
  await expect(page.getByRole("dialog", { name: "Edit view" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page).not.toHaveURL(/edit=1/);
  await expect(page.locator(".list h2").first()).toHaveText(/bug|regression|No labels/);
  // Delete asks first.
  await page.getByRole("link", { name: "Views" }).click();
  await saved.getByRole("button", { name: "Delete view Checkout by label" }).click();
  await expect(page.getByRole("dialog", { name: "Delete view?" })).toContainText("Tickets are not changed.");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No saved views.")).toBeVisible();

  // Cycle and project pages show progress.
  await page.getByRole("link", { name: "Current cycle" }).click();
  await expect(page.getByRole("region", { name: "Progress" })).toContainText("0/1");
  await expect(page.locator(".list")).toContainText("Fix checkout crash");
  await shot("cycle");
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("table", { name: "Projects" })).toContainText("0/2");
  await page.getByRole("table", { name: "Projects" }).getByRole("button", { name: "Checkout" }).click();
  await expect(page.getByRole("region", { name: "Progress" })).toContainText("0/2");
  await expect(page.getByRole("listitem", { name: "Beta" })).toContainText("0/1");
  await shot("project");

  // A label renamed in Settings shows on the cards without a reload.
  await page.getByRole("link", { name: "Settings" }).click();
  await labels.getByLabel("Rename frontend").fill("ui");
  await labels.getByLabel("Rename frontend").blur();
  await expect(labels.locator(".chip", { hasText: /^ui$/ })).toBeVisible();
  await page.getByRole("link", { name: "Board" }).click();
  await expect(todo.getByRole("button", { name: /Polish cart button/ }).locator(".chip")).toHaveText("ui");

  // Both themes render the board (screenshots in the report).
  for (const [theme, bg] of [["Dark", "rgb(16, 16, 18)"], ["Light", "rgb(255, 255, 255)"]]) {
    await page.getByLabel("Theme").selectOption(theme);
    await expect(page.locator("body")).toHaveCSS("background-color", bg);
    await shot(`board-${theme.toLowerCase()}`);
  }
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Theme").selectOption("Dark");
  await shot("list-dark");
  await page.setViewportSize({ width: 390, height: 844 }); // phone width: nothing scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot("list-phone");
  await page.getByRole("button", { name: /Fix checkout crash/ }).click();
  await expect(page.getByLabel("Priority")).toHaveValue("2");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot("ticket-phone");
});
