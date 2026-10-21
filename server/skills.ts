import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { db } from "./db.ts";
import { git } from "./git.ts";
import { projectSettings } from "./runs.ts";
import { PHASES } from "./agent/context.ts";
import { refuseSymlinks, resolveIn } from "./agent/tools.ts";

// M17 skills (see SPEC "Skills (M17)"). Repo skills are .polaris/skills/*.md in a project's repository (code-reviewed,
// read-only here). Workspace skills live in the skills table: every run gets them as files in .polaris/workspace-skills/,
// so agents treat both kinds the same (agent/context.ts). In chat, a member can attach skills to a message: their full text
// goes with it.

type Env = { Variables: { userId: string; workspaceId: string } };
type Row = { id: string; workspace_id: string; name: string; description: string; body: string; phases: string; author: string | null; created_at: number; updated_at: number };
export const WORKSPACE_SKILLS = ".polaris/workspace-skills";
const MAX_ATTACHED = 5;

const view = (r: Row) => ({ id: r.id, name: r.name, description: r.description, body: r.body, phases: JSON.parse(r.phases) as string[], author: r.author, updated_at: r.updated_at });
const rows = (ws: string) => db.prepare("SELECT * FROM skills WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(ws) as Row[];
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const slug = (r: Row) => `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill"}-${r.id.slice(0, 8)}`;

// Writes the workspace's skills into <root>/.polaris/workspace-skills/ (replacing what was there), as skill files. Returns
// how many: none = no directory.
export function writeWorkspaceSkills(ws: string, root: string) {
  refuseSymlinks(root, WORKSPACE_SKILLS);
  const dir = join(root, WORKSPACE_SKILLS);
  rmSync(dir, { recursive: true, force: true });
  const all = rows(ws);
  if (!all.length) return 0;
  mkdirSync(dir, { recursive: true });
  for (const r of all)
    writeFileSync(join(dir, `${slug(r)}.md`), `---\nname: ${oneLine(r.name)}\ndescription: ${oneLine(r.description)}\nphases: ${(JSON.parse(r.phases) as string[]).join(", ")}\n---\n\n${r.body.trim()}\n`);
  return all.length;
}

// The full text of skills attached to a chat message, from the checkout at root (repo skills) and the table (workspace
// skills). Ids: "repo:<file>.md" or "ws:<id>". Unknown ids are left out.
export function attachedSkills(ws: string, root: string, ids: string[]) {
  return ids.flatMap((id) => {
    if (id.startsWith("ws:")) {
      const r = db.prepare("SELECT * FROM skills WHERE id = ? AND workspace_id = ?").get(id.slice(3), ws) as Row | undefined;
      return r ? [{ id, name: r.name, body: r.body.trim() }] : [];
    }
    const file = /^repo:([\w.-]+\.md)$/.exec(id)?.[1];
    if (!file) return [];
    try {
      const text = readFileSync(resolveIn(root, `.polaris/skills/${file}`), "utf8");
      const name = /^name:\s*(.*)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "")?.[1].trim() || file.slice(0, -3);
      return [{ id, name, body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim() }];
    } catch {
      return [];
    }
  });
}
export const attachedText = (skills: { name: string; body: string }[]) =>
  skills.length ? `# Skills the user attached (follow them for this message)\n\n${skills.map((s) => `## ${s.name}\n\n${s.body}`).join("\n\n")}` : "";
export const skillIds = (x: unknown) =>
  Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === "string" && s.length <= 120))].slice(0, MAX_ATTACHED) : [];

// --- routes ---

export const skillRoutes = new Hono<Env>();

function parse(b: Record<string, any> | null, ws: string, cur?: Row): { error: string } | { v: Pick<Row, "name" | "description" | "body" | "phases"> } {
  if (!b || typeof b !== "object") return { error: "body must be a JSON object" };
  const text = (k: string, max: number) => {
    const x = b[k] ?? (cur as Record<string, any> | undefined)?.[k];
    return typeof x === "string" && x.trim() && x.trim().length <= max ? x.trim() : undefined;
  };
  const name = text("name", 60);
  if (!name) return { error: "name is required (1-60 chars)" };
  const description = text("description", 300);
  if (!description) return { error: "description is required (1-300 chars): it is how agents decide to read the skill" };
  const body = text("body", 20_000);
  if (!body) return { error: "instructions are required (1-20000 chars)" };
  const phases = b.phases ?? (cur ? JSON.parse(cur.phases) : ["worker", "planner"]);
  if (!Array.isArray(phases) || !phases.length || !phases.every((p) => (PHASES as readonly string[]).includes(p))) return { error: `phases must name at least one of ${PHASES.join(", ")}` };
  const taken = rows(ws).find((r) => r.id !== cur?.id && r.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (taken) return { error: `a skill named "${taken.name}" already exists` };
  return { v: { name, description, body, phases: JSON.stringify([...new Set(phases)]) } };
}
const email = (c: Context<Env>) => (db.prepare("SELECT email FROM user WHERE id = ?").get(c.get("userId")) as { email: string } | undefined)?.email ?? null;
const own = (c: Context<Env>) => db.prepare("SELECT * FROM skills WHERE id = ? AND workspace_id = ?").get(c.req.param("id") as string, c.get("workspaceId")) as Row | undefined;

skillRoutes.get("/skills", (c) => c.json(rows(c.get("workspaceId")).map(view)));
skillRoutes.post("/skills", async (c) => {
  const p = parse(await c.req.json().catch(() => null), c.get("workspaceId"));
  if ("error" in p) return c.json(p, 400);
  const id = randomUUID();
  db.prepare("INSERT INTO skills (id, workspace_id, name, description, body, phases, author) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, c.get("workspaceId"), p.v.name, p.v.description, p.v.body, p.v.phases, email(c));
  return c.json(view(db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Row), 201);
});
skillRoutes.patch("/skills/:id", async (c) => {
  const cur = own(c);
  if (!cur) return c.json({ error: "not_found" }, 404);
  const p = parse(await c.req.json().catch(() => null), c.get("workspaceId"), cur);
  if ("error" in p) return c.json(p, 400);
  db.prepare("UPDATE skills SET name = ?, description = ?, body = ?, phases = ?, updated_at = ? WHERE id = ?").run(p.v.name, p.v.description, p.v.body, p.v.phases, Date.now(), cur.id);
  return c.json(view(own(c)!));
});
skillRoutes.delete("/skills/:id", (c) => {
  const cur = own(c);
  if (!cur) return c.json({ error: "not_found" }, 404);
  db.prepare("DELETE FROM skills WHERE id = ?").run(cur.id);
  return c.body(null, 204);
});

// What the chat composer offers for a project: the repo's skills on its base branch (read from git, so no checkout is
// needed) and the workspace's. A repo whose skills cannot be read just contributes none.
skillRoutes.get("/projects/:pid/skills", async (c) => {
  const s = projectSettings(c.req.param("pid"));
  if (!s || s.workspace_id !== c.get("workspaceId")) return c.json({ error: "not_found" }, 404);
  const ref = `refs/heads/${s.base_branch}`;
  const files = (await git(s.repo_path, ["ls-tree", "--name-only", `${ref}:.polaris/skills`]).catch(() => "")).split("\n").filter((f) => /^[\w.-]+\.md$/.test(f));
  const repo = await Promise.all(files.map(async (f) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await git(s.repo_path, ["show", `${ref}:.polaris/skills/${f}`]).catch(() => ""))?.[1] ?? "";
    const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
    return { id: `repo:${f}`, name: get("name") || f.slice(0, -3), description: get("description"), source: "repo" as const };
  }));
  const ws = rows(c.get("workspaceId")).map((r) => ({ id: `ws:${r.id}`, name: r.name, description: r.description, source: "workspace" as const }));
  return c.json([...repo, ...ws]);
});
