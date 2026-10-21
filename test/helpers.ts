import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared by the API suites. Import it with `await import("./helpers.ts")` after setting the file's own env
// (POLARIS_PROVIDER, POLARIS_CONCURRENCY, ...): it loads the server. Each test file runs in its own process
// (DB_PATH=:memory:), so nothing here is shared between files.
process.env.POLARIS_SANDBOX ??= "host"; // docker is covered by docker.test.ts
process.env.POLARIS_DATA_DIR ??= mkdtempSync(join(tmpdir(), "polaris-data-"));
export const { app } = await import("../server/app.ts");
export const { db } = await import("../server/db.ts");

export const origin = "http://localhost:5173";
export const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();

// A one-commit repo on main (realpath: macOS tmpdir is a symlink).
export function tempRepo(files: Record<string, string> = { "README.md": "hi\n" }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  sh(dir, "git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init");
  return dir;
}

export async function call(method: string, path: string, cookie = "", body?: unknown, headers: Record<string, string> = { origin }) {
  const res = await app.request(path, { method, headers: { cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: json, cookie: set || cookie };
}

export const signUp = (name: string) => call("POST", "/api/auth/sign-up/email", "", { email: `${name}@x.dev`, password: "password-123", name });
// Signs up <name>@x.dev and creates the workspace <name> (slug <name>); returns the session cookie.
export async function user(name: string, workspace = true) {
  const { cookie } = await signUp(name);
  return workspace ? (await call("POST", "/api/auth/organization/create", cookie, { name, slug: name })).cookie : cookie;
}
// The host path of a run's worktree: the API does not return it.
export const worktreeOf = (runId: string) => (db.prepare("SELECT worktree FROM runs WHERE id = ?").get(runId) as { worktree: string | null }).worktree!;
export const wsOf = (slug: string) => (db.prepare("SELECT id FROM organization WHERE slug = ?").get(slug) as { id: string }).id;

export async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 60_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = await fn();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

export const events = (runId: string) =>
  (db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { type: string; payload: string }[]).map((e) => ({ type: e.type, p: JSON.parse(e.payload) }));
export const task = (runId: string) => events(runId).find((e) => e.type === "run_started")!.p.task as string;

// Polls the ticket until it has this status; on a timeout the failure shows its runs' errors and finish reasons.
export async function waitFor(cookie: string, ticketId: string, status: string, ms?: number) {
  try {
    return await until(`ticket ${status}`, async () => {
      const t = (await call("GET", `/api/tickets/${ticketId}`, cookie)).body;
      return t.status === status && t;
    }, ms);
  } catch (e) {
    const runs = db.prepare("SELECT id FROM runs WHERE ticket_id = ?").all(ticketId) as { id: string }[];
    assert.fail(`${(e as Error).message}: ${JSON.stringify(runs.flatMap((r) => events(r.id).filter((x) => x.type === "error" || x.type === "run_finished").map((x) => x.p)))}`);
  }
}
export const idle = (ws: string) =>
  until("no run in flight", () => !db.prepare("SELECT 1 FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? AND r.status IN ('queued', 'running')").get(ws));

// Mock model servers: listen on a free loopback port; answer in Anthropic's SSE format.
export async function listen(handler: Parameters<typeof createServer>[1]) {
  const srv = createServer(handler);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}
export const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
// One streamed reply: a tool call (name + JSON input) or a text answer; usage 10 in, 1 + 5 out.
export const reply = (r: { tool: string; input: string } | { text: string }) =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...("tool" in r
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: r.tool, input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: r.input } },
        ]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text } }]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool" in r ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
  ]);

// A project (one repo) in the session's workspace: key from the name (pia → PIA), a fresh temp repo, no setup command.
const PROJECT_FIELDS = ["repo_path", "base_branch", "setup_command", "test_command", "protected_paths", "image"];
const split = (o: Record<string, unknown>, repoFields: boolean) => Object.fromEntries(Object.entries(o).filter(([k]) => PROJECT_FIELDS.includes(k) === repoFields));
export const keyOf = (name: string) => name.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();
export async function project(cookie: string, name: string, o: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/projects", cookie, { name, key: keyOf(name), repo_path: tempRepo(), setup_command: "", ...o });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (!projects.has(cookie)) projects.set(cookie, r.body.id); // the session's first project is where fileTicket files
  return r.body as { id: string; key: string; name: string };
}

// The project configure and workspace made for a session; fileTicket files into it.
const projects = new Map<string, string>();
export const projectOf = (cookie: string) => projects.get(cookie);

// Saves a settings body the way one form used to: the repository fields on the session's project (created on first use,
// keyed like its workspace's slug: alice → ALI), the rest as workspace settings. The reply carries both.
export async function configure(cookie: string, body: object = {}) {
  let pid = projects.get(cookie);
  const repo = split(body as Record<string, unknown>, true);
  if (!pid || Object.keys(repo).length) {
    let r;
    if (pid) r = await call("PATCH", `/api/projects/${pid}`, cookie, repo);
    else {
      const ws = (await call("GET", "/api/auth/get-session", cookie)).body?.session?.activeOrganizationId;
      const { slug } = db.prepare("SELECT slug FROM organization WHERE id = ?").get(ws) as { slug: string };
      r = await call("POST", "/api/projects", cookie, { name: slug, key: keyOf(slug), ...repo });
    }
    if (r.status >= 300) return r;
    projects.set(cookie, (pid = r.body.id as string));
  }
  const r = await call("PUT", "/api/settings", cookie, split(body as Record<string, unknown>, false));
  const p = (await call("GET", `/api/projects/${pid}`, cookie)).body;
  return { ...r, body: r.status === 200 ? { ...p, ...r.body } : r.body };
}

// POST /api/tickets in the session's project (unless the body names one).
export const fileTicket = (cookie: string, body: object) => call("POST", "/api/tickets", cookie, { project_id: projects.get(cookie), ...body });

// A user, its workspace and a project on a temp repo configured with these settings (repo fields go to the project, the
// rest to the workspace). `settings(o)` saves them again with o on top. `create` files tickets in the project.
export async function workspace(name: string, base: Record<string, unknown> = {}) {
  const cookie = await user(name);
  const repo = tempRepo();
  const p = await project(cookie, name, { repo_path: repo, ...split(base, true) });
  projects.set(cookie, p.id);
  const settings = (o: object = {}) => configure(cookie, { repo_path: repo, setup_command: "", ...base, ...o });
  const saved = await settings();
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const get = async (id: string) => (await call("GET", `/api/tickets/${id}`, cookie)).body;
  const byKey = async (key: string) => (await call("GET", "/api/tickets", cookie)).body.find((t: any) => t.key === key);
  const create = async (body: Record<string, unknown>) => (await call("POST", "/api/tickets", cookie, { project_id: p.id, ...body })).body;
  const is = (id: string, status: string, ms?: number) => waitFor(cookie, id, status, ms);
  return { cookie, repo, ws: wsOf(name), project: p, settings, get, byKey, create, is };
}
