// npm run agent -- <ticket-id> [--root DIR] [--model M] [--base-url URL] [--max-turns N] [--max-tokens N]
// npm run agent -- --task "text" ...   (creates a throwaway ticket in workspace "cli")
// Anthropic: ANTHROPIC_API_KEY. Ollama: --base-url http://localhost:11434 --model <name>.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import "../auth.ts"; // creates Better Auth tables (organization) that ours reference
import { db, migrate } from "../db.ts";
import { DEFAULT_MODEL } from "../agent/providers/anthropic.ts";
import { cancelRun, startRun } from "../runs.ts";
import type { AgentEvent } from "../agent/types.ts";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: process.cwd() },
    model: { type: "string", default: DEFAULT_MODEL },
    "base-url": { type: "string", default: process.env.ANTHROPIC_BASE_URL },
    task: { type: "string" },
    "max-turns": { type: "string", default: "50" },
    "max-tokens": { type: "string", default: "2000000" },
  },
});

migrate();
const root = resolve(opt.root);
let runId = "";

let ticketId = positionals[0];
if (!ticketId) {
  if (!opt.task) throw new Error("usage: npm run agent -- <ticket-id> | --task \"text\"");
  let ws = db.prepare("SELECT id FROM organization WHERE slug = 'cli'").get() as { id: string } | undefined;
  if (!ws) {
    ws = { id: randomUUID() };
    db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'cli', 'cli', ?)").run(ws.id, new Date().toISOString());
  }
  ticketId = randomUUID();
  db.prepare("INSERT INTO tickets (id, workspace_id, title) VALUES (?, ?, ?)").run(ticketId, ws.id, opt.task);
}
if (!db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(ticketId)) throw new Error(`ticket not found: ${ticketId}`);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const oneLine = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, "⏎");
let thinking = false;

function print(e: AgentEvent) {
  if (e.type === "run_started") console.log(dim(`${e.payload.model} · ${e.payload.root}`));
  if (e.type === "assistant_message") process.stdout.write("\n");
  if (e.type === "tool_call") console.log(`→ ${e.payload.name} ${oneLine(JSON.stringify(e.payload.input))}`);
  if (e.type === "tool_result") console.log(dim(`  ${e.payload.is_error ? "✗" : "←"} ${oneLine(e.payload.content)}`));
  if (e.type === "error") console.log(`! ${e.payload.kind}: ${e.payload.message}`);
  if (e.type === "run_finished") {
    const u = e.payload.usage;
    console.log(`\n${e.payload.status}${e.payload.reason ? ` (${e.payload.reason})` : ""} · ${e.payload.turns} turns · in ${u.input} out ${u.output} cache r/w ${u.cache_read}/${u.cache_write}`);
  }
}

const started = startRun(ticketId, {
  root,
  model: opt.model,
  baseUrl: opt["base-url"],
  budget: { maxTurns: Number(opt["max-turns"]), maxTokens: Number(opt["max-tokens"]) },
  onEvent: print,
  onStream: (e) => {
    const isThinking = e.type === "reasoning";
    if (isThinking !== thinking) process.stdout.write(isThinking ? dim("thinking: ") : "\n");
    thinking = isThinking;
    if (e.type === "text") process.stdout.write(e.text);
    if (e.type === "reasoning") process.stdout.write(dim(e.text));
  },
});
runId = started.runId;
process.on("SIGINT", () => cancelRun(runId));
const result = await started.done;
process.exit(result.status === "passed" ? 0 : 1);
