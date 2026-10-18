import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { signUp, tempRepo } from "./helpers.ts";

// A tiny Anthropic-compatible (and Ollama /api/tags) server: a tool call first, then a final answer.
const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
let mock: Server;
let mockUrl = "";
const modelsSeen: string[] = [];

test.beforeAll(async () => {
  mock = createServer(async (req, res) => {
    if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "mock-a" }, { name: "mock-b" }] }));
    if (req.url!.startsWith("/api/")) return void res.writeHead(404).end(); // /api/ps, /api/show: the run falls back to the stored window
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    modelsSeen.push(b.model);
    const tool = !!b.tools && b.messages.at(-1).content[0].type !== "tool_result"; // no tools: an M6 reflection, answered with text
    const echo = b.tools?.[0].name === "echo";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      ...(tool
        ? [
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: echo ? "echo" : "shell", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: echo ? '{"text":"ping"}' : '{"command":"echo from the mock model"}' } },
            { type: "content_block_stop", index: 0 },
          ]
        : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Finished." } },
            { type: "content_block_stop", index: 0 },
          ]),
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
    ]));
  });
  await new Promise<void>((ok) => mock.listen(0, "127.0.0.1", ok));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});
test.afterAll(() => mock.close());

async function addProvider(page: Page, f: { name: string; kind: string; baseUrl?: string; apiKey?: string }) {
  await page.getByRole("button", { name: "Add provider" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill(f.name);
  await d.getByLabel("Kind").selectOption(f.kind);
  if (f.baseUrl) await d.getByLabel("Base URL").fill(f.baseUrl);
  if (f.apiKey) await d.locator("input[name=api_key]").fill(f.apiKey);
  await d.getByRole("button", { name: "Add provider" }).click();
  await expect(d).toBeHidden();
}

test("M4: providers, tool-calling test, masked keys, defaults, model picker and retry-with", async ({ page }) => {
  test.setTimeout(180_000);
  const repo = tempRepo();
  await signUp(page, "Provider");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Setup command").fill("");
  await page.getByLabel("Test command").fill("true");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  const providers = page.getByRole("region", { name: "Providers" });
  const row = (name: string) => providers.getByRole("listitem").filter({ hasText: name });

  // Ollama-kind provider pointing at the mock; Test checks tool calling per model.
  await addProvider(page, { name: "Mock Ollama", kind: "ollama", baseUrl: mockUrl });
  await row("Mock Ollama").getByRole("button", { name: "Test" }).click();
  await expect(row("Mock Ollama").getByLabel("Test results for Mock Ollama")).toContainText("✓ mock-a");
  await expect(row("Mock Ollama").getByLabel("Test results for Mock Ollama")).toContainText("✓ mock-b");

  // API key: write-only, masked to the last 4 characters even after a reload.
  await addProvider(page, { name: "Claude", kind: "anthropic", apiKey: "sk-ant-test-abcd" });
  await expect(row("Claude")).toContainText("••••abcd");
  await page.reload();
  await expect(row("Claude")).toContainText("••••abcd");
  await expect(providers).not.toContainText("sk-ant-test");
  await row("Claude").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog").locator("input[name=api_key]")).toHaveValue("");
  await page.getByRole("button", { name: "Cancel" }).click();

  // Workspace default.
  await providers.getByLabel("Default provider").selectOption({ label: "Claude" });
  await expect(providers.getByLabel("Default model")).toHaveValue("claude-opus-5-5");
  await providers.getByLabel("Default model").selectOption("claude-sonnet-5-5");
  await providers.getByRole("button", { name: "Save default" }).click();
  await expect(providers.getByRole("status")).toHaveText("Default saved");

  // A ticket picks the mock provider and runs on it.
  await page.getByRole("link", { name: "Board" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByRole("dialog").getByLabel("Title").fill("Say hi");
  await page.getByRole("dialog").getByLabel("Spec").fill("run echo");
  await page.getByRole("dialog").getByRole("button", { name: "Create ticket" }).click();
  await page.getByRole("button", { name: /Say hi/ }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption({ label: "Mock Ollama" });
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("mock-a");
  await page.getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 120_000 });
  const runs = page.locator("table.runs");
  await expect(runs.getByRole("row", { name: /#1/ })).toContainText("mock-a");
  expect(modelsSeen.at(-1)).toBe("mock-a");

  // Retry with another model of that provider.
  await runs.getByRole("row", { name: /#1/ }).getByRole("button", { name: "Retry with…" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry with…" });
  await dialog.getByLabel("Model", { exact: true }).selectOption("mock-b");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(runs.getByRole("row", { name: /#1/ })).toHaveCount(2, { timeout: 10_000 });
  await expect(runs.getByRole("row", { name: /mock-b/ })).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveValue("review", { timeout: 120_000 });
  expect(modelsSeen.at(-1)).toBe("mock-b");

  // Board card shows the latest run's model.
  await page.getByRole("link", { name: "Board" }).click();
  await expect(page.getByRole("button", { name: /Say hi/ })).toContainText("mock-b");
});
