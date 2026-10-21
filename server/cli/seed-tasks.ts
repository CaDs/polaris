// npm run seed-tasks -- --workspace <slug> --project <KEY> [--file tasks.md]
// One ticket per unchecked "- [ ]" item under a "## Mn ..." milestone heading. Title "Mn: <item>", spec = heading + item.
// Re-running is safe: items whose title already exists as a ticket in the workspace are skipped.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import "../auth.ts"; // creates Better Auth tables (organization) that ours reference
import { db, migrate } from "../db.ts";

export function parseTasks(md: string) {
  const items: { title: string; spec: string }[] = [];
  let heading = "";
  let milestone = "";
  for (const line of md.split("\n")) {
    if (/^#{1,2}\s/.test(line)) {
      milestone = /^##\s+(M\d+)\b/.exec(line)?.[1] ?? "";
      heading = line.replace(/^#+\s*/, "");
      continue;
    }
    const item = /^\s*- \[ \] (.+)$/.exec(line)?.[1].trim();
    if (item && milestone) items.push({ title: `${milestone}: ${item}`.slice(0, 200), spec: `${heading}\n\n- ${item}` });
  }
  return items;
}

export function seedTasks(project: { id: string; workspace_id: string }, md: string) {
  let created = 0;
  for (const it of parseTasks(md)) {
    if (db.prepare("SELECT 1 FROM tickets WHERE project_id = ? AND title = ?").get(project.id, it.title)) continue;
    db.prepare("INSERT INTO tickets (id, workspace_id, project_id, title, spec) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), project.workspace_id, project.id, it.title, it.spec);
    created++;
  }
  return created;
}

if (import.meta.main) {
  const { values: opt } = parseArgs({ options: { workspace: { type: "string" }, project: { type: "string" }, file: { type: "string", default: "tasks.md" } } });
  if (!opt.workspace || !opt.project) throw new Error("usage: npm run seed-tasks -- --workspace <slug> --project <KEY> [--file tasks.md]");
  migrate();
  const project = db.prepare("SELECT p.id, p.workspace_id FROM projects p JOIN organization o ON o.id = p.workspace_id WHERE o.slug = ? AND p.key = ?").get(opt.workspace, opt.project.toUpperCase()) as
    | { id: string; workspace_id: string }
    | undefined;
  if (!project) throw new Error(`project ${opt.project} not found in workspace ${opt.workspace}`);
  const md = readFileSync(opt.file, "utf8");
  console.log(`created ${seedTasks(project, md)} of ${parseTasks(md).length} tickets in ${opt.workspace} ${opt.project}`);
}
