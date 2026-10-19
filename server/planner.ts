import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "./db.ts";
import { touch } from "./agent/events.ts";
import { skillsText, type Skill } from "./agent/context.ts";
import { readOnlyTools, truncate, type Tool } from "./agent/tools.ts";
import { AgentError, type Msg } from "./agent/types.ts";
import { applyTracker, ESTIMATES, Invalid, KINDS, labelIds, ticketKey, trackerHeader } from "./tracker.ts";

// M7 planner (see SPEC "Planner (M7)"). An epic's runs are planner rounds: each a fresh conversation with a read-only
// checkout, the planner prompt file and the tools below. Children are ordinary tickets with parent_id = the epic; each
// worker hands back one "## Handoff". The orchestration (queueing, rounds, settling) lives in runs.ts.

export const MAX_CHILDREN = 12; // per epic, including failed ones
// Planner rounds per epic. A round starts only when the planner has something to act on (runs.ts wake): a child failed
// (or was deleted), or no child is open any more. A child that is done while siblings are still open starts none: the
// harness queues its dependents, and the next round reads its handoff, marked new. So rounds grow with failures, not children.
export const MAX_ROUNDS = 8;
const HANDOFF_MAX = 4000; // chars
// Not versioned like the worker prompt: there is no eval loop that could score planning yet, so a file is enough.
export const PLANNER_PROMPT = readFileSync(new URL("./agent/prompts/planner.md", import.meta.url), "utf8");

// --- handoffs ---

// Goes into the first user message of a child's worker, ahead of the ticket.
export const handoffRequest = (epic: { key: string; title: string }) =>
  `# Epic\n\nThis ticket is one part of the epic ${epic.key} "${epic.title}". A planner agent split the epic into tickets that other agents work on separately: do only this ticket. End your final reply with a "## Handoff" section for the planner: results (what you changed), concerns (risks, shortcuts, anything left undone) and findings (facts about the code that the planner or later tickets need).`;

export const finalText = (messages: Msg[]) =>
  (messages.findLast((m) => m.role === "assistant")?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();

// The text after a "Handoff" heading (any level), else the whole reply; truncated.
export function extractHandoff(text: string) {
  const m = /^#{1,6}[ \t]*Handoff\b[^\n]*$/im.exec(text);
  const s = (m ? text.slice(m.index + m[0].length) : text).trim();
  return truncate(s, HANDOFF_MAX, "head", "[… truncated]");
}

// failure: why the series failed (reason + gate output tail), appended to whatever the worker handed off.
export function handoffText(reply: string, failure?: string) {
  const h = extractHandoff(reply);
  return failure ? `${h ? `${h}\n\n` : ""}The run failed: ${failure}` : h || "(the worker wrote no final reply)";
}

// --- children ---

type Child = {
  id: string; key: string; title: string; kind: string; status: string; depends_on: string; handoff: string | null; settled_at: number | null;
  test_command: string | null; escalated_to: string | null; run_count: number; run_status: string | null; attempt: number | null; model: string | null; tokens: number;
};

// A ticket's own runs: not eval case runs (M6) or wiki runs (M10), which hang off a ticket but never change its state or totals.
export const OWN_RUNS = "eval_run_id IS NULL AND role <> 'wiki'";
// d = the ticket bound to ? and all of its descendants (epic → children → a sub-epic's children).
export const TREE = "WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tickets t JOIN d ON t.parent_id = d.id)";

export const childrenOf = (epicId: string) =>
  db.prepare(`SELECT t.id, t.title, t.kind, t.status, t.depends_on, t.handoff, t.settled_at, t.test_command, t.escalated_to, ${ticketKey()} AS key,
      (SELECT COUNT(*) FROM runs WHERE ticket_id = t.id AND ${OWN_RUNS}) AS run_count,
      r.status AS run_status, r.attempt, r.model, COALESCE(r.tokens_in + r.tokens_out, 0) AS tokens
    FROM tickets t JOIN organization o ON o.id = t.workspace_id
    LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE ticket_id = t.id AND ${OWN_RUNS} ORDER BY rowid DESC LIMIT 1)
    WHERE t.parent_id = ? ORDER BY t.number`).all(epicId) as Child[];

type State = { label: string; open: boolean };
type Sibling = { id: string; key: string; status: string; depends_on: string; run_status: string | null; run_count: number; escalated_to: string | null };

// What each sibling is doing, as the planner and the epic view show it. Open children keep the epic from completing.
// A todo child whose dependency failed, was deleted or is itself blocked is blocked: it never starts on its own, so it is not open.
// A child replaced by a "Split:" epic (M9) is not open either; its dependents were moved to that epic.
function childStates(kids: Sibling[]) {
  const byId = new Map(kids.map((k) => [k.id, k]));
  const out = new Map<string, State>();
  const state = (k: Sibling): State => {
    const known = out.get(k.id);
    if (known) return known;
    let s: State;
    if (k.status === "failed" && k.escalated_to) s = { label: `split into ${byId.get(k.escalated_to)?.key ?? "an epic"} (failed as one ticket)`, open: false };
    else if (k.status === "done" || k.status === "failed") s = { label: k.status, open: false };
    else if (k.status === "review") s = { label: "in review (passed the gate, waiting to be merged)", open: true };
    else if (k.status === "running") s = { label: k.run_status === "queued" ? "queued" : "running", open: true };
    else {
      const ids = JSON.parse(k.depends_on) as string[];
      const deps = ids.flatMap((id) => byId.get(id) ?? []);
      const dead = deps.find((d) => d.status === "failed" || (d.status !== "done" && !state(d).open));
      const waiting = deps.filter((d) => d.status !== "done");
      if (deps.length < ids.length) s = { label: "blocked (dependency deleted)", open: false };
      else if (dead) s = { label: `blocked (dependency ${dead.key} ${dead.status === "failed" ? "failed" : "is blocked"})`, open: false };
      else if (waiting.length) s = { label: `waiting on ${waiting.map((d) => d.key).join(", ")}`, open: true };
      else s = { label: k.run_count ? "todo (stopped; a human must run it again)" : "todo", open: true };
    }
    out.set(k.id, s);
    return s;
  };
  kids.forEach(state);
  return out;
}

export const openChildren = (kids: Child[]) => {
  const s = childStates(kids);
  return kids.filter((k) => s.get(k.id)!.open).map((k) => `${k.key} (${s.get(k.id)!.label})`);
};

// Ticket rows of a tree (epic view): each gets its state label and its dependencies' keys, computed per sibling group.
export function withStates<T extends Sibling & { parent_id: string | null }>(rows: T[]) {
  const groups = Map.groupBy(rows, (r) => r.parent_id);
  const states = new Map([...groups.values()].flatMap((g) => [...childStates(g)]));
  const keys = new Map(rows.map((r) => [r.id, r.key]));
  return rows.map((r) => ({ ...r, label: states.get(r.id)!.label, depends_keys: (JSON.parse(r.depends_on) as string[]).map((id) => keys.get(id) ?? "?") }));
}

// The children section of a round's first message and the list_children result. since: when the previous round started;
// children that settled after it are marked new.
function childrenText(epicId: string, since: number) {
  const kids = childrenOf(epicId);
  if (!kids.length) return "(none yet)";
  const states = childStates(kids);
  const keyOf = new Map(kids.map((k) => [k.id, k.key]));
  return kids.map((k) => {
    const deps = (JSON.parse(k.depends_on) as string[]).map((id) => keyOf.get(id) ?? "?");
    return [
      `## ${k.key} ${k.title} — ${states.get(k.id)!.label}${(k.settled_at ?? 0) > since ? " (new since your last round)" : ""}`,
      `Kind: ${k.kind}${deps.length ? ` · depends on ${deps.join(", ")}` : ""}${k.test_command ? ` · test command: \`${k.test_command}\`` : ""} · latest run: ${k.run_status ? `#${k.attempt} ${k.run_status}, ${k.model}, ${k.tokens} tokens` : "none"}`,
      `${k.kind === "epic" ? "Summary" : "Handoff"}:${k.handoff ? `\n${k.handoff}` : " (none yet)"}`,
    ].join("\n");
  }).join("\n\n");
}

// --- a round's first message ---

type Epic = { id: string; workspace_id: string; key: string; title: string; spec: string; parent_id: string | null; provider_id: string | null; model: string | null };

export function plannerTask(epic: Epic, o: {
  repo: string; base: string; sha: string; gate: string; sizeHint: string; autoSplit: boolean; protectedPaths: string[]; skills: Skill[]; lessons?: string; wiki?: string; round: number;
  notes: { round: number; notes: string }[]; review?: string; since: number;
}) {
  const parts = [
    [
      "# Environment",
      `- Repository: ${o.repo}; read_file and search see a read-only checkout of ${o.base} at ${o.sha.slice(0, 8)} (it includes the merged work of done children)`,
      `- Test gate for every child ticket: ${o.gate.trim() ? `\`${o.gate}\` must exit 0` : "no test command"}${o.protectedPaths.length ? `, and changes under ${o.protectedPaths.join(", ")} fail it` : ""}; a child's own test_command replaces the command`,
      `- Epic gate: ${o.gate.trim() ? `complete_epic first runs \`${o.gate}\` on ${o.base} as it is then, and is refused unless it exits 0` : "none (no test command)"}`,
      ...(o.sizeHint.trim() ? [`- Child size: the worker model reliably finishes tickets of this size: ${o.sizeHint.trim()}; make every child at most that size`] : []),
      `- Failed children: ${o.autoSplit && !epic.parent_id ? 'a child task that fails every attempt is split automatically (a "Split:" epic replaces it)' : "not split automatically (create smaller follow-up tickets)"}`,
      `- Round ${o.round} of at most ${MAX_ROUNDS}; child tickets: ${childrenOf(epic.id).length} of at most ${MAX_CHILDREN}; sub-epics: ${epic.parent_id ? "not allowed (this epic is a sub-epic)" : "allowed (their planners cannot create epics)"}`,
    ].join("\n"),
  ];
  if (o.skills.length) parts.push(skillsText(o.skills));
  if (o.lessons) parts.push(`# Lessons from earlier runs\n\n${o.lessons}`);
  if (o.wiki) parts.push(o.wiki);
  if (o.review) parts.push(`A reviewer sent the completed epic back: ${o.review}`);
  const header = trackerHeader(epic.id); // M11: priority, labels, project, due date
  parts.push(`# Epic\n\n# ${epic.title}${header ? `\n\n${header}` : ""}${epic.spec ? `\n\n${epic.spec}` : ""}`);
  if (o.notes.length) parts.push(`# Your notes from earlier rounds\n\n${o.notes.map((n) => `## Round ${n.round}\n${n.notes}`).join("\n\n")}`);
  parts.push(`# Children\n\n${childrenText(epic.id, o.since)}`);
  return parts.join("\n\n");
}

// --- tools ---

export type Outcome = { notes?: string; summary?: string };

const text = (input: Record<string, unknown>, key: string, max: number) => {
  const v = input[key];
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new AgentError("InvalidArguments", `"${key}" is required (a string of 1-${max} chars)`);
  return v.trim();
};

// read_file + search on the checkout, and the planner tools. finish_round/complete_epic fill `outcome`, which ends the run
// (runAgent's finished check). startChild: queues a new child; returns an error message if it could not be queued. gate: the epic
// gate (M9) complete_epic runs first; returns why it failed.
export function plannerTools(
  epic: Epic, outcome: Outcome, since: number, startChild: (ticketId: string) => Promise<string | undefined>, gate: () => Promise<string | undefined> = async () => undefined,
): Tool[] {
  const createTicket: Tool = {
    def: {
      name: "create_ticket",
      description: "Create a child ticket of this epic for one worker (kind epic: for a sub-planner). It is queued at once unless depends_on names tickets that are not done yet; then it is queued when the last of them is done.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short imperative title" },
          spec: { type: "string", description: "Self-contained task: goal, files/areas, conventions, acceptance criteria in terms of what the test gate checks" },
          depends_on: { type: "array", items: { type: "string" }, description: "Keys of tickets in this epic that must be merged first" },
          kind: { type: "string", enum: KINDS, description: "epic = a sub-planner owns this slice (default task)" },
          test_command: { type: "string", description: "This ticket's own test gate (an epic: its epic gate) instead of the test gate in the first message (the default), e.g. one test file, a --test-name-pattern, or `npx tsc --noEmit`, when the full suite can't pass until later tickets land" },
          labels: { type: "array", items: { type: "string" }, description: "Label names (unknown ones are created)" },
          priority: { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 none, 1 urgent, 2 high, 3 medium, 4 low (default: the epic's). Queued work starts by priority" },
          estimate: { type: "integer", enum: ESTIMATES, description: "Size in points" },
        },
        required: ["title", "spec"],
      },
    },
    async run(input) {
      // Calls after finish_round/complete_epic in the same turn still run: a child created then would be queued under a completed epic.
      if (outcome.notes !== undefined || outcome.summary !== undefined)
        throw new AgentError("InvalidArguments", "this round has ended (finish_round or complete_epic came earlier in this turn), so no ticket was created.");
      const title = text(input, "title", 200);
      const spec = text(input, "spec", 20_000);
      const kind = input.kind ?? "task";
      if (kind !== "task" && kind !== "epic") throw new AgentError("InvalidArguments", '"kind" must be "task" or "epic"');
      const test = input.test_command ?? null; // validated like the API's
      if (test !== null && (typeof test !== "string" || test.length > 2000)) throw new AgentError("InvalidArguments", '"test_command" must be a string of at most 2000 chars');
      if (kind === "epic" && epic.parent_id) throw new AgentError("InvalidArguments", "this epic is a sub-epic, and sub-epics cannot create epics (depth limit 2). Create tasks instead.");
      const kids = childrenOf(epic.id);
      if (kids.length >= MAX_CHILDREN) throw new AgentError("InvalidArguments", `this epic already has ${MAX_CHILDREN} child tickets, the limit. Work with those, or complete the epic.`);
      const deps = input.depends_on ?? [];
      if (!Array.isArray(deps) || !deps.every((d) => typeof d === "string")) throw new AgentError("InvalidArguments", '"depends_on" must be an array of ticket keys');
      const on = [...new Set(deps as string[])].map((key) => {
        const k = kids.find((x) => x.key === key);
        if (!k) throw new AgentError("InvalidArguments", `unknown dependency ${key}: depends_on must name tickets of this epic (${kids.map((x) => x.key).join(", ") || "none yet"})`);
        return k;
      });
      // M11: children inherit the epic's project, milestone, cycle and (unless given) priority.
      const priority = input.priority ?? (db.prepare("SELECT priority FROM tickets WHERE id = ?").get(epic.id) as { priority: number }).priority;
      if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 4) throw new AgentError("InvalidArguments", '"priority" must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)');
      const estimate = input.estimate ?? null;
      if (estimate !== null && !ESTIMATES.includes(estimate as number)) throw new AgentError("InvalidArguments", `"estimate" must be one of ${ESTIMATES.join(", ")}`);
      let labels: string[] = [];
      try {
        labels = input.labels === undefined ? [] : labelIds(epic.workspace_id, input.labels);
      } catch (e) {
        throw e instanceof Invalid ? new AgentError("InvalidArguments", e.message) : e;
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO tickets (id, workspace_id, parent_id, kind, title, spec, depends_on, provider_id, model, test_command, project_id, milestone_id, cycle_id, cycle_added_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, test_command), project_id, milestone_id, cycle_id, iif(cycle_id IS NULL, NULL, ?) FROM tickets WHERE id = ?`).run(
        id, epic.workspace_id, epic.id, kind, title, spec, JSON.stringify(on.map((k) => k.id)), epic.provider_id, epic.model, (test as string | null) || null, Date.now(), epic.id, // children inherit the epic's model choice and test command
      );
      applyTracker(id, { priority: priority as number, estimate: estimate as number | null, label_ids: labels });
      touch(epic.workspace_id, { type: "ticket", id });
      const { key } = db.prepare(`SELECT ${ticketKey()} AS key FROM tickets t JOIN organization o ON o.id = t.workspace_id WHERE t.id = ?`).get(id) as { key: string };
      const waiting = on.filter((k) => k.status !== "done").map((k) => k.key);
      if (waiting.length) return `Created ${key}. It is queued when ${waiting.join(" and ")} ${waiting.length > 1 ? "are" : "is"} done.`;
      const error = await startChild(id);
      return error ? `Created ${key}, but it could not be queued (it counts as failed): ${error}` : `Created ${key} (queued).`;
    },
  };
  const listChildren: Tool = {
    def: { name: "list_children", description: "Every child ticket of this epic: status, latest run, dependencies and handoff.", input_schema: { type: "object", properties: {} } },
    run: async () => childrenText(epic.id, since),
  };
  const finishRound: Tool = {
    def: {
      name: "finish_round",
      description: "End this round and wait for children to settle. The notes are all you will remember next round.",
      input_schema: { type: "object", properties: { notes: { type: "string", description: "Your plan, what you are waiting for, what to check next round" } }, required: ["notes"] },
    },
    async run(input) {
      const notes = text(input, "notes", 10_000);
      if (!openChildren(childrenOf(epic.id)).length) throw new AgentError("InvalidArguments", "no child ticket is open (children may have settled during this round), so nothing would start another round. Call list_children for their current state, then create tickets or call complete_epic.");
      outcome.notes = notes;
      return "Round finished. The next round starts when a child fails or no child is open any more.";
    },
  };
  const completeEpic: Tool = {
    def: {
      name: "complete_epic",
      description: "The epic's goal is met and no child is open. The epic gate runs first and must pass. The summary goes to the human reviewer.",
      input_schema: { type: "object", properties: { summary: { type: "string", description: "What was built by which tickets; anything left open or risky" } }, required: ["summary"] },
    },
    async run(input) {
      const summary = text(input, "summary", 10_000);
      const open = openChildren(childrenOf(epic.id));
      if (open.length) throw new AgentError("InvalidArguments", `children are still open: ${open.join(", ")}. Call finish_round to wait for them.`);
      const failed = await gate();
      if (failed) throw new AgentError("InvalidArguments", `${failed}\nThe epic is not complete: create child tickets that fix this, then call finish_round.`);
      outcome.summary = summary;
      return "Epic completed. It goes to human review with your summary.";
    },
  };
  return [...readOnlyTools, createTicket, listChildren, finishRound, completeEpic];
}
