// Polaris as an MCP server (stdio), so a chat client (Claude Code, ...) can file, run, review and approve tickets
// without the dashboard. A thin client of the HTTP API: POLARIS_URL (default http://127.0.0.1:3000) and
// POLARIS_TOKEN (npm run token); POLARIS_WEB_URL for dashboard links. Register it in Claude Code with:
//   claude mcp add polaris -e POLARIS_TOKEN=<token> -- node /path/to/polaris/server/mcp.ts
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout; only tools. Logs go to stderr.
import { createInterface } from "node:readline";

const BASE = process.env.POLARIS_URL ?? "http://127.0.0.1:3000";
const WEB = process.env.POLARIS_WEB_URL ?? "http://localhost:5173"; // the dashboard, for links (same as BASE with npm start)
const MAX_DIFF = 60_000; // characters of diff in a status reply; the rest is in the dashboard

type Ticket = { id: string; key: string; number: number; kind: string; title: string; spec: string; status: string; run_status: string | null; runs?: any[] };

export async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${process.env.POLARIS_TOKEN ?? ""}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Polaris is not reachable at ${BASE}: start it (npm run dev) or set POLARIS_URL`);
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(res.status === 401 ? "unauthorized: set POLARIS_TOKEN (npm run token in the Polaris checkout)" : json?.error ?? `HTTP ${res.status}`);
  return json;
}

// "POL-12", "pol-12" or "12" → the ticket's id.
async function idOf(key: string) {
  const n = Number(/(\d+)\s*$/.exec(key)?.[1]);
  const t = ((await api("GET", "/api/tickets")) as Ticket[]).find((t) => t.number === n);
  if (!t) throw new Error(`no ticket ${key}`);
  return t.id;
}

const line = (t: Ticket) => `${t.key} [${t.status}${t.run_status && t.status === "running" ? `/${t.run_status}` : ""}] ${t.kind === "epic" ? "(epic) " : ""}${t.title}`;

async function status(key: string) {
  const t = (await api("GET", `/api/tickets/${await idOf(key)}`)) as Ticket & { children?: Ticket[] };
  const out = [line(t), `Dashboard: ${WEB}/t/${t.number}`];
  const run = t.runs?.filter((r) => r.role === "worker" || r.role === "planner").at(-1);
  if (run) {
    out.push(`Latest run: ${run.role} attempt ${run.attempt}, ${run.status}, ${run.model}${run.finished?.reason ? ` — ${run.finished.reason}` : ""}`);
    const rv = run.last_review;
    if (rv) out.push(`Model review: ${rv.verdict}${rv.findings?.length ? `\n${rv.findings.map((f: any) => `- ${f.file}${f.line ? `:${f.line}` : ""} — ${f.problem} → ${f.fix}`).join("\n")}` : ""}`);
  }
  if (t.children?.length) out.push("Children:", ...t.children.map((c) => `  ${line(c)}`));
  if (t.status === "review") {
    const d = await api("GET", `/api/tickets/${t.id}/diff`);
    out.push(`Diff (${d.branch} → ${d.base_branch}):`, d.diff.length > MAX_DIFF ? `${d.diff.slice(0, MAX_DIFF)}\n… (truncated, ${d.diff.length} chars)` : d.diff);
  }
  return out.join("\n");
}

const str = (description: string) => ({ type: "string", description });
const KEY = { key: str("Ticket key, e.g. POL-12 (or just its number)") };
const TOOLS: { name: string; description: string; inputSchema: any; run: (a: any) => Promise<string> }[] = [
  {
    name: "create_ticket",
    description:
      "File a Polaris ticket and (by default) start an agent on it. Write the spec from the conversation: the goal, the relevant files, constraints and how to tell it is done. Use kind 'epic' for work too big for one agent: a planner splits it.",
    inputSchema: { type: "object", properties: { title: str("Short imperative title"), spec: str("What to do, in Markdown"), kind: { type: "string", enum: ["task", "epic"] }, run: { type: "boolean", description: "Start an agent right away (default true)" } }, required: ["title", "spec"] },
    run: async (a) => {
      const t = (await api("POST", "/api/tickets", { title: a.title, spec: a.spec, kind: a.kind ?? "task" })) as Ticket;
      if (a.run === false) return `Created ${t.key}.`;
      await api("POST", `/api/tickets/${t.id}/runs`);
      return `Created ${t.key} and started ${t.kind === "epic" ? "the planner" : "an agent"}. Check it with ticket_status.`;
    },
  },
  {
    name: "list_tickets",
    description: "List Polaris tickets, optionally only those in one status (backlog, todo, running, review, done, ...).",
    inputSchema: { type: "object", properties: { status: str("Only tickets in this status") } },
    run: async (a) => {
      const ts = ((await api("GET", "/api/tickets")) as Ticket[]).filter((t) => !a.status || t.status === a.status);
      return ts.map(line).join("\n") || "No tickets.";
    },
  },
  {
    name: "ticket_status",
    description: "A ticket's status, its latest run (why it failed, the model review's findings) and, when it waits for review, the diff to approve.",
    inputSchema: { type: "object", properties: KEY, required: ["key"] },
    run: (a) => status(a.key),
  },
  {
    name: "run_ticket",
    description: "Start an agent (or the planner, for an epic) on a ticket.",
    inputSchema: { type: "object", properties: KEY, required: ["key"] },
    run: async (a) => (await api("POST", `/api/tickets/${await idOf(a.key)}/runs`), `Started ${a.key}.`),
  },
  {
    name: "approve_ticket",
    description: "Approve a ticket in review: merges its branch into the base branch. Only on the user's explicit say-so.",
    inputSchema: { type: "object", properties: KEY, required: ["key"] },
    run: async (a) => line(await api("POST", `/api/tickets/${await idOf(a.key)}/approve`)),
  },
  {
    name: "reject_ticket",
    description: "Reject a ticket in review with a note; the note goes to the next attempt.",
    inputSchema: { type: "object", properties: { ...KEY, note: str("What to change") }, required: ["key", "note"] },
    run: async (a) => line(await api("POST", `/api/tickets/${await idOf(a.key)}/reject`, { note: a.note })),
  },
];

// One JSON-RPC message in, the reply out (undefined for notifications).
export async function handle(msg: { id?: number | string; method: string; params?: any }) {
  const reply = (result: unknown) => (msg.id === undefined ? undefined : { jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "polaris", version: "1.0.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } };
      try {
        return reply({ content: [{ type: "text", text: await tool.run(msg.params.arguments ?? {}) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return msg.id === undefined ? undefined : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

if (import.meta.main) {
  for await (const l of createInterface({ input: process.stdin })) {
    if (!l.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(l);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      continue;
    }
    handle(msg).then((r) => r && process.stdout.write(`${JSON.stringify(r)}\n`));
  }
}
