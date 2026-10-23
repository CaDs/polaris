import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider, ToolDef } from "./agent/types.ts";
import { truncate } from "./agent/tools.ts";
import { ask } from "./improve.ts";
import { dataDir } from "./sandbox.ts";
import { today } from "./tracker.ts";
import { finishCopy, MEMORY_KINDS, memoryMeta, openCopy, wikiSerial, type Finished, type MemoryEntry } from "./wiki.ts";
import { scrub } from "./egress.ts";

// The project memory (see SPEC "Project memory"): approved decisions, rules and gotchas, one file each under the wiki's
// memory/. A passing run gets a proposal (one model call, proposeMemory); the human confirms or edits it when approving,
// and the approval writes it (writeMemory). Humans can also add an entry directly. Entries are never edited by the
// harness except to mark them superseded.

export type MemoryItem = { kind: (typeof MEMORY_KINDS)[number]; title: string; body: string; supersedes?: string };
const MAX_ITEMS = 3;
const TITLE_MAX = 160;
const BODY_MAX = 2000;
const PROMPT = readFileSync(new URL("./agent/prompts/memory.md", import.meta.url), "utf8");

// Validated entries, or why they are invalid. `active`: the paths of the active entries (what supersedes may name).
export function memoryItems(raw: unknown, active: string[]): MemoryItem[] | string {
  if (!Array.isArray(raw)) return "memory must be a list of {kind, title, body, supersedes?}";
  if (raw.length > MAX_ITEMS) return `at most ${MAX_ITEMS} memory entries at a time`;
  const out: MemoryItem[] = [];
  for (const [i, x] of raw.entries()) {
    if (!x || typeof x !== "object") return `memory[${i}] must be an object {kind, title, body, supersedes?}`;
    const { kind, title, body, supersedes } = x as Record<string, unknown>;
    if (!(MEMORY_KINDS as readonly unknown[]).includes(kind)) return `memory[${i}].kind must be one of ${MEMORY_KINDS.join(", ")}`;
    if (typeof title !== "string" || !title.trim() || title.length > TITLE_MAX || /[\r\n]/.test(title.trim())) return `memory[${i}].title must be one line of at most ${TITLE_MAX} chars`;
    if (typeof body !== "string" || !body.trim() || body.length > BODY_MAX) return `memory[${i}].body must be non-empty text of at most ${BODY_MAX} chars`;
    if (supersedes !== undefined && supersedes !== null && supersedes !== "" && (typeof supersedes !== "string" || !active.includes(supersedes)))
      return `memory[${i}].supersedes must be the path of an active entry`;
    out.push({ kind: kind as MemoryItem["kind"], title: title.trim(), body: body.trim(), ...(typeof supersedes === "string" && supersedes ? { supersedes } : {}) });
  }
  if (new Set(out.flatMap((m) => (m.supersedes ? [m.supersedes] : []))).size < out.filter((m) => m.supersedes).length) return "two entries supersede the same one";
  return out;
}

const SUBMIT: ToolDef = {
  name: "submit_memory",
  description: "Submit the memory entries for this change (an empty list when it settles nothing new). Call it exactly once.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...MEMORY_KINDS] },
            title: { type: "string", description: "The decision, rule or gotcha as one short sentence" },
            body: { type: "string", description: "What was decided, why, and what was turned down (a few lines)" },
            supersedes: { type: "string", description: "The path of the active entry this one replaces, if any" },
          },
          required: ["kind", "title", "body"],
        },
      },
    },
    required: ["entries"],
  },
};

export type ProposalInput = {
  ticket: { key: string; title: string; spec: string }; comments: string[]; rejections: string[]; findings: string[];
  reply: string; files: string[]; diff: string; active: MemoryEntry[];
};

// The proposal's user message.
export function proposalText(o: ProposalInput) {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x.replace(/\n/g, "\n  ")}`).join("\n") : "(none)");
  return [
    `# Ticket\n\n${o.ticket.key} ${o.ticket.title}${o.ticket.spec.trim() ? `\n\n${truncate(o.ticket.spec.trim(), 6000, "head")}` : ""}`,
    `# Comments\n\n${list(o.comments.map((c) => truncate(c, 1500, "head")))}`,
    `# Notes from rejected attempts\n\n${list(o.rejections)}`,
    `# Model review findings\n\n${list(o.findings)}`,
    `# The coding agent's final reply\n\n${o.reply.trim() ? truncate(o.reply.trim(), 4000, "head") : "(none)"}`,
    `# Files changed\n\n${o.files.join("\n") || "(none)"}`,
    `# Diff (may be cut)\n\n\`\`\`diff\n${truncate(o.diff, 8000, "head")}\n\`\`\``,
    `# Active memory entries\n\n${list(o.active.filter((e) => e.status === "active").map((e) => `${e.path} (${e.kind}): ${e.title}`))}`,
  ].join("\n\n");
}

// One model call: the change in, 0–3 validated entries out (or why there are none).
export async function proposeMemory(provider: Provider, model: string, o: ProposalInput, signal?: AbortSignal): Promise<{ items: MemoryItem[] } | { error: string }> {
  try {
    const r = await ask(provider, model, PROMPT, scrub(proposalText(o)), 4096, 120_000, signal, [SUBMIT]);
    const call = r.content.find((b) => b.type === "tool_use" && b.name === SUBMIT.name);
    if (call?.type !== "tool_use") return { error: `the model did not call ${SUBMIT.name}` };
    const items = memoryItems(call.input.entries ?? [], o.active.filter((e) => e.status === "active").map((e) => e.path));
    return typeof items === "string" ? { error: `invalid proposal: ${items}` } : { items: items.map((m) => ({ ...m, title: scrub(m.title), body: scrub(m.body) })) };
  } catch (e) {
    return { error: `memory proposal failed: ${(e as Error).message}` };
  }
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "entry";

// Writes the entries as memory/NNNN-slug.md (numbered after the highest existing one) and marks the entries they supersede,
// in one wiki commit. source: the ticket key, or who added it. label: what the commit and log entry name.
export function writeMemory(pid: string, items: MemoryItem[], source: string, label: string): Promise<Finished & { paths?: string[] }> {
  return wikiSerial(pid, async () => {
    const tmp = join(dataDir(), "worktrees", `wiki-memory-${randomUUID()}`);
    try {
      await openCopy(pid, tmp);
      const dir = join(tmp, "memory");
      mkdirSync(dir, { recursive: true });
      let n = Math.max(0, ...readdirSync(dir).map((f) => Number(/^(\d{4})-/.exec(f)?.[1] ?? 0)));
      const paths: string[] = [];
      for (const m of items) {
        const path = `memory/${String(++n).padStart(4, "0")}-${slug(m.title)}.md`;
        writeFileSync(join(tmp, path), `---\ntitle: ${m.title}\nkind: ${m.kind}\nstatus: active\nsource: ${source}\ndate: ${today()}\n---\n${m.body}\n`);
        paths.push(path);
        if (m.supersedes) {
          const old = readFileSync(join(tmp, m.supersedes), "utf8");
          const meta = memoryMeta(old);
          if (typeof meta === "string" || meta.status !== "active" || !/^status: active$/m.test(old)) throw new Error(`${m.supersedes} is not an active memory entry`);
          writeFileSync(join(tmp, m.supersedes), old.replace(/^status: active$/m, `status: superseded\nsuperseded_by: ${path}`));
        }
      }
      const r = await finishCopy(pid, tmp, `memory: ${label}`, `## [${today()}] memory | ${label}: ${paths.join(", ")}`);
      return "sha" in r ? { ...r, paths } : r;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
