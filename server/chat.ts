import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "./db.ts";
import { addDetached, git, removeWorktree } from "./git.ts";
import { dataDir } from "./sandbox.ts";
import { metaProvider, projectSettings, type ProjectSettings } from "./runs.ts";
import { OWN_RUNS } from "./planner.ts";
import { ESTIMATES, KINDS, ticketKey, trackerHeader } from "./tracker.ts";
import { withUsage } from "./usage.ts";
import { materialize, wikiSection } from "./wiki.ts";
import { listSkills, skillsText } from "./agent/context.ts";
import { runAgent } from "./agent/loop.ts";
import { readOnlyTools, truncate, type Tool } from "./agent/tools.ts";
import { AgentError, type AgentEvent, type Msg } from "./agent/types.ts";

// M13 chat (see SPEC "Chat (M13)"). A member's private conversation with a project: each message is one agent turn on
// a fresh read-only checkout of its base branch, resuming the stored conversation. The agent proposes tickets; only the
// member files them (POST /api/chats/proposals/:id/file in app.ts, which shares the New ticket validation).

export const CHAT_PROMPT = readFileSync(new URL("./agent/prompts/chat.md", import.meta.url), "utf8");
const TURN = { maxTurns: 40, maxTokens: 2_000_000, minutes: 10 }; // per user message
const MESSAGE_MAX = 20_000;
const SPEC_MAX = 4000; // chars of a ticket's spec in a context block

type Env = { Variables: { userId: string; workspaceId: string } };
type Chat = { id: string; workspace_id: string; project_id: string; user_id: string; title: string; messages: string };
export type PageContext = { ticket?: string; project?: string; cycle?: string };
export type ChatEvent = { seq: number; type: string; payload: any; created_at: number };
type Live = ChatEvent | { type: "delta"; text: string };

// --- events: stored (the panel's history) and live (stored ones plus text deltas, which are never stored) ---

const listeners = new Map<string, Set<(e: Live) => void>>();
function emit(chatId: string, e: Live) {
  for (const fn of listeners.get(chatId) ?? []) {
    try {
      fn(e);
    } catch (err) {
      console.error("chat listener failed", err);
    }
  }
}

export function append(chatId: string, type: string, payload: unknown) {
  const now = Date.now();
  const { seq } = db.prepare(`INSERT INTO chat_events (chat_id, seq, type, payload, created_at)
    SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM chat_events WHERE chat_id = ? RETURNING seq`).get(chatId, type, JSON.stringify(payload), now, chatId) as { seq: number };
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);
  emit(chatId, { seq, type, payload, created_at: now });
}

const eventsOf = (chatId: string) =>
  (db.prepare("SELECT seq, type, payload, created_at FROM chat_events WHERE chat_id = ? ORDER BY seq").all(chatId) as Record<string, any>[]).map((e) => ({ ...e, payload: JSON.parse(e.payload) }) as ChatEvent);

// A turn in flight per chat: one at a time, cancellable.
const busy = new Map<string, AbortController>();

// A server restart ends the turns it was running: their chats get the turn_finished they never logged.
export function recoverChats() {
  const open = db.prepare(`SELECT c.id FROM chats c WHERE (SELECT type FROM chat_events WHERE chat_id = c.id ORDER BY seq DESC LIMIT 1) NOT IN ('turn_finished')`).all() as { id: string }[];
  for (const c of open) append(c.id, "turn_finished", { status: "failed", reason: "interrupted: the server restarted" });
}

// --- context: what the user is looking at and the tickets they @-mention, resolved in their workspace ---

// "POL-12" (any project of the workspace) or "12" (the chat's project).
const ticketByKey = (chat: Chat, key: string) => {
  const n = /^(?:([A-Za-z][A-Za-z0-9]{1,4})-)?(\d+)$/.exec(key.trim());
  if (!n) return undefined;
  const p = n[1] ? (db.prepare("SELECT id FROM projects WHERE workspace_id = ? AND key = ?").get(chat.workspace_id, n[1].toUpperCase()) as { id: string } | undefined)?.id : chat.project_id;
  return db.prepare(`SELECT t.*, ${ticketKey()} AS key FROM tickets t WHERE t.project_id = ? AND t.number = ? AND t.hidden = 0`).get(p ?? "", Number(n[2])) as Record<string, any> | undefined;
};

function ticketText(t: Record<string, any>) {
  const run = db.prepare(`SELECT r.status, r.attempt, (SELECT payload FROM events WHERE run_id = r.id AND type = 'run_finished' ORDER BY seq DESC LIMIT 1) AS finished
    FROM runs r WHERE r.ticket_id = ? AND ${OWN_RUNS} ORDER BY r.rowid DESC LIMIT 1`).get(t.id) as { status: string; attempt: number; finished: string | null } | undefined;
  const reason = run?.finished && JSON.parse(run.finished).reason;
  const header = trackerHeader(t.id);
  const lines = [`## ${t.key} ${t.title}`, `- Status: ${t.status}; kind: ${t.kind}${t.test_command ? `; test command: \`${t.test_command}\`` : ""}`];
  if (run) lines.push(`- Latest run: attempt ${run.attempt}, ${run.status}${reason ? ` (${reason})` : ""}`);
  if (header) lines.push(header);
  if (t.kind === "epic") {
    const kids = db.prepare(`SELECT ${ticketKey()} AS key, t.status, t.title FROM tickets t WHERE t.parent_id = ? ORDER BY t.number`).all(t.id) as Record<string, string>[];
    lines.push(`- Children: ${kids.length ? kids.map((k) => `${k.key} [${k.status}] ${k.title}`).join("; ") : "none yet"}`);
  }
  if (t.spec) lines.push("", truncate(t.spec, SPEC_MAX, "head", "[… truncated]"));
  return lines.join("\n");
}

const openTickets = (ws: string, where: string, id: string) =>
  (db.prepare(`SELECT ${ticketKey()} AS key, t.status, t.title FROM tickets t
    WHERE t.workspace_id = ? AND t.${where} = ? AND t.status <> 'done' AND t.hidden = 0 ORDER BY t.number`).all(ws, id) as Record<string, string>[]).map((t) => `- ${t.key} [${t.status}] ${t.title}`);

// The "# Context" block ahead of a message ("" when there is none). Unknown ids and keys are left out.
export function contextText(chat: Chat, text: string, ctx: PageContext = {}) {
  const ws = chat.workspace_id;
  const parts: string[] = [];
  const page = ctx.ticket ? ticketByKey(chat, ctx.ticket) : undefined;
  if (page) parts.push(`The user is looking at this ticket:\n\n${ticketText(page)}`);
  const project = ctx.project && (db.prepare("SELECT id, name, description FROM projects WHERE id = ? AND workspace_id = ?").get(ctx.project, ws) as Record<string, string> | undefined);
  if (project) parts.push(`The user is looking at the project "${project.name}"${project.description ? `: ${project.description}` : ""}\n\nOpen tickets:\n${openTickets(ws, "project_id", project.id).join("\n") || "(none)"}`);
  const cycle = ctx.cycle && (db.prepare("SELECT id, number, name FROM cycles WHERE id = ? AND workspace_id = ?").get(ctx.cycle, ws) as Record<string, any> | undefined);
  if (cycle) parts.push(`The user is looking at cycle ${cycle.number}${cycle.name ? ` "${cycle.name}"` : ""}\n\nOpen tickets:\n${openTickets(ws, "cycle_id", cycle.id).join("\n") || "(none)"}`);
  const mentioned = [...new Set([...text.matchAll(/@([A-Za-z][A-Za-z0-9]{1,4}-\d+)\b/g)].map((m) => m[1].toUpperCase()))].slice(0, 5);
  const tickets = mentioned.flatMap((k) => (k === page?.key ? [] : (ticketByKey(chat, k) ?? [])));
  if (tickets.length) parts.push(`Mentioned tickets:\n\n${tickets.map(ticketText).join("\n\n")}`);
  return parts.length ? `# Context\n\n${parts.join("\n\n")}` : "";
}

// --- tools ---

const str = (input: Record<string, unknown>, key: string, max: number, required = true) => {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new AgentError("InvalidArguments", `"${key}" is required (a string of 1-${max} chars)`);
    return undefined;
  }
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new AgentError("InvalidArguments", `"${key}" must be a string of 1-${max} chars`);
  return v.trim();
};

function chatTools(chat: Chat): Tool[] {
  return [
    {
      def: {
        name: "list_tickets",
        description: "Tickets of this project, newest first (at most 50): key, status, title. Use it to find existing work before proposing.",
        input_schema: {
          type: "object",
          properties: { status: { type: "string", description: "Only this status: backlog, todo, running, review, done or failed" }, query: { type: "string", description: "Only tickets whose title or spec contains this text" } },
        },
      },
      async run(input) {
        const status = str(input, "status", 20, false);
        const query = str(input, "query", 200, false);
        const rows = db.prepare(`SELECT ${ticketKey()} AS key, t.status, t.kind, t.title FROM tickets t
          WHERE t.project_id = ? AND t.hidden = 0 AND (? IS NULL OR t.status = ?) AND (? IS NULL OR instr(lower(t.title || ' ' || t.spec), lower(?)) > 0)
          ORDER BY t.number DESC LIMIT 50`).all(chat.project_id, status ?? null, status ?? null, query ?? null, query ?? null) as Record<string, string>[];
        return rows.map((t) => `${t.key} [${t.status}]${t.kind === "epic" ? " (epic)" : ""} ${t.title}`).join("\n") || "No tickets match.";
      },
    },
    {
      def: {
        name: "read_ticket",
        description: "A ticket's status, latest run, tracker fields, children (an epic) and spec.",
        input_schema: { type: "object", properties: { key: { type: "string", description: "Ticket key, e.g. POL-12" } }, required: ["key"] },
      },
      async run(input) {
        const t = ticketByKey(chat, str(input, "key", 20)!);
        if (!t) throw new AgentError("InvalidArguments", `no ticket ${String(input.key)} in this workspace`);
        return ticketText(t);
      },
    },
    {
      def: {
        name: "propose_ticket",
        description: "Propose a ticket. The user sees it as a card and decides whether to file it; it is not a ticket until they do. Returns its number (P1, P2, ...).",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title" },
            spec: { type: "string", description: "Self-contained task: goal, files/areas, conventions, acceptance criteria in terms of what the test gate checks" },
            kind: { type: "string", enum: KINDS, description: "epic = several dependent steps, split by a planner agent later (default task)" },
            test_command: { type: "string", description: "Only when this ticket needs its own gate instead of the workspace's test command" },
            priority: { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 none, 1 urgent, 2 high, 3 medium, 4 low" },
            estimate: { type: "integer", enum: ESTIMATES, description: "Size in points" },
            replaces: { type: "string", description: "The number of an earlier proposal this one replaces, e.g. P1" },
          },
          required: ["title", "spec"],
        },
      },
      async run(input) {
        const kind = input.kind ?? "task";
        if (!KINDS.includes(kind as string)) throw new AgentError("InvalidArguments", '"kind" must be "task" or "epic"');
        const priority = input.priority ?? 0;
        if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 4) throw new AgentError("InvalidArguments", '"priority" must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)');
        const estimate = input.estimate ?? null;
        if (estimate !== null && !ESTIMATES.includes(estimate as number)) throw new AgentError("InvalidArguments", `"estimate" must be one of ${ESTIMATES.join(", ")}`);
        const payload = { title: str(input, "title", 200)!, spec: str(input, "spec", 20_000)!, kind, test_command: str(input, "test_command", 2000, false) ?? null, priority, estimate };
        const replaces = str(input, "replaces", 10, false);
        const old = replaces && (db.prepare("SELECT id, status FROM chat_proposals WHERE chat_id = ? AND number = ?").get(chat.id, Number(/\d+/.exec(replaces)?.[0])) as { id: string; status: string } | undefined);
        if (replaces && !old) throw new AgentError("InvalidArguments", `no proposal ${replaces} in this chat`);
        if (old && old.status !== "open") throw new AgentError("InvalidArguments", `${replaces} is ${old.status} and cannot be replaced; propose a new ticket without replaces`);
        const id = randomUUID();
        const { number } = db.prepare(`INSERT INTO chat_proposals (id, chat_id, number, payload) SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ? FROM chat_proposals WHERE chat_id = ? RETURNING number`)
          .get(id, chat.id, JSON.stringify(payload), chat.id) as { number: number };
        if (old) db.prepare("UPDATE chat_proposals SET status = 'superseded' WHERE id = ?").run(old.id);
        append(chat.id, "proposal", { proposal_id: id, number, replaces: old ? old.id : undefined });
        return `Proposed P${number} "${payload.title}"${old ? ` (replaces ${replaces})` : ""}. The user sees it as a card with File and Dismiss buttons; it is not a ticket until they file it.`;
      },
    },
  ];
}

// --- a turn ---

const userMsg = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const firstText = (m: Msg) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
// Shown in the panel as they happen; usage, run_started/run_finished and metrics are not part of a chat.
const SHOWN = new Set(["assistant_message", "tool_call", "tool_result", "error", "compaction", "stuck"]);

function environment(s: ProjectSettings, sha: string) {
  return [
    "# Environment",
    `- Repository: ${basename(s.repo_path)}; read_file and search see a read-only checkout of ${s.base_branch}, refreshed to its latest commit on every message (now ${sha.slice(0, 8)})`,
    `- Test gate of every ticket: ${s.test_command.trim() ? `\`${s.test_command}\` must exit 0` : "no test command"}`,
  ].join("\n");
}

// Runs one turn and stores its events and the conversation. A later turn that does not finish keeps the user's message in
// the conversation with a note, so the next turn knows it was asked and never resumes a dangling tool call.
async function turn(chat: Chat, message: string, signal: AbortSignal) {
  const ws = chat.workspace_id;
  const s = projectSettings(chat.project_id);
  const worktree = join(dataDir(), "worktrees", `chat-${randomUUID()}`);
  const prior = JSON.parse(chat.messages) as Msg[];
  let messages: Msg[] | undefined;
  let finished: { status: string; reason?: string } = { status: "failed", reason: "the turn did not start" };
  let added = false;
  try {
    if (!s) throw new AgentError("UnexpectedEnvironment", "the chat's project was deleted");
    mkdirSync(join(dataDir(), "worktrees"), { recursive: true });
    const sha = await git(s.repo_path, ["rev-parse", "--verify", `refs/heads/${s.base_branch}^{commit}`]);
    await addDetached(s.repo_path, sha, worktree);
    added = true;
    let wiki = "";
    if (s.wiki)
      try {
        await materialize(chat.project_id, worktree);
        if (!prior.length) wiki = await wikiSection(chat.project_id, s.repo_path, sha);
      } catch (e) {
        append(chat.id, "error", { kind: "UnexpectedEnvironment", message: `project wiki unavailable: ${(e as Error).message}` });
      }
    const task = prior.length ? firstText(prior[0]) : [environment(s, sha), skillsText(listSkills(worktree, "chat")), wiki, message].filter(Boolean).join("\n\n");
    const { provider, model } = metaProvider(ws, "chat");
    const a = await withUsage({ workspaceId: ws, purpose: "chat", background: true }, () =>
      runAgent({
        provider, model, system: CHAT_PROMPT, task, resume: prior.length ? { messages: prior, message } : undefined,
        tools: [...readOnlyTools, ...chatTools(chat)], root: worktree, cacheKey: chat.id, signal,
        budget: { maxTurns: TURN.maxTurns, maxTokens: TURN.maxTokens, deadline: Date.now() + TURN.minutes * 60_000, minutes: TURN.minutes },
        finishHint: "Reply to the user now with what you have.",
        onEvent: (e: AgentEvent) => SHOWN.has(e.type) && append(chat.id, e.type, e.payload),
        onStream: (e) => e.type === "text" && emit(chat.id, { type: "delta", text: e.text }),
      }));
    finished = { status: a.status, reason: a.reason };
    if (a.status === "passed") messages = a.messages;
  } catch (e) {
    finished = { status: "failed", reason: (e as Error).message };
    append(chat.id, "error", { kind: e instanceof AgentError ? e.kind : "Unknown", message: (e as Error).message });
  } finally {
    if (added) await removeWorktree(s!.repo_path, worktree, null, dataDir()).catch((e) => console.error("chat worktree", e));
  }
  if (!db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chat.id)) return; // deleted while it ran
  // A failed first turn leaves the conversation empty: the next message starts it again, environment included.
  messages ??= prior.length ? [...prior, userMsg(message), { role: "assistant", content: [{ type: "text", text: `[harness] This reply did not finish (${finished.status}${finished.reason ? `: ${finished.reason}` : ""}).` }] }] : [];
  db.prepare("UPDATE chats SET messages = ? WHERE id = ?").run(JSON.stringify(messages), chat.id);
  append(chat.id, "turn_finished", finished);
}

// Stores the user's message and starts its turn in the background. The model sees the message behind its context block.
function start(chat: Chat, text: string, ctx: PageContext) {
  const context = contextText(chat, text, ctx);
  append(chat.id, "user_message", { text, context: ctx });
  const ctl = new AbortController();
  busy.set(chat.id, ctl);
  void turn(chat, context ? `${context}\n\n# Message\n\n${text}` : text, ctl.signal)
    .catch((e) => console.error("chat turn", e))
    .finally(() => busy.delete(chat.id));
}

// --- routes (mounted at /api/chats; a member sees only their own chats in the active workspace, of every project) ---

export const chatRoutes = new Hono<Env>();

const chatIn = (c: Context<Env>, id = c.req.param("id") as string) =>
  db.prepare("SELECT * FROM chats WHERE id = ? AND workspace_id = ? AND user_id = ?").get(id, c.get("workspaceId"), c.get("userId")) as Chat | undefined;

export const proposalIn = (c: Context<Env>, id = c.req.param("id") as string) =>
  db.prepare(`SELECT p.*, c.id AS chat_id, c.title AS chat_title, c.project_id FROM chat_proposals p JOIN chats c ON c.id = p.chat_id WHERE p.id = ? AND c.workspace_id = ? AND c.user_id = ?`)
    .get(id, c.get("workspaceId"), c.get("userId")) as { id: string; chat_id: string; chat_title: string; project_id: string; status: string; payload: string } | undefined;

async function messageBody(c: Context<Env>) {
  const b = await c.req.json().catch(() => null);
  const text = typeof b?.message === "string" ? b.message.trim() : "";
  if (!text || text.length > MESSAGE_MAX) return { error: `message must be a string of 1-${MESSAGE_MAX} chars` };
  const ctx: PageContext = {};
  for (const k of ["ticket", "project", "cycle"] as const) if (typeof b?.context?.[k] === "string") ctx[k] = b.context[k].slice(0, 100);
  return { text, ctx, project_id: typeof b?.project_id === "string" ? b.project_id : undefined };
}

const proposalsOf = (chatId: string) =>
  (db.prepare(`SELECT p.id, p.number, p.payload, p.status, p.ticket_id, CASE WHEN t.id IS NULL THEN NULL ELSE ${ticketKey()} END AS ticket_key, t.number AS ticket_number
    FROM chat_proposals p LEFT JOIN tickets t ON t.id = p.ticket_id WHERE p.chat_id = ? ORDER BY p.number`).all(chatId) as Record<string, any>[])
    .map((p) => ({ ...p, payload: JSON.parse(p.payload) }));

chatRoutes.get("/", (c) =>
  c.json(db.prepare(`SELECT c.id, c.title, c.project_id, p.key AS project_key, p.name AS project_name, c.created_at, c.updated_at FROM chats c JOIN projects p ON p.id = c.project_id
    WHERE c.workspace_id = ? AND c.user_id = ? ORDER BY c.updated_at DESC LIMIT 50`).all(c.get("workspaceId"), c.get("userId"))));

// {message, context?, project_id}: the project the chat talks about, for good.
chatRoutes.post("/", async (c) => {
  const m = await messageBody(c);
  if ("error" in m) return c.json(m, 400);
  const project = m.project_id && db.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").get(m.project_id, c.get("workspaceId"));
  if (!project) return c.json({ error: "project_id: no such project in this workspace" }, 400);
  const id = randomUUID();
  db.prepare("INSERT INTO chats (id, workspace_id, project_id, user_id, title) VALUES (?, ?, ?, ?, ?)").run(id, c.get("workspaceId"), m.project_id!, c.get("userId"), m.text.split("\n")[0].slice(0, 80));
  const chat = chatIn(c, id)!;
  start(chat, m.text, m.ctx);
  return c.json({ id, title: chat.title, project_id: chat.project_id, busy: true }, 201);
});

chatRoutes.get("/:id", (c) => {
  const chat = chatIn(c);
  if (!chat) return c.json({ error: "not_found" }, 404);
  return c.json({ id: chat.id, title: chat.title, project_id: chat.project_id, busy: busy.has(chat.id), events: eventsOf(chat.id), proposals: proposalsOf(chat.id) });
});

chatRoutes.post("/:id/messages", async (c) => {
  const chat = chatIn(c);
  if (!chat) return c.json({ error: "not_found" }, 404);
  if (busy.has(chat.id)) return c.json({ error: "Polaris is still answering the previous message." }, 409);
  const m = await messageBody(c);
  if ("error" in m) return c.json(m, 400);
  start(chat, m.text, m.ctx);
  return c.json({ ok: true }, 202);
});

chatRoutes.post("/:id/cancel", (c) => {
  const chat = chatIn(c);
  if (!chat) return c.json({ error: "not_found" }, 404);
  const ctl = busy.get(chat.id);
  if (!ctl) return c.json({ error: "nothing to stop" }, 409);
  ctl.abort();
  return c.json({ ok: true });
});

chatRoutes.delete("/:id", (c) => {
  const chat = chatIn(c);
  if (!chat) return c.json({ error: "not_found" }, 404);
  busy.get(chat.id)?.abort();
  db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
  return c.body(null, 204);
});

chatRoutes.post("/proposals/:id/dismiss", (c) => {
  const p = proposalIn(c);
  if (!p) return c.json({ error: "not_found" }, 404);
  if (!db.prepare("UPDATE chat_proposals SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(p.id).changes) return c.json({ error: `this proposal is already ${p.status}` }, 409);
  return c.json({ ok: true });
});

// Stored events (all, then live ones de-duped by seq) and text deltas while a turn runs. Stays open across turns; the
// client closes it when it switches chats.
chatRoutes.get("/:id/stream", (c) => {
  const chat = chatIn(c);
  if (!chat) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    const queue: Live[] = [];
    let wake = () => {};
    let closed = false;
    const set = listeners.get(chat.id) ?? new Set();
    const fn = (e: Live) => (queue.push(e), wake());
    listeners.set(chat.id, set.add(fn));
    stream.onAbort(() => ((closed = true), wake()));
    queue.unshift(...eventsOf(chat.id));
    let last = 0;
    try {
      while (!closed) {
        const e = queue.shift();
        if (!e) {
          const timer = setTimeout(() => wake(), 25_000);
          await new Promise<void>((resolve) => (wake = resolve));
          clearTimeout(timer);
          if (!queue.length && !closed) await stream.write(": keepalive\n\n");
          continue;
        }
        if (e.type === "delta") await stream.writeSSE({ event: "delta", data: JSON.stringify(e) });
        else if ((e as ChatEvent).seq > last) {
          last = (e as ChatEvent).seq;
          await stream.writeSSE({ id: String(last), data: JSON.stringify(e) });
        }
      }
    } finally {
      set.delete(fn);
      if (!set.size) listeners.delete(chat.id);
    }
  });
});
