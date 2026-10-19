import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { auth } from "./auth.ts";
import { db, migrate } from "./db.ts";
import { subscribe, subscribeWorkspace, touch, type Change, type StoredEvent } from "./agent/events.ts";
import { git, inspectRepo, MergeError, scratchPathspec } from "./git.ts";
import { providerRoutes } from "./providers.ts";
import { failures, mine } from "./failures.ts";
import { activePrompt, addPrompt, caseSet, currentLessons, LESSONS_MAX, promote, promotion, PROMPT_MAX, promptIn, propose, saveLessons, validateCase, type Prompt } from "./improve.ts";
import { approve, cancelRun, cleanupTicket, enqueueRun, enqueueWiki, metaProvider, moveTicket, monthSpend, reject, reviewRun, SETTINGS_DEFAULTS, settingsFor, startEval, startReady, treeSpend, wake, type Choice } from "./runs.ts";
import { OWN_RUNS, TREE, withStates } from "./planner.ts";
import { IMAGE_REF } from "./sandbox.ts";
import { editPage, headOf, history, readPage, wikiDiff, wikiView } from "./wiki.ts";
import { applyTracker, hydrate, Invalid, KINDS, STATUSES, ticketKey, ticketQuery, TRACKER_COLS, trackerFields, trackerRoutes, type TrackerFields } from "./tracker.ts";
import { AgentError } from "./agent/types.ts";

migrate();

type Env = { Variables: { userId: string; workspaceId: string } };

export const app = new Hono<Env>();

// Every error a route throws is {error} JSON: a bad request (tracker Invalid, a wiki AgentError: bad path, unknown page)
// is 400, a refused merge 409; anything else is a bug, logged, and 500 with a generic message.
app.onError((e, c) => {
  if (e instanceof Invalid || e instanceof AgentError) return c.json({ error: e.message }, 400);
  if (e instanceof MergeError) return c.json({ error: e.message }, 409);
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  console.error(e);
  return c.json({ error: "internal error" }, 500);
});

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// CSRF: cookie-authenticated mutations must come from a trusted origin (BETTER_AUTH_URL, WEB_ORIGIN) or this host.
// No Origin and no Sec-Fetch-Site means a non-browser client (curl, CLI): allowed only without a cookie.
app.use("/api/*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  const ok = origin
    ? (await auth.$context).isTrustedOrigin(origin) || URL.parse(origin)?.host === c.req.header("host")
    : site ? site === "same-origin" : !c.req.header("cookie");
  return ok ? next() : c.json({ error: "forbidden_origin" }, 403);
});

// Every other API route requires a session and an active workspace the user still belongs to.
app.use("/api/*", async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!s) return c.json({ error: "unauthorized" }, 401);
  const ws = s.session.activeOrganizationId;
  const member = ws && db.prepare("SELECT 1 FROM member WHERE userId = ? AND organizationId = ?").get(s.user.id, ws);
  if (!member) return c.json({ error: "no_workspace" }, 409);
  c.set("userId", s.user.id);
  c.set("workspaceId", ws);
  await next();
});

app.route("/api/providers", providerRoutes);
app.route("/api", trackerRoutes); // M11: labels, projects, milestones, cycles, views, members

// Ticket + Linear-style key (first 3 letters of the workspace slug + number) + summary of its runs.
// Eval case runs (M6) belong to their case's ticket but are not part of it: left out here and in the ticket's run list.
const OWN = `ticket_id = t.id AND ${OWN_RUNS}`; // wiki runs (M10) are listed in the ticket but never change its state or totals
const TICKETS = `
  SELECT t.*, ${ticketKey()} AS key,
    (SELECT status FROM runs WHERE ${OWN} ORDER BY rowid DESC LIMIT 1) AS run_status,
    (SELECT model FROM runs WHERE ${OWN} ORDER BY rowid DESC LIMIT 1) AS run_model,
    (SELECT p.auth_type FROM runs r JOIN providers p ON p.id = r.provider_id WHERE r.${OWN} ORDER BY r.rowid DESC LIMIT 1) AS run_auth,
    (SELECT COUNT(*) FROM runs WHERE ${OWN}) AS run_count,
    (SELECT COALESCE(SUM(tokens_in), 0) FROM runs WHERE ${OWN}) AS tokens_in,
    (SELECT COALESCE(SUM(tokens_out), 0) FROM runs WHERE ${OWN}) AS tokens_out,
    (SELECT COALESCE(SUM(tokens_cached), 0) FROM runs WHERE ${OWN}) AS tokens_cached,
    (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE ${OWN}) AS cost_usd,
    (SELECT id FROM eval_cases WHERE ticket_id = t.id) AS eval_case_id,
    (SELECT ${ticketKey("p")} FROM tickets p WHERE p.id = t.parent_id) AS parent_key,
    (SELECT ${ticketKey("e")} FROM tickets e WHERE e.id = t.escalated_to) AS escalated_key,
    (SELECT ${ticketKey("s")} FROM tickets s WHERE s.escalated_to = t.id) AS split_from_key,
    (SELECT COUNT(*) FROM tickets c WHERE c.parent_id = t.id) AS child_count,
    (SELECT COUNT(*) FROM tickets c WHERE c.parent_id = t.id AND c.status = 'done') AS child_done,${TRACKER_COLS}
  FROM tickets t JOIN organization o ON o.id = t.workspace_id`;

const ticketIn = (c: Context<Env>, id = c.req.param("id") as string) =>
  hydrate(db.prepare(`${TICKETS} WHERE t.workspace_id = ? AND t.id = ?`).get(c.get("workspaceId"), id) as Record<string, any> | undefined);

// The run r's latest run_metrics payload (M12), null before it finished.
const METRICS = "SELECT payload FROM events WHERE run_id = r.id AND seq = (SELECT MAX(seq) FROM events WHERE run_id = r.id AND type = 'run_metrics')";

// Runs are only reachable through a ticket in the caller's workspace.
const runIn = (c: Context<Env>) =>
  db.prepare("SELECT r.* FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ? AND t.workspace_id = ?").get(c.req.param("id") as string, c.get("workspaceId")) as
    | Record<string, any>
    | undefined;

// A provider_id/model choice: both optional, null = unset. Providers must belong to the caller's workspace.
function pick(c: Context<Env>, b: Record<string, any>): { error: string } | { v: Choice } {
  const v: Choice = {};
  if (b.provider_id !== undefined) {
    if (b.provider_id !== null && (typeof b.provider_id !== "string" || !db.prepare("SELECT 1 FROM providers WHERE id = ? AND workspace_id = ?").get(b.provider_id, c.get("workspaceId"))))
      return { error: "provider not found" };
    v.provider_id = b.provider_id;
  }
  if (b.model !== undefined) {
    if (b.model !== null && (typeof b.model !== "string" || b.model.length > 200)) return { error: "model must be a string of at most 200 chars" };
    v.model = b.model || null;
  }
  return { v };
}

// Validated fields of a JSON body, or an error message.
// cur: the ticket being patched (its tracker fields are validated against it).
type Fields = {
  title?: string; spec?: string; status?: string; provider_id?: string | null; model?: string | null; kind?: string; test_command?: string | null; cap_usd?: number | null; cap_tokens?: number | null;
  tracker: TrackerFields;
};
// A spending cap: a non-negative number (tokens: whole), null or "" (an empty form field) = no cap; undefined = invalid.
const CAPS: Record<string, [boolean, string]> = { cap_usd: [false, "Cap (USD)"], cap_tokens: [true, "Cap (tokens)"], monthly_cap_usd: [false, "Monthly cap (USD)"], monthly_cap_tokens: [true, "Monthly cap (tokens)"] };
function capOf(x: unknown, whole: boolean) {
  if (x === null || x === "") return null;
  const n = typeof x === "number" || (typeof x === "string" && x.trim()) ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 && (!whole || Number.isInteger(n)) ? n : undefined;
}
const capError = (k: string) => `${CAPS[k][1]} must be a non-negative ${CAPS[k][0] ? "whole number" : "number"}, or empty for no cap`;
async function parse(c: Context<Env>, partial: boolean, cur?: Record<string, any>): Promise<{ error: string } | { v: Fields }> {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be a JSON object" };
  const m = pick(c, b);
  if ("error" in m) return m;
  const v: Omit<Fields, "tracker"> = { ...m.v };
  if (b.kind !== undefined) {
    if (partial || !KINDS.includes(b.kind)) return { error: 'kind must be "task" or "epic" (set when the ticket is created)' };
    v.kind = b.kind;
  }
  if (b.title !== undefined || !partial) {
    if (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200) return { error: "title is required (1-200 chars)" };
    v.title = b.title.trim();
  }
  if (b.spec !== undefined) {
    if (typeof b.spec !== "string" || b.spec.length > 20000) return { error: "spec must be a string of at most 20000 chars" };
    v.spec = b.spec;
  }
  if (b.status !== undefined) {
    if (!partial || !STATUSES.includes(b.status)) return { error: `status must be one of ${STATUSES.join(", ")}` };
    v.status = b.status;
  }
  if (b.test_command !== undefined) {
    if (b.test_command !== null && (typeof b.test_command !== "string" || b.test_command.length > 2000)) return { error: "test_command must be a string of at most 2000 chars or null" };
    v.test_command = b.test_command || null;
  }
  for (const k of ["cap_usd", "cap_tokens"] as const)
    if (b[k] !== undefined) {
      const n = capOf(b[k], CAPS[k][0]);
      if (n === undefined) return { error: capError(k) };
      v[k] = n;
    }
  const tracker = trackerFields(c.get("workspaceId"), b, v.kind ?? cur?.kind ?? "task", cur as any);
  return "error" in tracker ? tracker : { v: { ...v, tracker } };
}

// M11: filters, search and sort from the query string (tracker.ts ticketQuery).
app.get("/api/tickets", (c) => {
  const q = ticketQuery(c.get("workspaceId"), c.get("userId"), c.req.query());
  if ("error" in q) return c.json(q, 400);
  return c.json(db.prepare(`${TICKETS} WHERE t.workspace_id = ? AND t.hidden = 0${q.where} ORDER BY ${q.order}`).all(c.get("workspaceId"), ...q.params, ...q.orderParams).map((t) => hydrate(t)));
});

app.post("/api/tickets", async (c) => {
  const p = await parse(c, false);
  if ("error" in p) return c.json(p, 400);
  const id = randomUUID();
  db.prepare("INSERT INTO tickets (id, workspace_id, kind, title, spec, provider_id, model, test_command, cap_usd, cap_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, c.get("workspaceId"), p.v.kind ?? "task", p.v.title!, p.v.spec ?? "", p.v.provider_id ?? null, p.v.model ?? null, p.v.test_command ?? null, p.v.cap_usd ?? null, p.v.cap_tokens ?? null,
  );
  applyTracker(id, p.v.tracker);
  touch(c.get("workspaceId"), { type: "ticket", id });
  return c.json(ticketIn(c, id), 201);
});

// An epic also gets its whole tree of children, each with its state label (planner.ts) and dependency keys.
app.get("/api/tickets/:id", (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  const runs = (db.prepare(`SELECT r.*, p.auth_type AS auth_type, (${METRICS}) AS metrics FROM runs r LEFT JOIN providers p ON p.id = r.provider_id
    WHERE r.ticket_id = ? AND r.eval_run_id IS NULL ORDER BY r.rowid`).all(t.id) as Record<string, any>[]).map((r) => ({ ...r, metrics: r.metrics && JSON.parse(r.metrics) }));
  if (t.kind !== "epic") return c.json({ ...t, runs });
  const tree = db.prepare(`${TREE} ${TICKETS} WHERE t.workspace_id = ? AND t.id IN (SELECT id FROM d) AND t.id <> ? ORDER BY t.number`).all(t.id, c.get("workspaceId"), t.id).map((r) => hydrate(r)) as any[];
  return c.json({ ...t, runs, children: withStates(tree), spent: treeSpend(t.id) }); // spent: what its caps measure
});

app.patch("/api/tickets/:id", async (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  const p = await parse(c, true, t);
  if ("error" in p) return c.json(p, 400);
  const v = p.v;
  const moved = v.status === undefined ? undefined : await moveTicket(t.id, v.status); // first: a refused move changes nothing
  if (moved) return c.json(moved, 409);
  db.prepare("UPDATE tickets SET title = ?, spec = ?, provider_id = ?, model = ?, test_command = ?, cap_usd = ?, cap_tokens = ?, updated_at = ? WHERE id = ?").run(
    v.title ?? t.title, v.spec ?? t.spec, v.provider_id === undefined ? t.provider_id : v.provider_id, v.model === undefined ? t.model : v.model,
    v.test_command === undefined ? t.test_command : v.test_command, v.cap_usd === undefined ? t.cap_usd : v.cap_usd, v.cap_tokens === undefined ? t.cap_tokens : v.cap_tokens, Date.now(), t.id,
  );
  applyTracker(t.id, v.tracker);
  if (v.tracker.parent_id) await startReady(v.tracker.parent_id); // moved into a running epic: queued like a planner's ticket
  touch(c.get("workspaceId"), { type: "ticket", id: t.id });
  return c.json(ticketIn(c));
});

// Deleting an epic deletes its children too (FK cascade), after removing their worktrees and branches.
app.delete("/api/tickets/:id", async (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  const ids = (db.prepare(`${TREE} SELECT id FROM d`).all(t.id) as { id: string }[]).map((r) => r.id);
  const active = db.prepare("SELECT 1 FROM runs WHERE status IN ('queued', 'running') AND ticket_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(ids));
  if (active) return c.json({ error: ids.length > 1 ? "cancel the running runs of this epic and its children first" : "cancel the running run first" }, 409);
  if (db.prepare("SELECT 1 FROM eval_cases WHERE ticket_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(ids)))
    return c.json({ error: `${ids.length > 1 ? "This epic or one of its children" : "This ticket"} is an eval case. Remove it from the evals (Improvement page) first.` }, 409);
  for (const id of ids) await cleanupTicket(id, c.get("workspaceId"));
  db.prepare("DELETE FROM tickets WHERE id = ?").run(t.id);
  touch(c.get("workspaceId"), { type: "ticket", id: t.id });
  if (t.parent_id) wake(t.parent_id, true); // its planner replans (its dependents are blocked now) or completes
  return c.body(null, 204);
});

// Queues a run (attempt 1). Optional body {provider_id, model} overrides the ticket/workspace choice (Retry with…).
// 400 with a user-facing message when the workspace has no valid repository.
app.post("/api/tickets/:id/runs", async (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status === "running") return c.json({ error: "ticket already has a running run" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const m = pick(c, b && typeof b === "object" ? b : {});
  if ("error" in m) return c.json(m, 400);
  const r = await enqueueRun(t.id, m.v);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(db.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId), 201);
});

// Review queue: diff of the latest passed run, then approve (merge into the base branch) or reject (back to todo).
app.get("/api/tickets/:id/diff", async (c) => {
  const t = ticketIn(c);
  const r = t?.status === "review" && reviewRun(t.id); // after approve/reject the branch is gone
  const s = settingsFor(c.get("workspaceId"));
  if (!r || !s) return c.json({ error: "not_found" }, 404);
  const diff = await git(s.repo_path, ["diff", "--no-color", `${r.base_sha}..${r.branch}`, "--", ".", ...scratchPathspec]).catch((e) => `(diff unavailable: ${e.message})`);
  return c.json({ run_id: r.id, branch: r.branch, base_sha: r.base_sha, base_branch: s.base_branch, diff });
});

app.post("/api/tickets/:id/approve", async (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status !== "review") return c.json({ error: "ticket is not in review" }, 409);
  const r = await approve(t.id);
  if ("error" in r) return c.json(r, 409);
  return c.json(ticketIn(c));
});

app.post("/api/tickets/:id/reject", async (c) => {
  const t = ticketIn(c);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status !== "review") return c.json({ error: "ticket is not in review" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const note = typeof b?.note === "string" ? b.note.trim().slice(0, 5000) : "";
  await reject(t.id, note);
  return c.json(ticketIn(c));
});

const TOGGLES = new Set(["auto_approve_children", "model_review", "auto_split", "wiki"]);
const LIMITS: Record<string, [number, number, string]> = { compact_at_tokens: [1000, 100_000_000, "Compact at (tokens)"], max_turns: [10, 500, "Max turns per attempt"], max_minutes: [5, 600, "Max minutes per attempt"] };

app.get("/api/settings", (c) => {
  const s = settingsFor(c.get("workspaceId"));
  return c.json({ ...SETTINGS_DEFAULTS, default_provider_id: null, default_model: null, review_provider_id: null, review_model: null, ...s, configured: !!s });
});

// Workspace default provider/model (null = env fallback) and the reviewer's (null = the run's own). Both live on the
// settings row, so the repository must be saved first.
app.on("PUT", ["/api/settings/default-provider", "/api/settings/review-provider"], async (c) => {
  const b = await c.req.json().catch(() => null);
  const m = b && typeof b === "object" ? pick(c, b) : { error: "body must be a JSON object" };
  if ("error" in m) return c.json(m, 400);
  if (!settingsFor(c.get("workspaceId"))) return c.json({ error: "Save the repository settings first." }, 400);
  const col = c.req.path.endsWith("/review-provider") ? "review" : "default";
  db.prepare(`UPDATE workspace_settings SET ${col}_provider_id = ?, ${col}_model = ?, updated_at = ? WHERE workspace_id = ?`).run(
    m.v.provider_id ?? null, m.v.model ?? null, Date.now(), c.get("workspaceId"),
  );
  return c.json({ ...settingsFor(c.get("workspaceId")), configured: true });
});

// Upsert that merges: an omitted field keeps its value (the default for a new workspace), null resets it to the default.
// Toggles take true/1/"on" (form posts) as on; the repo is checked (root of a repo with commits, base branch exists).
app.put("/api/settings", async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "body must be a JSON object" }, 400);
  const v: Record<string, any> = { ...SETTINGS_DEFAULTS, ...settingsFor(c.get("workspaceId")) };
  for (const k of Object.keys(SETTINGS_DEFAULTS) as (keyof typeof SETTINGS_DEFAULTS)[]) {
    const x = b[k];
    if (x === undefined) continue;
    if (x === null) v[k] = SETTINGS_DEFAULTS[k];
    else if (CAPS[k]) {
      v[k] = capOf(x, CAPS[k][0]);
      if (v[k] === undefined) return c.json({ error: capError(k) }, 400);
    } else if (TOGGLES.has(k)) v[k] = x === true || x === 1 || x === "1" || x === "on" ? 1 : 0;
    else if (LIMITS[k]) {
      const [lo, hi, label] = LIMITS[k];
      v[k] = typeof x === "number" || (typeof x === "string" && x.trim()) ? Number(x) : NaN; // form posts send strings
      if (!Number.isInteger(v[k]) || v[k] < lo || v[k] > hi) return c.json({ error: `${label} must be a whole number from ${lo} to ${hi}` }, 400);
    } else if (typeof x !== "string" || x.length > 2000) return c.json({ error: `${k} must be a string of at most 2000 chars` }, 400);
    else v[k] = x.trim();
  }
  if (!v.image) v.image = SETTINGS_DEFAULTS.image;
  if (!IMAGE_REF.test(v.image)) return c.json({ error: "Sandbox image must be a docker image reference such as node:22 or ghcr.io/org/image:tag" }, 400);
  if (v.protected_paths.split(",").some((p: string) => p.trim().startsWith("/") || p.split("/").includes("..")))
    return c.json({ error: "Protected paths must be relative to the repository root, without .." }, 400);
  const repo = await inspectRepo(v.repo_path, v.base_branch);
  if ("error" in repo) return c.json(repo, 400);
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, repo_path, base_branch, setup_command, test_command, protected_paths, image, compact_at_tokens, auto_approve_children, model_review,
       auto_split, child_size_hint, triage_model, wiki, max_turns, max_minutes, monthly_cap_usd, monthly_cap_tokens, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET repo_path = excluded.repo_path, base_branch = excluded.base_branch, setup_command = excluded.setup_command,
       test_command = excluded.test_command, protected_paths = excluded.protected_paths, image = excluded.image, compact_at_tokens = excluded.compact_at_tokens,
       auto_approve_children = excluded.auto_approve_children, model_review = excluded.model_review, auto_split = excluded.auto_split,
       child_size_hint = excluded.child_size_hint, triage_model = excluded.triage_model, wiki = excluded.wiki, max_turns = excluded.max_turns, max_minutes = excluded.max_minutes,
       monthly_cap_usd = excluded.monthly_cap_usd, monthly_cap_tokens = excluded.monthly_cap_tokens, updated_at = excluded.updated_at`,
  ).run(
    c.get("workspaceId"), repo.repo_path, repo.base_branch, v.setup_command, v.test_command, v.protected_paths, v.image, v.compact_at_tokens, v.auto_approve_children,
    v.model_review, v.auto_split, v.child_size_hint, v.triage_model, v.wiki, v.max_turns, v.max_minutes, v.monthly_cap_usd, v.monthly_cap_tokens, Date.now(),
  );
  return c.json({ ...settingsFor(c.get("workspaceId")), configured: true });
});

// Token/cost usage of the workspace's runs. tokens_in counts uncached prompt tokens incl. cache writes, tokens_cached the cache
// reads, so cache hit rate = cached / (in + cached). Days are UTC (run start), the last 14 including today, newest first.
const SUMS = "COUNT(*) AS runs, COALESCE(SUM(r.tokens_in), 0) AS tokens_in, COALESCE(SUM(r.tokens_out), 0) AS tokens_out, COALESCE(SUM(r.tokens_cached), 0) AS tokens_cached, COALESCE(SUM(r.cost_usd), 0) AS cost_usd";
const FROM_RUNS = "FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.started_at IS NOT NULL";
const withRate = <T extends { tokens_in: number; tokens_cached: number }>(r: T) => ({ ...r, cache_hit_rate: r.tokens_in + r.tokens_cached ? r.tokens_cached / (r.tokens_in + r.tokens_cached) : null });
app.get("/api/usage", (c) => {
  const ws = c.get("workspaceId");
  const rows = (sql: string) => db.prepare(sql).all(ws) as Record<string, any>[];
  const byDay = new Map(rows(`SELECT strftime('%Y-%m-%d', r.started_at / 1000, 'unixepoch') AS day, ${SUMS} ${FROM_RUNS} GROUP BY day`).map((r) => [r.day, r]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    return withRate((byDay.get(day) ?? { day, runs: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0 }) as any);
  });
  const s = settingsFor(ws);
  const m = monthSpend(ws);
  return c.json({
    cap: { usd: s?.monthly_cap_usd ?? null, tokens: s?.monthly_cap_tokens ?? null, used_usd: m.usd, used_tokens: m.tokens, month: m.month }, // what capCheck measures
    totals: withRate(rows(`SELECT ${SUMS} ${FROM_RUNS}`)[0] as any),
    days,
    models: rows(`SELECT r.model, ${SUMS} ${FROM_RUNS} GROUP BY r.model ORDER BY SUM(r.tokens_in + r.tokens_out + r.tokens_cached) DESC, r.model`).map((r) => withRate(r as any)),
    tickets: rows(
      `SELECT t.id, ${ticketKey()} AS key, t.title, ${SUMS} FROM runs r JOIN tickets t ON t.id = r.ticket_id JOIN organization o ON o.id = t.workspace_id
       WHERE t.workspace_id = ? AND t.hidden = 0 AND r.started_at IS NOT NULL GROUP BY t.id ORDER BY SUM(r.tokens_in + r.tokens_out) DESC, t.number LIMIT 10`,
    ).map((r) => withRate(r as any)),
  });
});

// M12 failure mining: per UTC day (run start, the last `days` incl. today, default 14, max 90) and model, newest first. Run
// counts by status; the rest from runs with a run_metrics event (`measured`): percentages 0-100, tool_error_rate 0-1, sums
// for weighting across rows.
app.get("/api/metrics", (c) => {
  const days = Math.min(90, Math.max(1, Math.floor(Number(c.req.query("days") ?? 14)) || 14));
  const since = Date.parse(new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10));
  const m = (k: string) => `json_extract(m.payload, '$.${k}')`;
  const rows = db.prepare(`SELECT strftime('%Y-%m-%d', r.started_at / 1000, 'unixepoch') AS day, r.model, COUNT(*) AS runs,
      SUM(r.status = 'passed') AS passed, SUM(r.status = 'failed') AS failed, SUM(r.status = 'cancelled') AS cancelled, COUNT(m.payload) AS measured,
      AVG(${m("turns_pct")}) AS mean_turns_pct, COALESCE(SUM(${m("turns_pct")}), 0) AS sum_turns_pct, COALESCE(SUM(${m("stuck")} IS NOT NULL), 0) AS stuck,
      COALESCE(SUM(${m("tool_calls")}), 0) AS tool_calls, COALESCE(SUM(${m("tool_errors")}), 0) AS tool_errors,
      1.0 * SUM(${m("tool_errors")}) / NULLIF(SUM(${m("tool_calls")}), 0) AS tool_error_rate, AVG(${m("files_changed")}) AS mean_files_changed
    FROM runs r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN events m ON m.run_id = r.id AND m.type = 'run_metrics'
      AND m.seq = (SELECT MAX(seq) FROM events WHERE run_id = r.id AND type = 'run_metrics')
    WHERE t.workspace_id = ? AND r.started_at >= ? GROUP BY day, r.model ORDER BY day DESC, r.model`).all(c.get("workspaceId"), since);
  return c.json({ days, rows });
});

// M12 failure mining (server/failures.ts): the failure classes of the last `days` (1..90, default 30), and "Mine failures":
// draft tickets (or lessons) from them with the workspace default model. Mined tickets never run on their own.
app.get("/api/failures", (c) => c.json(failures(c.get("workspaceId"), Math.min(90, Math.max(1, Math.floor(Number(c.req.query("days") ?? 30)) || 30)))));
app.post("/api/failures/mine", async (c) => {
  try {
    const { provider, model } = metaProvider(c.get("workspaceId"));
    return c.json(await mine({ workspaceId: c.get("workspaceId"), provider, model, author: email(c) }), 201);
  } catch (e) {
    return c.json({ error: `Mining failed: ${(e as Error).message}` }, 502);
  }
});

// --- M6 self-improvement: lessons, prompt versions, evals. Workspace-scoped like everything else; humans only (agents have
// no tool that reaches the DB). See server/improve.ts.

const email = (c: Context<Env>) => (db.prepare("SELECT email FROM user WHERE id = ?").get(c.get("userId")) as { email: string }).email;

// {body} of at most max chars, or an error message.
async function textBody(c: Context<Env>, max: number, what: string): Promise<{ error: string } | { v: string }> {
  const b = await c.req.json().catch(() => null);
  if (typeof b?.body !== "string") return { error: "body must be a string" };
  if (b.body.length > max) return { error: `${what} must be at most ${max} characters (now ${b.body.length})` };
  return { v: b.body.trim() };
}

// Every version, newest first, with the run/ticket a reflection came from. The newest is the active one.
app.get("/api/lessons", (c) =>
  c.json({
    max: LESSONS_MAX,
    versions: db.prepare(`SELECT l.*, r.attempt AS run_attempt, ${ticketKey()} AS ticket_key, t.number AS ticket_number
      FROM lessons l LEFT JOIN runs r ON r.id = l.run_id LEFT JOIN tickets t ON t.id = r.ticket_id LEFT JOIN organization o ON o.id = t.workspace_id
      WHERE l.workspace_id = ? ORDER BY l.version DESC`).all(c.get("workspaceId")),
  }),
);

// Human edit: a new version (applies to the next run). Saving unchanged text creates nothing.
app.put("/api/lessons", async (c) => {
  const b = await textBody(c, LESSONS_MAX, "Lessons");
  if ("error" in b) return c.json(b, 400);
  const cur = currentLessons(c.get("workspaceId"));
  if (cur?.body === b.v || (!cur && !b.v)) return c.json(cur ?? null);
  return c.json(saveLessons(c.get("workspaceId"), b.v, { source: "human", author: email(c) }), 201);
});

app.post("/api/lessons/:id/restore", (c) => {
  const l = db.prepare("SELECT * FROM lessons WHERE id = ? AND workspace_id = ?").get(c.req.param("id"), c.get("workspaceId")) as { body: string; version: number } | undefined;
  if (!l) return c.json({ error: "not_found" }, 404);
  return c.json(saveLessons(c.get("workspaceId"), l.body, { source: "restore", author: email(c), restored_from: l.version }), 201);
});

// Prompt versions, newest first, each with its eval runs (current = on the current case set) and whether it can be promoted.
app.get("/api/prompts", (c) => {
  const ws = c.get("workspaceId");
  activePrompt(ws); // seeds v1
  const set = caseSet(ws);
  const evals = db.prepare("SELECT * FROM eval_runs WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC").all(ws) as Record<string, any>[];
  const versions = db.prepare("SELECT * FROM prompts WHERE workspace_id = ? AND role = 'worker' ORDER BY version DESC").all(ws) as Prompt[];
  return c.json({
    max: PROMPT_MAX,
    case_count: (JSON.parse(set) as string[]).length,
    versions: versions.map((p) => ({
      ...p,
      evals: evals.filter((e) => e.prompt_id === p.id).map((e) => ({ ...e, case_ids: JSON.parse(e.case_ids), current: e.case_ids === set })),
      promotion: promotion(ws, p),
    })),
  });
});

// "New version": a human-edited copy. Never active until promoted.
app.post("/api/prompts", async (c) => {
  const b = await textBody(c, PROMPT_MAX, "A prompt");
  if ("error" in b) return c.json(b, 400);
  if (!b.v) return c.json({ error: "the prompt is empty" }, 400);
  return c.json(addPrompt(c.get("workspaceId"), b.v, { source: "human", author: email(c) }), 201);
});

// "Propose improvement": one no-tools call with the workspace default model (improve.ts propose). Never activated.
app.post("/api/prompts/propose", async (c) => {
  try {
    const { provider, model } = metaProvider(c.get("workspaceId"));
    return c.json(await propose({ workspaceId: c.get("workspaceId"), provider, model }), 201);
  } catch (e) {
    return c.json({ error: `Proposal failed: ${(e as Error).message}` }, 502);
  }
});

app.post("/api/prompts/:id/evals", async (c) => {
  const p = promptIn(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const ids = b?.case_ids;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every((x: unknown) => typeof x === "string"))) return c.json({ error: "case_ids must be an array of ids" }, 400);
  const r = startEval(c.get("workspaceId"), p, ids);
  return "error" in r ? c.json(r, 400) : c.json(r, 201);
});

// Human click only, and only when the promotion rule allows it (409 with the reason otherwise).
app.post("/api/prompts/:id/promote", (c) => {
  const ws = c.get("workspaceId");
  const p = promptIn(ws, c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const rule = promotion(ws, p);
  if (!rule.ok) return c.json({ error: rule.reason }, 409);
  promote(ws, p);
  return c.json({ ok: true, version: p.version });
});

// Cases, and eval runs (newest first) with one row per case run: result, tokens, and the run itself for its transcript.
app.get("/api/evals", (c) => {
  const ws = c.get("workspaceId");
  const runs = db.prepare("SELECT * FROM eval_runs WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC").all(ws) as Record<string, any>[];
  const caseRuns = db.prepare(`SELECT r.*, res.passed AS case_passed, res.turns, res.duration_ms, c.title AS case_title FROM runs r JOIN eval_runs er ON er.id = r.eval_run_id
    LEFT JOIN eval_results res ON res.run_id = r.id LEFT JOIN eval_cases c ON c.id = r.eval_case_id WHERE er.workspace_id = ? ORDER BY r.rowid`).all(ws) as Record<string, any>[];
  return c.json({
    cases: db.prepare(`SELECT c.*, ${ticketKey()} AS key FROM eval_cases c JOIN tickets t ON t.id = c.ticket_id
      JOIN organization o ON o.id = c.workspace_id WHERE c.workspace_id = ? ORDER BY c.created_at, c.rowid`).all(ws),
    runs: runs.map((e) => ({ ...e, case_ids: JSON.parse(e.case_ids), results: caseRuns.filter((r) => r.eval_run_id === e.id) })),
  });
});

// "Add to evals": an approved ticket becomes a frozen case, but only if its test command FAILS at the approved run's base
// commit in a clean worktree + sandbox (validateCase). Settings (commands, protected paths, image) are taken as they are now.
app.post("/api/evals/cases", async (c) => {
  const b = await c.req.json().catch(() => null);
  const t = typeof b?.ticket_id === "string" ? ticketIn(c, b.ticket_id) : undefined;
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status !== "done") return c.json({ error: "Only approved (done) tickets can become eval cases." }, 409);
  if (t.kind === "epic") return c.json({ error: "An epic can't be an eval case (its children can)." }, 409);
  const run = db.prepare(`SELECT r.base_sha FROM runs r JOIN events e ON e.run_id = r.id WHERE r.ticket_id = ? AND e.type = 'review'
    AND json_extract(e.payload, '$.decision') = 'approved' ORDER BY r.rowid DESC LIMIT 1`).get(t.id) as { base_sha: string } | undefined;
  if (!run) return c.json({ error: "This ticket was not approved through review, so there is no base commit to replay it from." }, 409);
  const s = settingsFor(c.get("workspaceId"));
  if (!s) return c.json({ error: "No repository configured." }, 400);
  if (t.eval_case_id) return c.json({ error: "This ticket is already an eval case." }, 409);
  const frozen = { repo_path: s.repo_path, base_sha: run.base_sha, setup_command: s.setup_command, test_command: t.test_command ?? s.test_command, protected_paths: s.protected_paths, image: s.image };
  const invalid = await validateCase(frozen).catch((e) => `Validation failed: ${(e as Error).message}`);
  if (invalid) return c.json({ error: invalid }, 400);
  if (ticketIn(c, t.id)?.eval_case_id) return c.json({ error: "This ticket is already an eval case." }, 409); // re-checked after the await
  const id = randomUUID();
  db.prepare(`INSERT INTO eval_cases (id, workspace_id, ticket_id, title, spec, repo_path, base_sha, setup_command, test_command, protected_paths, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, c.get("workspaceId"), t.id, t.title, t.spec, ...Object.values(frozen));
  return c.json(db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id), 201);
});

// Changes the case set: earlier eval runs no longer count for promotion.
app.delete("/api/evals/cases/:id", (c) => {
  const r = db.prepare("DELETE FROM eval_cases WHERE id = ? AND workspace_id = ?").run(c.req.param("id"), c.get("workspaceId"));
  return r.changes ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

// --- M10 project wiki (see SPEC "Project wiki (M10)", server/wiki.ts). Workspace-scoped like everything else; page paths are
// checked against root .md / modules/ / howto/ and resolved with resolveIn.

app.get("/api/wiki", async (c) => {
  const ws = c.get("workspaceId");
  const s = settingsFor(ws);
  const base = s && (await headOf(s));
  const runs = db.prepare(`SELECT r.id, r.wiki_op, r.status, r.model, r.started_at, r.ended_at, r.tokens_in, r.tokens_out, r.tokens_cached, t.hidden,
      CASE WHEN t.hidden THEN NULL ELSE ${ticketKey()} END AS ticket_key, t.number AS ticket_number,
      (SELECT payload FROM events e WHERE e.run_id = r.id AND e.type = 'wiki' ORDER BY e.seq DESC LIMIT 1) AS result
    FROM runs r JOIN tickets t ON t.id = r.ticket_id JOIN organization o ON o.id = t.workspace_id WHERE t.workspace_id = ? AND r.role = 'wiki' ORDER BY r.rowid DESC LIMIT 20`).all(ws) as Record<string, any>[];
  return c.json({
    enabled: s ? !!s.wiki : true, configured: !!s, ...(await wikiView(ws, s && base ? { repo: s.repo_path, base } : undefined)),
    runs: runs.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null })),
  });
});

app.get("/api/wiki/page", async (c) => {
  const path = c.req.query("path") ?? "";
  const body = await readPage(c.get("workspaceId"), path);
  return body === undefined ? c.json({ error: "not_found" }, 404) : c.json({ path, body });
});

// A human edit of an existing page: validated like the maintainer's output; one commit "edit <path> by <email>". base: the
// page as it was opened (refused if it changed since).
app.put("/api/wiki/page", async (c) => {
  const b = await c.req.json().catch(() => null);
  if (typeof b?.path !== "string" || typeof b?.body !== "string" || b.body.length > 20_000) return c.json({ error: "path and body (at most 20000 chars) are required" }, 400);
  const r = await editPage(c.get("workspaceId"), b.path, b.body, email(c), { base: typeof b.base === "string" ? b.base : undefined, repo: settingsFor(c.get("workspaceId"))?.repo_path });
  return "problems" in r ? c.json({ error: r.problems.join("\n"), problems: r.problems }, 400) : c.json(r);
});

app.get("/api/wiki/history", async (c) => c.json(await history(c.get("workspaceId"))));

app.get("/api/wiki/diff", async (c) => {
  try {
    return c.json({ diff: await wikiDiff(c.get("workspaceId"), c.req.query("sha") ?? "") });
  } catch (e) {
    if (e instanceof AgentError) throw e;
    return c.json({ error: "not_found" }, 404); // no such commit
  }
});

// "Build wiki" / "Refresh stale pages": queue a maintainer run (same flow as an ingest); the run row tells where to watch it.
for (const [path, op] of [["bootstrap", "bootstrap"], ["lint", "lint"]] as const)
  app.post(`/api/wiki/${path}`, async (c) => {
    const r = await enqueueWiki(c.get("workspaceId"), op);
    return "error" in r ? c.json({ error: r.error }, r.status) : c.json(db.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId), 201);
  });

app.get("/api/runs/:id", (c) => {
  const r = runIn(c);
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});

app.get("/api/runs/:id/metrics", (c) => {
  const r = runIn(c);
  const m = r && (db.prepare(`SELECT (${METRICS}) AS payload FROM runs r WHERE r.id = ?`).get(r.id) as { payload: string | null });
  return m?.payload ? c.json(JSON.parse(m.payload)) : c.json({ error: "not_found" }, 404);
});

app.post("/api/runs/:id/cancel", (c) => {
  const r = runIn(c);
  if (!r) return c.json({ error: "not_found" }, 404);
  return cancelRun(r.id) ? c.json({ ok: true }) : c.json({ error: "run is not queued or running" }, 409);
});

// Live board and notification bell: a change ping per ticket/notification in the workspace (the client refetches). Nothing is
// replayed: the client fetches on (re)connect. A 25 s comment keeps proxies from closing the idle stream.
app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    let wake = () => {};
    let closed = false;
    const queue: Change[] = [];
    const unsubscribe = subscribeWorkspace(c.get("workspaceId"), (e) => (queue.push(e), wake()));
    stream.onAbort(() => ((closed = true), wake()));
    try {
      while (!closed) {
        const e = queue.shift();
        if (e) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        else {
          const timer = setTimeout(() => wake(), 25_000);
          await new Promise<void>((resolve) => (wake = resolve));
          clearTimeout(timer);
          if (!queue.length && !closed) await stream.write(": keepalive\n\n");
        }
      }
    } finally {
      unsubscribe();
    }
  }));

// Replay stored events, then live ones; closes after run_finished once the stored events are drained (a reflection after a
// reject lands after run_finished). Subscribing first and de-duping by seq loses nothing in between.
app.get("/api/runs/:id/events", (c) => {
  const r = runIn(c);
  if (!r) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    const queue: StoredEvent[] = [];
    let wake = () => {};
    let closed = false;
    const unsubscribe = subscribe(r.id, (e) => (queue.push(e), wake()));
    stream.onAbort(() => ((closed = true), wake()));
    const rows = db.prepare("SELECT seq, type, payload, created_at FROM events WHERE run_id = ? ORDER BY seq").all(r.id) as Record<string, any>[];
    queue.unshift(...rows.map((e) => ({ ...e, payload: JSON.parse(e.payload), run_id: r.id }) as StoredEvent));
    let last = 0;
    let finished = false;
    try {
      while (!closed) {
        const e = queue.shift();
        if (!e) {
          if (finished) break;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        if (e.seq <= last) continue;
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
        if (e.type === "run_finished") finished = true;
      }
    } finally {
      unsubscribe();
    }
  });
});
