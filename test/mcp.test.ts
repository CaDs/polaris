import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POLARIS_PROVIDER = "fake";
process.env.POLARIS_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
const { configure, fileTicket, app, call, tempRepo, until, user } = await import("./helpers.ts");
const { mintToken } = await import("../server/cli/token.ts");
const { handle } = await import("../server/mcp.ts");

const alice = await user("alice");
assert.equal((await configure(alice, { repo_path: tempRepo(), setup_command: "", test_command: "test -f notes.txt", model_review: false })).status, 200);

// The MCP server talks HTTP to Polaris: route its fetches into the app, and catch the Slack webhook posts.
const slack: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).startsWith("https://hooks.slack.test/")) return slack.push(JSON.parse(String(init!.body)).text), new Response("ok");
  return app.request(String(url), init);
}) as typeof fetch;

const tool = async (name: string, args: Record<string, unknown> = {}) =>
  ((await handle({ id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result as { content: { text: string }[]; isError?: boolean };
const text = async (name: string, args?: Record<string, unknown>) => {
  const r = await tool(name, args);
  assert.ok(!r.isError, r.content[0].text);
  return r.content[0].text;
};

test("MCP: a ticket from the conversation to a merge, with a bearer token and a Slack ping", async () => {
  const init = (await handle({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
  assert.equal(init.result.serverInfo.name, "polaris");
  assert.equal(await handle({ method: "notifications/initialized" }), undefined);
  const { tools } = ((await handle({ id: 1, method: "tools/list" })) as any).result;
  assert.deepEqual(tools.map((t: any) => t.name), ["create_ticket", "list_tickets", "ticket_status", "run_ticket", "approve_ticket", "reject_ticket"]);

  assert.match((await tool("list_tickets")).content[0].text, /unauthorized/); // no token yet
  process.env.POLARIS_TOKEN = await mintToken("alice@x.dev");

  assert.match(await text("create_ticket", { title: "Add notes", spec: "Write notes.txt" }), /Created ALI-1 and started an agent/);
  const review = await until("ALI-1 in review", async () => {
    const s = await text("ticket_status", { key: "ali-1" });
    return s.includes("[review]") && s;
  });
  assert.match(review, /Latest run: worker attempt 1, passed/);
  assert.match(review, /Diff \(polaris\/ALI-1.* → main\):[\s\S]*notes\.txt/);
  assert.deepEqual(slack, ["<http://localhost:5173/t/ALI-1|ALI-1 is ready for review>"]);

  assert.match(await text("approve_ticket", { key: "1" }), /^ALI-1 \[done\] Add notes$/);
  assert.match(await text("list_tickets", { status: "done" }), /ALI-1 \[done\]/);
  assert.equal((await tool("ticket_status", { key: "ALI-99" })).isError, true);
});
