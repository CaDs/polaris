import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import type { SQLInputValue } from "node:sqlite";
import { db } from "./db.ts";
import { touch } from "./agent/events.ts";
import { childrenOf, MAX_CHILDREN, openChildren } from "./planner.ts";
import { inspectRepo } from "./git.ts";
import { inspectProject } from "./inspect.ts";
import { IMAGE_REF, SANDBOX_IMAGE, SANDBOX_RESOURCES } from "./sandbox.ts";
import { wikiDir } from "./wiki.ts";

// Projects whose repository is the checkout this server runs from. A server started with --watch there restarts on every
// merge or edit in it, and a restart fails every running run (server/index.ts warns; README "Working on Polaris with Polaris").
export function ownCheckoutProjects(root = fileURLToPath(new URL("..", import.meta.url))) {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // a repository that is gone is not this checkout
    }
  };
  return (db.prepare("SELECT key, repo_path FROM projects").all() as { key: string; repo_path: string }[]).filter((p) => real(p.repo_path) === real(root));
}

// M11 tracker (see SPEC "Tracker (M11)"): labels, priority, assignee, estimate, due date, projects + milestones, cycles,
// filters + ranked search over tickets, saved views. Workspace-scoped like everything else: every id a body or a filter
// names is looked up in the caller's workspace. A project is one repository: its tickets (keyed KEY-12), cycles and wiki.

type Env = { Variables: { userId: string; workspaceId: string } };
export const trackerRoutes = new Hono<Env>();

const COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"];
const PRIORITIES = ["No priority", "Urgent", "High", "Medium", "Low"]; // Linear's numbering: 0 none, 1 urgent … 4 low
export const ESTIMATES = [1, 2, 3, 5, 8];
const SORTS = ["manual", "priority", "updated", "created", "due"];
export const STATUSES = ["todo", "running", "review", "done", "failed"]; // ticket status; runs.ts moveTicket has the transitions
export const KINDS = ["task", "epic"];
const PROTECTED_MODES = ["add_only", "read_only"];
const PROJECT_STATUSES = ["planned", "started", "paused", "completed", "canceled"];
// A project's ticket key prefix: 2-5 capitals or digits, a capital first.
const KEY = /^[A-Z][A-Z0-9]{1,4}$/;
// A project's repository settings when not given (a new project, PATCH with null). The DB columns repeat them.
export const PROJECT_DEFAULTS: Record<string, string> = { setup_command: "npm ci", test_command: "npm test", protected_paths: "tests/,evals/", protected_mode: "add_only", image: SANDBOX_IMAGE };
// The sandbox's size, a whole number in range (form posts send strings; empty or null = the default).
const PROJECT_RESOURCES: Record<string, [number, number, number, string]> = {
  sandbox_cpus: [1, 32, SANDBOX_RESOURCES.cpus, "Sandbox CPUs"],
  sandbox_memory_gb: [1, 64, SANDBOX_RESOURCES.memory_gb, "Sandbox memory (GB)"],
};
// Query params a filter (and a saved view) may hold. group only matters to the list layout.
const FILTER_KEYS = ["status", "label", "label_mode", "priority", "assignee", "project", "milestone", "cycle", "kind", "parent", "due_before", "due_after", "q", "group"];

// A bad request. Route handlers here throw it (app.ts onError → 400); app.ts gets {error} from the exported functions.
class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const orError = <T>(fn: () => T): T | { error: string } => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
};

// UTC: cycles and due dates are calendar days, the same for every viewer.
export const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(+d) && d.toISOString().startsWith(v); // 2026-02-30 parses as March 2
};
const date = (v: unknown, what: string) => (v === null || v === "" ? null : isDate(v) ? v : fail(`${what} must be a date (YYYY-MM-DD) or null`));
const text = (v: unknown, what: string, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : fail(`${what} is required (1-${max} chars)`));
const id = (v: unknown, what: string) => (typeof v === "string" ? v : fail(`${what} must be an id or null`));
async function body(c: Context<Env>) {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : fail("body must be a JSON object");
}

const isMember = (ws: string, userId: string) => !!db.prepare("SELECT 1 FROM member WHERE organizationId = ? AND userId = ?").get(ws, userId);
const owned = (table: "labels" | "projects" | "cycles", ws: string, v: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`).get(v, ws) as Record<string, any> | undefined;
const milestoneIn = (ws: string, v: string) =>
  db.prepare("SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ? AND p.workspace_id = ?").get(v, ws) as Record<string, any> | undefined;

// INSERT/UPDATE of the validated columns in v (keys are ours, never the client's).
const insert = (table: string, row: Record<string, SQLInputValue>) =>
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...Object.values(row));
const update = (table: string, rowId: string, v: Record<string, SQLInputValue>) =>
  Object.keys(v).length && db.prepare(`UPDATE ${table} SET ${Object.keys(v).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(v), rowId);

// --- ticket fields ---

// SQL for a ticket's key: its project's key + its number (POL-12).
export const ticketKey = (t = "t") => `(SELECT k.key FROM projects k WHERE k.id = ${t}.project_id) || '-' || ${t}.number`;

// The tracker's part of ticket JSON. hydrate parses these columns.
export const TRACKER_COLS = `
    (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name COLLATE NOCASE) FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.ticket_id = t.id) AS labels,
    (SELECT json_object('id', p.id, 'name', p.name, 'key', p.key) FROM projects p WHERE p.id = t.project_id) AS project,
    (SELECT json_object('id', m.id, 'name', m.name) FROM milestones m WHERE m.id = t.milestone_id) AS milestone,
    (SELECT json_object('id', y.id, 'number', y.number, 'name', y.name) FROM cycles y WHERE y.id = t.cycle_id) AS cycle,
    (SELECT json_object('id', u.id, 'name', u.name, 'email', u.email) FROM user u WHERE u.id = t.assignee_id) AS assignee`;
export function hydrate<T extends Record<string, any> | undefined>(t: T): T {
  if (t) for (const k of ["labels", "project", "milestone", "cycle", "assignee"]) (t as Record<string, any>)[k] = t[k] ? JSON.parse(t[k]) : k === "labels" ? [] : null;
  return t;
}

export type TrackerFields = {
  priority?: number; estimate?: number | null; due_date?: string | null; assignee_id?: string | null; project_id?: string | null; milestone_id?: string | null;
  cycle_id?: string | null; parent_id?: string | null; label_ids?: string[];
};
type Current = { id: string; kind: string; status: string; run_count: number; parent_id: string | null; project_id: string | null; milestone_id: string | null };

// Validated tracker fields of a ticket body (cur: the ticket being patched; kind: its kind, or the new ticket's). A new
// ticket names its project; it stays there (its branches live in that repo), and its cycle, milestone and epic are of it.
export const trackerFields = (ws: string, b: Record<string, any>, kind: string, cur?: Current) => orError(() => fields(ws, b, kind, cur));
function fields(ws: string, b: Record<string, any>, kind: string, cur?: Current) {
  const v: TrackerFields = {};
  if (b.priority !== undefined) v.priority = Number.isInteger(b.priority) && b.priority >= 0 && b.priority <= 4 ? b.priority : fail("priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)");
  if (b.estimate !== undefined) v.estimate = b.estimate === null || ESTIMATES.includes(b.estimate) ? b.estimate : fail(`estimate must be one of ${ESTIMATES.join(", ")} or null`);
  if (b.due_date !== undefined) v.due_date = date(b.due_date, "due_date");
  if (b.assignee_id !== undefined)
    v.assignee_id = b.assignee_id === null || isMember(ws, id(b.assignee_id, "assignee_id")) ? b.assignee_id : fail("assignee_id: not a member of this workspace");
  if (cur) {
    if (b.project_id !== undefined && b.project_id !== cur.project_id) fail("project_id: a ticket stays in the project it was created in");
  } else if (b.project_id === undefined || b.project_id === null) fail("project_id is required");
  else v.project_id = owned("projects", ws, id(b.project_id, "project_id")) ? b.project_id : fail("project_id: no such project in this workspace");
  const projectId = cur?.project_id ?? v.project_id!;
  if (b.cycle_id !== undefined && b.cycle_id !== null) {
    const y = owned("cycles", ws, id(b.cycle_id, "cycle_id")) ?? fail("cycle_id: no such cycle in this workspace");
    if (y.project_id !== projectId) fail("cycle_id: the cycle belongs to another project than the ticket's");
  }
  if (b.cycle_id !== undefined) v.cycle_id = b.cycle_id;
  if (b.milestone_id !== undefined) {
    if (b.milestone_id !== null) {
      const m = milestoneIn(ws, id(b.milestone_id, "milestone_id")) ?? fail("milestone_id: no such milestone in this workspace");
      if (m.project_id !== projectId) fail("milestone_id: the milestone belongs to another project than the ticket's");
    }
    v.milestone_id = b.milestone_id;
  }
  if (b.label_ids !== undefined) {
    if (!Array.isArray(b.label_ids) || b.label_ids.length > 20) fail("label_ids must be an array of at most 20 label ids");
    v.label_ids = [...new Set(b.label_ids.map((l: unknown) => (owned("labels", ws, id(l, "label_ids")) ? (l as string) : fail(`label_ids: no label ${l} in this workspace`))))] as string[];
  }
  if (b.parent_id !== undefined && b.parent_id !== (cur?.parent_id ?? null)) v.parent_id = parent(ws, b.parent_id, kind, projectId, cur);
  return v;
}

// Setting a parent epic by hand keeps planner semantics: only a todo task without runs moves (the planner owns the
// rest), into an open epic with room, and never out of an epic whose other children depend on it or are waiting on it.
function parent(ws: string, to: unknown, kind: string, projectId: string, cur?: Current) {
  if (kind !== "task" || (cur && (cur.status !== "todo" || cur.run_count))) fail("parent_id: only a todo task without runs can be attached to an epic or detached from one");
  if (cur?.parent_id) {
    const siblings = childrenOf(cur.parent_id);
    if (siblings.some((k) => (JSON.parse(k.depends_on) as string[]).includes(cur.id))) fail("parent_id: another child of its epic depends on this ticket");
    const epic = db.prepare("SELECT status FROM tickets WHERE id = ?").get(cur.parent_id) as { status: string };
    if (epic.status === "running" && !openChildren(siblings.filter((k) => k.id !== cur.id)).length)
      fail("parent_id: this is the last open child of a running epic, whose planner would then wait forever");
  }
  if (to === null) return null;
  const e = db.prepare("SELECT kind, status, hidden, project_id FROM tickets WHERE id = ? AND workspace_id = ?").get(id(to, "parent_id"), ws) as { kind: string; status: string; hidden: number; project_id: string } | undefined;
  if (!e || e.kind !== "epic" || e.hidden) fail("parent_id: no such epic in this workspace");
  if (e!.project_id !== projectId) fail("parent_id: the epic belongs to another project than the ticket's");
  if (e!.status !== "todo" && e!.status !== "running") fail("parent_id: the epic is not open (todo or running)");
  if (childrenOf(to as string).length >= MAX_CHILDREN) fail(`parent_id: the epic already has ${MAX_CHILDREN} child tickets`);
  return to as string;
}

export function applyTracker(ticketId: string, v: TrackerFields) {
  const { label_ids, ...cols } = v;
  const set: Record<string, SQLInputValue> = { ...cols };
  if (v.parent_id !== undefined) set.depends_on = "[]"; // dependencies are sibling ids: meaningless under another parent
  if (v.cycle_id !== undefined) {
    const prev = db.prepare("SELECT cycle_id FROM tickets WHERE id = ?").get(ticketId) as { cycle_id: string | null };
    if (prev.cycle_id !== v.cycle_id) set.cycle_added_at = v.cycle_id ? Date.now() : null;
  }
  if (label_ids) {
    db.prepare("DELETE FROM ticket_labels WHERE ticket_id = ?").run(ticketId);
    for (const l of label_ids) db.prepare("INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)").run(ticketId, l);
  }
  if (Object.keys(set).length || label_ids) update("tickets", ticketId, { ...set, updated_at: Date.now() });
}

// The ticket header line of a worker's or planner's first message: what the tracker knows that the agent should weigh (not
// the project: the repository it works in is the project).
export function trackerHeader(ticketId: string) {
  const r = db.prepare(`SELECT t.priority, t.due_date, m.name AS milestone,
      (SELECT group_concat(l.name, ', ') FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.ticket_id = t.id) AS labels
    FROM tickets t LEFT JOIN milestones m ON m.id = t.milestone_id WHERE t.id = ?`).get(ticketId) as
    | { priority: number; due_date: string | null; milestone: string | null; labels: string | null }
    | undefined;
  if (!r) return "";
  return [
    r.priority && `Priority: ${PRIORITIES[r.priority]}`, r.labels && `Labels: ${r.labels}`, r.milestone && `Milestone: ${r.milestone}`,
    r.due_date && `Due: ${r.due_date}`,
  ].filter(Boolean).join(" · ");
}

// Label ids for names (the planner's create_ticket): case-insensitive match, unknown names become new labels.
export function labelIds(ws: string, names: unknown) {
  if (!Array.isArray(names) || names.length > 10) throw new Invalid('"labels" must be an array of at most 10 label names');
  return [...new Set(names.map((n) => labelFor(ws, text(n, "a label name", 40))))];
}
function labelFor(ws: string, name: string) {
  const all = db.prepare("SELECT id, name FROM labels WHERE workspace_id = ?").all(ws) as { id: string; name: string }[];
  const found = all.find((l) => l.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (found) return found.id;
  const labelId = randomUUID();
  insert("labels", { id: labelId, workspace_id: ws, name, color: COLORS[all.length % COLORS.length] });
  return labelId;
}
export { Invalid };

// --- filters, search, sort (GET /api/tickets) ---

const values = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
const json = (a: unknown[]) => JSON.stringify(a);

// WHERE (AND across fields, OR within one) + ORDER BY for the board/list query. Unknown params are ignored (the UI keeps
// its layout in the same query string); unknown values of known params are a 400.
export const ticketQuery = (ws: string, userId: string, q: Record<string, string>) => orError(() => query(ws, userId, q));
function query(ws: string, userId: string, q: Record<string, string>) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const oneOf = (key: string, allowed: string[]) => values(q[key]).map((v) => (allowed.includes(v) ? v : fail(`${key} must be one or more of ${allowed.join(", ")}`)));
  const inList = (col: string, vals: SQLInputValue[]) => vals.length && (where.push(`${col} IN (SELECT value FROM json_each(?))`), params.push(json(vals as unknown[])));
  // "none" = unset; the rest are ids (an id of another workspace simply matches nothing).
  const nullable = (col: string, vals: string[]) => {
    if (!vals.length) return;
    const ids = vals.filter((v) => v !== "none");
    where.push(`(${[ids.length ? `${col} IN (SELECT value FROM json_each(?))` : "", vals.includes("none") ? `${col} IS NULL` : ""].filter(Boolean).join(" OR ")})`);
    if (ids.length) params.push(json(ids));
  };
  inList("t.status", oneOf("status", STATUSES));
  inList("t.kind", oneOf("kind", KINDS));
  inList("t.priority", oneOf("priority", ["0", "1", "2", "3", "4"]).map(Number));
  nullable("t.assignee_id", values(q.assignee).map((v) => (v === "me" ? userId : v)));
  nullable("t.project_id", values(q.project));
  nullable("t.milestone_id", values(q.milestone));
  nullable("t.cycle_id", values(q.cycle).flatMap((v) => (v === "current" ? currentCycles(ws).map((y) => y.id).concat("no current cycle") : [v])));
  nullable("t.parent_id", values(q.parent));
  const labels = values(q.label);
  const mode = q.label_mode ?? "any";
  if (mode !== "any" && mode !== "all") fail("label_mode must be any or all");
  const tagged = "SELECT tl.label_id FROM ticket_labels tl WHERE tl.ticket_id = t.id AND tl.label_id IN (SELECT value FROM json_each(?))";
  if (labels.length && mode === "any") where.push(`EXISTS (${tagged})`), params.push(json(labels));
  if (labels.length && mode === "all") where.push(`(SELECT COUNT(*) FROM (${tagged})) = ?`), params.push(json(labels), new Set(labels).size);
  for (const [key, op] of [["due_before", "<="], ["due_after", ">="]] as const)
    if (q[key]) where.push(`t.due_date ${op} ?`), params.push(isDate(q[key]) ? q[key] : fail(`${key} must be a date (YYYY-MM-DD)`));

  const sort = q.sort || "manual";
  if (!SORTS.includes(sort)) fail(`sort must be one of ${SORTS.join(", ")}`);
  const order = {
    manual: "t.number", priority: "t.priority = 0, t.priority, t.number", updated: "t.updated_at DESC, t.number DESC", created: "t.created_at DESC, t.number DESC",
    due: "t.due_date IS NULL, t.due_date, t.number",
  }[sort]!;
  const search = q.q?.trim();
  if (!search) return { where: where.map((w) => ` AND ${w}`).join(""), params, order, orderParams: [] as SQLInputValue[] };

  // Search: "ABC-12" (a project's key) or "12" (in any project) also matches that ticket and ranks it first; words are
  // prefix-matched over title + spec (FTS5, title weighted 10:1), quoted so no FTS syntax gets through.
  const key = /^([\p{L}\p{N}]+)-(\d+)$/u.exec(search);
  const keyed = key && (db.prepare("SELECT id FROM projects WHERE workspace_id = ? AND key = ?").get(ws, key[1].toUpperCase()) as { id: string } | undefined);
  const exact = keyed ? { sql: "(t.project_id = ? AND t.number = ?)", params: [keyed.id, Number(key![2])] } : /^\d+$/.test(search) ? { sql: "t.number = ?", params: [Number(search)] } : null;
  const match = (search.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => `"${w}"*`).join(" ");
  const either = [match ? "t.rowid IN (SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH ?)" : "", exact?.sql ?? ""].filter(Boolean);
  where.push(`(${either.join(" OR ") || "0"})`);
  params.push(...(match ? [match] : []), ...(exact?.params ?? []));
  const rank = match ? "(SELECT bm25(tickets_fts, 10.0, 1.0) FROM tickets_fts WHERE tickets_fts MATCH ? AND rowid = t.rowid), " : "";
  return {
    where: where.map((w) => ` AND ${w}`).join(""), params,
    order: `${exact ? `${exact.sql} DESC, ` : ""}${q.sort ? order : `${rank}t.number`}`, orderParams: [...(exact?.params ?? []), ...(match && !q.sort ? [match] : [])] as SQLInputValue[],
  };
}

// --- members, labels ---

const members = (ws: string) =>
  db.prepare("SELECT u.id, u.name, u.email FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY u.name COLLATE NOCASE").all(ws);

// Everything the pickers need, in one request.
trackerRoutes.get("/tracker", (c) => {
  const ws = c.get("workspaceId");
  const milestones = db.prepare("SELECT m.id, m.name, m.project_id, m.target_date FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.workspace_id = ? ORDER BY m.position").all(ws) as Record<string, any>[];
  return c.json({
    me: c.get("userId"),
    current: (db.prepare("SELECT project_id FROM current_projects WHERE user_id = ? AND workspace_id = ?").get(c.get("userId"), ws) as { project_id: string } | undefined)?.project_id ?? null,
    members: members(ws),
    labels: db.prepare("SELECT id, name, color FROM labels WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(ws),
    projects: (db.prepare("SELECT id, key, name, status FROM projects WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(ws) as Record<string, any>[]).map((p) => ({
      ...p, milestones: milestones.filter((m) => m.project_id === p.id),
    })),
    cycles: cycles(ws).map(({ id, project_id, number, name, starts_at, ends_at, state }) => ({ id, project_id, number, name, starts_at, ends_at, state })),
  });
});

trackerRoutes.get("/members", (c) => c.json(members(c.get("workspaceId"))));

// The member's current project in this workspace (see migration 005).
const setCurrent = (userId: string, ws: string, projectId: string) =>
  db.prepare("INSERT INTO current_projects (user_id, workspace_id, project_id) VALUES (?, ?, ?) ON CONFLICT (user_id, workspace_id) DO UPDATE SET project_id = excluded.project_id").run(userId, ws, projectId);
trackerRoutes.put("/me/project", async (c) => {
  const b = await c.req.json().catch(() => null);
  if (typeof b?.project_id !== "string" || !db.prepare("SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?").get(b.project_id, c.get("workspaceId")))
    return c.json({ error: "project_id: no such project in this workspace" }, 400);
  setCurrent(c.get("userId"), c.get("workspaceId"), b.project_id);
  return c.json({ project_id: b.project_id });
});

function labelBody(ws: string, b: Record<string, any>, cur?: Record<string, any>) {
  const v: Record<string, string> = {};
  if (b.name !== undefined || !cur) {
    v.name = text(b.name, "name", 40);
    const taken = (db.prepare("SELECT id, name FROM labels WHERE workspace_id = ?").all(ws) as { id: string; name: string }[]).find(
      (l) => l.id !== cur?.id && l.name.toLocaleLowerCase() === v.name.toLocaleLowerCase(),
    );
    if (taken) fail(`a label named "${taken.name}" already exists`);
  }
  if (b.color !== undefined || !cur) v.color = COLORS.includes(b.color) ? b.color : fail(`color must be one of ${COLORS.join(", ")}`);
  return v;
}

trackerRoutes.get("/labels", (c) =>
  c.json(db.prepare("SELECT l.*, (SELECT COUNT(*) FROM ticket_labels WHERE label_id = l.id) AS ticket_count FROM labels l WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(c.get("workspaceId"))),
);
trackerRoutes.post("/labels", async (c) => {
  const v = labelBody(c.get("workspaceId"), await body(c));
  const labelId = randomUUID();
  insert("labels", { id: labelId, workspace_id: c.get("workspaceId"), ...v });
  return c.json(owned("labels", c.get("workspaceId"), labelId), 201);
});
trackerRoutes.patch("/labels/:id", async (c) => {
  const cur = owned("labels", c.get("workspaceId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  update("labels", cur.id, labelBody(c.get("workspaceId"), await body(c), cur));
  return c.json(owned("labels", c.get("workspaceId"), cur.id));
});

// Deleting a label, milestone or cycle unsets it on its tickets (FK cascade / SET NULL). Projects: below.
for (const table of ["labels", "cycles"] as const)
  trackerRoutes.delete(`/${table}/:id`, (c) => {
    const r = db.prepare(`DELETE FROM ${table} WHERE id = ? AND workspace_id = ?`).run(c.req.param("id"), c.get("workspaceId"));
    return r.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

// --- projects and milestones ---

type Progress = { total: number; done: number; points: number; points_done: number; by_status: Record<string, number> };
function progress(where: string, ...params: SQLInputValue[]): Progress {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(estimate), 0) AS pts FROM tickets t WHERE t.hidden = 0 AND ${where} GROUP BY status`).all(...params) as {
    status: string; n: number; pts: number;
  }[];
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
  const sum = (k: "n" | "pts", only?: string) => rows.filter((r) => !only || r.status === only).reduce((a, r) => a + r[k], 0);
  return { total: sum("n"), done: sum("n", "done"), points: sum("pts"), points_done: sum("pts", "done"), by_status };
}

function project(ws: string, projectId: string) {
  const p = db.prepare(`SELECT p.*, (SELECT json_object('id', u.id, 'name', u.name, 'email', u.email) FROM user u WHERE u.id = p.lead_id) AS lead
    FROM projects p WHERE p.id = ? AND p.workspace_id = ?`).get(projectId, ws) as Record<string, any> | undefined;
  if (!p) return undefined;
  const milestones = (db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY position").all(p.id) as Record<string, any>[]).map((m) => ({
    ...m, progress: progress("t.milestone_id = ?", m.id),
  }));
  return { ...p, lead: p.lead ? JSON.parse(p.lead) : null, progress: progress("t.project_id = ?", p.id), milestones };
}

// cur: the project being patched. The repository is checked (root of a repo with commits, the base branch exists; an empty
// base branch = the repo's current branch) whenever it is given, and always for a new project.
async function projectBody(ws: string, b: Record<string, any>, cur?: Record<string, any>) {
  const v: Record<string, SQLInputValue> = {};
  if (b.name !== undefined || !cur) v.name = text(b.name, "name", 100);
  if (b.key !== undefined || !cur) {
    const key = typeof b.key === "string" ? b.key.trim().toUpperCase() : "";
    if (!KEY.test(key)) fail("key must be 2-5 letters or digits, starting with a letter (it prefixes ticket keys, as in KEY-12)");
    if (db.prepare("SELECT 1 FROM projects WHERE workspace_id = ? AND key = ? AND id <> ?").get(ws, key, cur?.id ?? "")) fail(`another project already has the key ${key}`);
    v.key = key;
  }
  if (b.description !== undefined) v.description = typeof b.description === "string" && b.description.length <= 10_000 ? b.description : fail("description must be a string of at most 10000 chars");
  if (b.status !== undefined) v.status = PROJECT_STATUSES.includes(b.status) ? b.status : fail(`status must be one of ${PROJECT_STATUSES.join(", ")}`);
  if (b.lead_id !== undefined) v.lead_id = b.lead_id === null || isMember(ws, id(b.lead_id, "lead_id")) ? b.lead_id : fail("lead_id: not a member of this workspace");
  if (b.target_date !== undefined) v.target_date = date(b.target_date, "target_date");
  for (const k of Object.keys(PROJECT_DEFAULTS))
    if (b[k] !== undefined) v[k] = b[k] === null ? PROJECT_DEFAULTS[k] : typeof b[k] === "string" && b[k].length <= 2000 ? b[k].trim() : fail(`${k} must be a string of at most 2000 chars`);
  if (v.protected_mode !== undefined && !PROTECTED_MODES.includes(v.protected_mode as string)) fail(`protected_mode must be one of ${PROTECTED_MODES.join(", ")}`);
  if (v.image === "") v.image = PROJECT_DEFAULTS.image;
  for (const [k, [lo, hi, def, label]] of Object.entries(PROJECT_RESOURCES)) {
    if (b[k] === undefined) continue;
    const n = b[k] === null || b[k] === "" ? def : typeof b[k] === "number" || typeof b[k] === "string" ? Number(b[k]) : NaN;
    v[k] = Number.isInteger(n) && n >= lo && n <= hi ? n : fail(`${label} must be a whole number from ${lo} to ${hi}`);
  }
  if (v.image !== undefined && !IMAGE_REF.test(v.image as string)) fail("Sandbox image must be a docker image reference such as node:22 or ghcr.io/org/image:tag");
  if (typeof v.protected_paths === "string" && v.protected_paths.split(",").some((p) => p.trim().startsWith("/") || p.split("/").includes("..")))
    fail("Protected paths must be relative to the repository root, without ..");
  if (b.repo_path !== undefined || b.base_branch !== undefined || !cur) {
    const str = (k: string) => (typeof b[k] === "string" ? b[k].trim() : b[k] === undefined ? (cur?.[k] ?? "") : fail(`${k} must be a string`));
    const repo = await inspectRepo(str("repo_path"), str("base_branch"));
    if ("error" in repo) fail(repo.error);
    Object.assign(v, repo);
  }
  return v;
}

trackerRoutes.get("/projects", (c) => {
  const ws = c.get("workspaceId");
  const ids = db.prepare("SELECT id FROM projects WHERE workspace_id = ? ORDER BY created_at, rowid").all(ws) as { id: string }[];
  return c.json(ids.map((p) => project(ws, p.id)));
});
// The repository form's detection and suggestions (POL-29). A folder that is not a usable repository gets project create's 400,
// with its `state` (and `root` for inside_repo) so the form can offer the fix.
trackerRoutes.post("/projects/inspect", async (c) => {
  const b = await body(c);
  const r = await inspectProject(typeof b.repo_path === "string" ? b.repo_path.trim() : "", typeof b.base_branch === "string" ? b.base_branch.trim() : "");
  return c.json(r, r.state === "ok" ? 200 : 400);
});
trackerRoutes.post("/projects", async (c) => {
  const v = await projectBody(c.get("workspaceId"), await body(c));
  const projectId = randomUUID();
  insert("projects", { id: projectId, workspace_id: c.get("workspaceId"), protected_mode: PROJECT_DEFAULTS.protected_mode, ...v });
  setCurrent(c.get("userId"), c.get("workspaceId"), projectId); // a new project is where its maker works next
  return c.json(project(c.get("workspaceId"), projectId), 201);
});
trackerRoutes.get("/projects/:id", (c) => {
  const p = project(c.get("workspaceId"), c.req.param("id"));
  return p ? c.json(p) : c.json({ error: "not_found" }, 404);
});
trackerRoutes.patch("/projects/:id", async (c) => {
  const cur = owned("projects", c.get("workspaceId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  update("projects", cur.id, { ...(await projectBody(c.get("workspaceId"), await body(c), cur)), updated_at: Date.now() });
  return c.json(project(c.get("workspaceId"), cur.id));
});
// Only an empty project goes (its tickets' branches and runs would go with it): move on by deleting its tickets first.
trackerRoutes.delete("/projects/:id", (c) => {
  const cur = owned("projects", c.get("workspaceId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (db.prepare("SELECT 1 FROM tickets WHERE project_id = ? AND hidden = 0").get(cur.id)) fail("delete the project's tickets first");
  if (db.prepare("SELECT 1 FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.project_id = ? AND r.status IN ('queued', 'running')").get(cur.id)) fail("a wiki run of this project is in flight: wait for it or cancel it");
  db.prepare("DELETE FROM projects WHERE id = ?").run(cur.id);
  rmSync(wikiDir(cur.id), { recursive: true, force: true });
  return c.body(null, 204);
});

trackerRoutes.post("/projects/:id/milestones", async (c) => {
  const p = owned("projects", c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const b = await body(c);
  const position = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM milestones WHERE project_id = ?").get(p.id) as { n: number }).n;
  insert("milestones", { id: randomUUID(), project_id: p.id, name: text(b.name, "name", 100), target_date: b.target_date === undefined ? null : date(b.target_date, "target_date"), position });
  return c.json(project(c.get("workspaceId"), p.id), 201);
});
// The full new order of the project's milestones.
trackerRoutes.put("/projects/:id/milestones/order", async (c) => {
  const p = owned("projects", c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const ids = (await body(c)).ids;
  const have = (db.prepare("SELECT id FROM milestones WHERE project_id = ?").all(p.id) as { id: string }[]).map((m) => m.id);
  if (!Array.isArray(ids) || ids.length !== have.length || !have.every((m) => ids.includes(m))) fail("ids must list every milestone of the project once");
  ids.forEach((m: string, i: number) => update("milestones", m, { position: i + 1 }));
  return c.json(project(c.get("workspaceId"), p.id));
});
trackerRoutes.patch("/milestones/:id", async (c) => {
  const m = milestoneIn(c.get("workspaceId"), c.req.param("id"));
  if (!m) return c.json({ error: "not_found" }, 404);
  const b = await body(c);
  update("milestones", m.id, {
    ...(b.name !== undefined && { name: text(b.name, "name", 100) }), ...(b.target_date !== undefined && { target_date: date(b.target_date, "target_date") }),
  });
  return c.json(project(c.get("workspaceId"), m.project_id));
});
trackerRoutes.delete("/milestones/:id", (c) => {
  const m = milestoneIn(c.get("workspaceId"), c.req.param("id"));
  if (!m) return c.json({ error: "not_found" }, 404);
  db.prepare("DELETE FROM milestones WHERE id = ?").run(m.id);
  return c.body(null, 204);
});

// --- cycles ---

type Cycle = { id: string; workspace_id: string; project_id: string; number: number; name: string; starts_at: string; ends_at: string };
const stateOf = (y: Cycle, now = today()) => (y.starts_at > now ? "upcoming" : y.ends_at < now ? "past" : "current");
// The current cycle of each project (at most one: a project's cycles never overlap).
const currentCycles = (ws: string, projectId?: string) =>
  db.prepare("SELECT * FROM cycles WHERE workspace_id = ? AND (? IS NULL OR project_id = ?) AND starts_at <= ? AND ends_at >= ?").all(ws, projectId ?? null, projectId ?? null, today(), today()) as Cycle[];

// A cycle with its state, progress, and scope change: tickets that entered it after it started.
function withProgress(y: Cycle) {
  const start = Date.parse(`${y.starts_at}T00:00:00Z`);
  const added = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE cycle_id = ? AND hidden = 0 AND cycle_added_at > ?").get(y.id, start) as { n: number }).n;
  return { ...y, state: stateOf(y), progress: progress("t.cycle_id = ?", y.id), added_after_start: added };
}
const cycles = (ws: string, projectId?: string) =>
  (db.prepare("SELECT * FROM cycles WHERE workspace_id = ? AND (? IS NULL OR project_id = ?) ORDER BY starts_at").all(ws, projectId ?? null, projectId ?? null) as Cycle[]).map(withProgress);

function cycleBody(projectId: string, b: Record<string, any>, cur?: Cycle) {
  const v: Record<string, SQLInputValue> = {};
  if (b.name !== undefined) v.name = b.name === null || b.name === "" ? "" : text(b.name, "name", 100);
  const starts = b.starts_at !== undefined || !cur ? (isDate(b.starts_at) ? b.starts_at : fail("starts_at must be a date (YYYY-MM-DD)")) : cur.starts_at;
  const ends = b.ends_at !== undefined || !cur ? (isDate(b.ends_at) ? b.ends_at : fail("ends_at must be a date (YYYY-MM-DD)")) : cur.ends_at;
  if (ends < starts) fail("ends_at must not be before starts_at");
  const clash = db.prepare("SELECT number FROM cycles WHERE project_id = ? AND id <> ? AND starts_at <= ? AND ends_at >= ?").get(projectId, cur?.id ?? "", ends, starts) as { number: number } | undefined;
  if (clash) fail(`the dates overlap cycle ${clash.number}`);
  return { ...v, starts_at: starts, ends_at: ends };
}

// ?project=<id>: only that project's cycles.
trackerRoutes.get("/cycles", (c) => c.json(cycles(c.get("workspaceId"), c.req.query("project"))));
trackerRoutes.post("/cycles", async (c) => {
  const ws = c.get("workspaceId");
  const b = await body(c);
  const p = owned("projects", ws, id(b.project_id, "project_id")) ?? fail("project_id: no such project in this workspace");
  const v = cycleBody(p.id, b);
  const cycleId = randomUUID();
  const number = (db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM cycles WHERE project_id = ?").get(p.id) as { n: number }).n;
  insert("cycles", { id: cycleId, workspace_id: ws, project_id: p.id, number, ...v });
  return c.json(withProgress(owned("cycles", ws, cycleId) as Cycle), 201);
});
// "current" needs ?project=<id>.
trackerRoutes.get("/cycles/:id", (c) => {
  const y = c.req.param("id") === "current" ? currentCycles(c.get("workspaceId"), c.req.query("project") ?? "none")[0] : (owned("cycles", c.get("workspaceId"), c.req.param("id")) as Cycle | undefined);
  return y ? c.json(withProgress(y)) : c.json({ error: "not_found" }, 404);
});
trackerRoutes.patch("/cycles/:id", async (c) => {
  const cur = owned("cycles", c.get("workspaceId"), c.req.param("id")) as Cycle | undefined;
  if (!cur) return c.json({ error: "not_found" }, 404);
  update("cycles", cur.id, cycleBody(cur.project_id, await body(c), cur));
  return c.json(withProgress(owned("cycles", c.get("workspaceId"), cur.id) as Cycle));
});
// Everything not done moves to the project's next cycle (the first one starting after this one ends).
trackerRoutes.post("/cycles/:id/move-unfinished", (c) => {
  const ws = c.get("workspaceId");
  const cur = owned("cycles", ws, c.req.param("id")) as Cycle | undefined;
  if (!cur) return c.json({ error: "not_found" }, 404);
  const next = db.prepare("SELECT * FROM cycles WHERE project_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 1").get(cur.project_id, cur.ends_at) as Cycle | undefined;
  if (!next) fail(`there is no cycle after cycle ${cur.number}: create the next cycle first`);
  const now = Date.now();
  const r = db.prepare("UPDATE tickets SET cycle_id = ?, cycle_added_at = ?, updated_at = ? WHERE cycle_id = ? AND status <> 'done'").run(next!.id, now, now, cur.id);
  return c.json({ moved: Number(r.changes), to: withProgress(next!) });
});

// --- saved views ---

function viewBody(ws: string, userId: string, b: Record<string, any>, partial: boolean) {
  const v: Record<string, SQLInputValue> = {};
  if (b.name !== undefined || !partial) v.name = text(b.name, "name", 100);
  if (b.filters !== undefined) {
    const f = b.filters;
    if (!f || typeof f !== "object" || Array.isArray(f)) fail("filters must be an object of query params");
    for (const [k, x] of Object.entries(f)) if (!FILTER_KEYS.includes(k) || typeof x !== "string" || x.length > 1000) fail(`filters: unknown filter ${k}, or not a string`);
    if (f.group !== undefined && !["status", "priority", "project", "assignee", "cycle", "label"].includes(f.group)) fail("filters: group must be status, priority, project, assignee, cycle or label");
    query(ws, userId, f); // the same validation as GET /api/tickets
    v.filters = JSON.stringify(f);
  }
  if (b.sort !== undefined) v.sort = SORTS.includes(b.sort) ? b.sort : fail(`sort must be one of ${SORTS.join(", ")}`);
  if (b.layout !== undefined) v.layout = b.layout === "board" || b.layout === "list" ? b.layout : fail("layout must be board or list");
  if (b.shared !== undefined) v.shared = typeof b.shared === "boolean" ? Number(b.shared) : fail("shared must be true or false");
  return v;
}
const viewOut = (v: Record<string, any>, userId: string) => ({ ...v, filters: JSON.parse(v.filters), shared: !!v.shared, mine: v.user_id === userId });
// Shared views are visible to the workspace; only the owner changes or deletes a view.
const viewIn = (c: Context<Env>, viewId = c.req.param("id") as string) =>
  db.prepare("SELECT v.*, u.name AS owner FROM views v JOIN user u ON u.id = v.user_id WHERE v.id = ? AND v.workspace_id = ? AND (v.shared = 1 OR v.user_id = ?)").get(
    viewId, c.get("workspaceId"), c.get("userId"),
  ) as Record<string, any> | undefined;

trackerRoutes.get("/views", (c) =>
  c.json(
    (db.prepare("SELECT v.*, u.name AS owner FROM views v JOIN user u ON u.id = v.user_id WHERE v.workspace_id = ? AND (v.shared = 1 OR v.user_id = ?) ORDER BY v.name COLLATE NOCASE").all(
      c.get("workspaceId"), c.get("userId"),
    ) as Record<string, any>[]).map((v) => viewOut(v, c.get("userId"))),
  ),
);
trackerRoutes.post("/views", async (c) => {
  const v = viewBody(c.get("workspaceId"), c.get("userId"), await body(c), false);
  const viewId = randomUUID();
  insert("views", { id: viewId, workspace_id: c.get("workspaceId"), user_id: c.get("userId"), ...v });
  return c.json(viewOut(viewIn(c, viewId)!, c.get("userId")), 201);
});
trackerRoutes.get("/views/:id", (c) => {
  const v = viewIn(c);
  return v ? c.json(viewOut(v, c.get("userId"))) : c.json({ error: "not_found" }, 404);
});
trackerRoutes.patch("/views/:id", async (c) => {
  const cur = viewIn(c);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.user_id !== c.get("userId")) return c.json({ error: "only the owner can change this view" }, 403);
  update("views", cur.id, viewBody(c.get("workspaceId"), c.get("userId"), await body(c), true));
  return c.json(viewOut(viewIn(c)!, c.get("userId")));
});
trackerRoutes.delete("/views/:id", (c) => {
  const cur = viewIn(c);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.user_id !== c.get("userId")) return c.json({ error: "only the owner can delete this view" }, 403);
  db.prepare("DELETE FROM views WHERE id = ?").run(cur.id);
  return c.body(null, 204);
});

// --- Comments and notifications (M12) ---

// A workspace-wide notification about a ticket: a run that needs review or failed, a comment. actor_id: the member who
// caused it (their own bell skips it). Wakes the live board/bell stream.
export function notify(ws: string, ticketId: string, kind: "review" | "failed" | "comment", text: string, actorId: string | null = null) {
  const id = randomUUID();
  db.prepare("INSERT INTO notifications (id, workspace_id, ticket_id, kind, text, actor_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, ws, ticketId, kind, text.slice(0, 300), actorId);
  touch(ws, { type: "notification", id });
  if (kind !== "comment") slack(ticketId, text);
}

// POLARIS_SLACK_WEBHOOK (a Slack incoming webhook): runs to review and failures, with a link to the ticket. Comments
// stay in the bell; a delivery failure is logged, never thrown.
// ponytail: one webhook per server, a workspace setting when more than one workspace needs its own channel.
function slack(ticketId: string, text: string) {
  const hook = process.env.POLARIS_SLACK_WEBHOOK;
  if (!hook) return;
  const { key } = db.prepare(`SELECT ${ticketKey()} AS key FROM tickets t WHERE t.id = ?`).get(ticketId) as { key: string };
  const url = `${process.env.WEB_ORIGIN ?? "http://localhost:5173"}/t/${key}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `<${url}|${esc(text.slice(0, 300))}>` }) })
    .then((r) => r.ok || console.error(`slack webhook: HTTP ${r.status}`))
    .catch((e) => console.error(`slack webhook: ${e.message}`));
}

const ticketOf = (c: Context<Env>) =>
  db.prepare(`SELECT t.id, ${ticketKey()} AS key FROM tickets t WHERE t.id = ? AND t.workspace_id = ?`).get(c.req.param("id") as string, c.get("workspaceId")) as { id: string; key: string } | undefined;

const COMMENTS = "SELECT c.id, c.body, c.created_at, c.author_id, u.email AS author FROM comments c JOIN user u ON u.id = c.author_id";
trackerRoutes.get("/tickets/:id/comments", (c) => {
  const t = ticketOf(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json(db.prepare(`${COMMENTS} WHERE c.ticket_id = ? ORDER BY c.created_at`).all(t.id));
});

trackerRoutes.post("/tickets/:id/comments", async (c) => {
  const t = ticketOf(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const body = text(b?.body, "body", 5000);
  const id = randomUUID();
  db.prepare("INSERT INTO comments (id, ticket_id, author_id, body) VALUES (?, ?, ?, ?)").run(id, t.id, c.get("userId"), body);
  const author = (db.prepare("SELECT email FROM user WHERE id = ?").get(c.get("userId")) as { email: string }).email;
  notify(c.get("workspaceId"), t.id, "comment", `${author} on ${t.key}: ${body.split("\n")[0]}`, c.get("userId"));
  touch(c.get("workspaceId"), { type: "ticket", id: t.id });
  return c.json(db.prepare(`${COMMENTS} WHERE c.id = ?`).get(id), 201);
});

// The caller's unread notifications, newest first (their own actions excluded), with the ticket's key and number to open it.
trackerRoutes.get("/notifications", (c) =>
  c.json(db.prepare(`SELECT n.id, n.kind, n.text, n.created_at, n.ticket_id, t.number, ${ticketKey()} AS key FROM notifications n JOIN tickets t ON t.id = n.ticket_id
    WHERE n.workspace_id = ? AND n.read_at IS NULL AND (n.actor_id IS NULL OR n.actor_id <> ?) ORDER BY n.created_at DESC LIMIT 50`).all(c.get("workspaceId"), c.get("userId"))));

// Marks every unread notification read (ids: only those).
trackerRoutes.post("/notifications/read", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(b?.ids) ? b.ids.filter((x: unknown) => typeof x === "string") : null;
  if (ids) db.prepare("UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))").run(Date.now(), c.get("workspaceId"), JSON.stringify(ids));
  else db.prepare("UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL").run(Date.now(), c.get("workspaceId"));
  touch(c.get("workspaceId"), { type: "notification", id: "read" });
  return c.json({ ok: true });
});
