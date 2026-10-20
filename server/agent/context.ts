import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncate, type Exec } from "./tools.ts";
import type { Msg } from "./types.ts";

// Skills: markdown files with `name`/`description` frontmatter in <root>/.polaris/skills/ (committed by humans, with
// optional scripts next to them). Only name, description and path are offered, in the first user message; the model
// reads the full file with read_file when it is relevant. Sorted by file name so the message is stable.
// `phases: worker, reviewer` (or `[worker, reviewer]`) offers a skill only to those agents; without it, the worker and
// the planner see it (as before phases existed).
export type Skill = { name: string; description: string; path: string };
export const PHASES = ["worker", "planner", "reviewer", "chat"] as const;
export type Phase = (typeof PHASES)[number];

export function listSkills(root: string, phase: Phase): Skill[] {
  const dir = join(root, ".polaris/skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().flatMap((f) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), "utf8"))?.[1] ?? "";
    const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
    const phases = get("phases").replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase()).filter(Boolean);
    if (!(phases.length ? phases : ["worker", "planner"]).includes(phase)) return [];
    return [{ name: get("name") || f.slice(0, -3), description: get("description"), path: `.polaris/skills/${f}` }];
  });
}

export const skillsText = (skills: Skill[]) =>
  skills.length
    ? `Skills (read the file with read_file when one is relevant; bundled scripts sit next to it):\n${skills.map((s) => `- ${s.name} — ${s.description} — ${s.path}`).join("\n")}`
    : "";

export const SUMMARY_REQUEST =
  "The context is about to be compacted. Write a progress summary of this session for yourself, with exactly these headings:\n## Goal\n## Done\n## Decisions (and why)\n## Key facts (file:line -> the fact you will need, so you do not have to re-read whole files)\n## Left\n## Next step\nDo not call any tools in this reply: answer with text only.";
export const CONTINUE_REQUEST = "Your previous reply was cut off by the output token limit. Continue exactly where you left off.";

const MAX_DIFF = 12_000;

// What the change looks like right now (git status + diff), so the agent need not re-read what it edited. "" when root is
// not a git repo or nothing changed. Untracked files show as ?? in the status (their content is not in the diff).
export async function workState(exec: Exec, root: string, signal?: AbortSignal) {
  try {
    const git = (cmd: string) => exec(cmd, { cwd: root, timeoutMs: 30_000, signal });
    const status = await git("git status --short -- . ':!.polaris/history' ':!.polaris/outputs'");
    if (status.code !== 0 || !status.stdout.trim()) return "";
    const diff = await git("git diff");
    const d = diff.code === 0 ? diff.stdout : "";
    return `\n\nCurrent state of your change (git status --short):\n${status.stdout.trimEnd()}` +
      (d ? `\n\ngit diff (tracked files):\n${truncate(d.trim(), MAX_DIFF, "head", `[diff truncated at ${MAX_DIFF} chars; run git diff for the rest]`)}` : "");
  } catch {
    return "";
  }
}

// Paths the conversation read with read_file, de-duplicated, in first-read order.
export const readPaths = (messages: Msg[]) =>
  [...new Set(messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_use" && b.name === "read_file" && typeof b.input.path === "string" ? [b.input.path] : []))))];

// First message of the conversation that replaces a compacted one. state: workState() output.
export const compactedTask = (task: string, summary: string, historyPaths: string[], state = "", read: string[] = []) =>
  `${task}\n\nContext was compacted. Summary:\n${summary}${state}` +
  (read.length ? `\n\nFiles you had read (re-read only what you need; the Key facts above may be enough): ${read.join(", ")}` : "") +
  `\n\nFull history: ${historyPaths.join(", ")} (search it with rg/read_file if a detail is missing)`;

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
