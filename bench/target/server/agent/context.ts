import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./types.ts";

// Skills: markdown files with `name`/`description` frontmatter in <root>/.harness/skills/ (committed by humans, with
// optional scripts next to them). Only name, description and path are offered, in the first user message; the model
// reads the full file with read_file when it is relevant. Sorted by file name so the message is stable.
export type Skill = { name: string; description: string; path: string };

export function listSkills(root: string): Skill[] {
  const dir = join(root, ".harness/skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf8"))?.[1] ?? "";
    const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
    return { name: get("name") || f.slice(0, -3), description: get("description"), path: `.harness/skills/${f}` };
  });
}

export const skillsText = (skills: Skill[]) =>
  skills.length
    ? `Skills (read the file with read_file when one is relevant; bundled scripts sit next to it):\n${skills.map((s) => `- ${s.name} — ${s.description} — ${s.path}`).join("\n")}`
    : "";

export const SUMMARY_REQUEST =
  "The context is about to be compacted. Write a progress summary of this session for yourself: what is done, what is left, key files (paths) and facts you will need, and open problems. Do not call any tools in this reply: answer with text only.";
export const CONTINUE_REQUEST = "Your previous reply was cut off by the output token limit. Continue exactly where you left off.";

// First message of the conversation that replaces a compacted one.
export const compactedTask = (task: string, summary: string, historyPaths: string[]) =>
  `${task}\n\nContext was compacted. Summary:\n${summary}\n\nFull history: ${historyPaths.join(", ")} (search it with rg/read_file if a detail is missing)`;

// Readable markdown of one conversation: every message, tool call (with input) and tool result in full.
export function historyMarkdown(messages: Msg[], n: number) {
  const fence = (s: string) => {
    const ticks = "`".repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}\n${s}\n${ticks}`;
  };
  const out = [`# Conversation history ${n}`];
  messages.forEach((m, i) => {
    out.push(`\n## Message ${i + 1} (${m.role})`);
    for (const b of m.content) {
      if (b.type === "text") out.push(`\n${b.text}`);
      else if (b.type === "tool_use") out.push(`\n### Tool call ${b.name} (${b.id})\n${fence(JSON.stringify(b.input, null, 2))}`);
      else if (b.type === "tool_result") out.push(`\n### Tool result (${b.tool_use_id})${b.is_error ? " [error]" : ""}\n${fence(b.content)}`);
      else out.push("\n[reasoning omitted]");
    }
  });
  return out.join("\n") + "\n";
}
