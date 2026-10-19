import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolveIn, truncate } from "./agent/tools.ts";
import { AgentError } from "./agent/types.ts";
import { git } from "./git.ts";
import { dataDir } from "./sandbox.ts";
import { today } from "./tracker.ts";

// M10 per-project wiki (see SPEC "Project wiki (M10)"): a git repository per workspace at <dataDir>/wikis/<workspace_id>/,
// owned by the harness. Agents only read a snapshot of its HEAD (.polaris/wiki/); the only writers are the wiki
// maintainer run (in a clone, committed here only if the mechanical lint passes) and human edits. Everything is
// serialized per workspace (wikiSerial). The orchestration of maintainer runs lives in runs.ts.

const execFileP = promisify(execFile);
export const WIKI_PROMPT = readFileSync(new URL("./agent/prompts/wiki.md", import.meta.url), "utf8");
const SCHEMA = readFileSync(new URL("./agent/prompts/wiki-schema.md", import.meta.url), "utf8");
const INDEX_MAX = 6000; // chars
const PAGE_MAX = 3500;
const SPECIAL = ["SCHEMA.md", "index.md", "log.md"]; // every other .md is a content page
const PATH = /^([\w.-]+|(modules|howto)\/[\w.-]+)\.md$/; // root .md files, modules/*.md, howto/*.md
const LINK = /^- \[([^\]]+)\]\(([^)]+)\)(?:\s+—\s+(.*))?$/;
// edit_file must not write the read-only code checkout, nor the clone's .git (its config could run commands on the host).
export const WIKI_PROTECTED = ["code", "wiki/.git"];

export const wikiDir = (ws: string) => join(dataDir(), "wikis", ws);

// Init on first use, with an initial commit. Memoized so two first callers don't both init.
const ready = new Map<string, Promise<string>>();
export function ensureWiki(ws: string) {
  const dir = wikiDir(ws);
  let p = ready.get(dir);
  if (!p) {
    p = (async () => {
      if (!existsSync(join(dir, ".git"))) {
        mkdirSync(dir, { recursive: true });
        await git(dir, ["init", "-q", "-b", "main"]);
        writeFileSync(join(dir, "SCHEMA.md"), SCHEMA);
        writeFileSync(join(dir, "index.md"), "# Index\n");
        writeFileSync(join(dir, "log.md"), "# Log\n");
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-q", "-m", "init wiki"]);
      }
      return dir;
    })();
    ready.set(dir, p);
    p.catch(() => ready.delete(dir));
  }
  return p;
}

// One writer at a time per workspace: maintainer runs and human edits queue up here.
const chains = new Map<string, Promise<unknown>>();
export function wikiSerial<T>(ws: string, fn: () => Promise<T>) {
  const job = (chains.get(ws) ?? Promise.resolve()).then(fn);
  chains.set(ws, job.catch(() => {}));
  return job;
}

// The project's base branch head, or undefined when the branch is gone.
export const headOf = (s: { repo_path: string; base_branch: string }) => git(s.repo_path, ["rev-parse", "--verify", `refs/heads/${s.base_branch}^{commit}`]).catch(() => undefined);

// --- pages ---

type Meta = { title: string; sources: string[]; verified: string; updated: string };

// Frontmatter of a content page, or why it is invalid. `sources: [a, b]` is a flow list; verified is a commit sha (hex), so
// it can never be read as a git option.
export function frontmatter(text: string): Meta | string {
  const fm = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text)?.[1];
  if (fm === undefined) return "missing frontmatter (a --- block at the top)";
  const unq = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");
  const get = (k: string) => {
    const v = new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(fm)?.[1];
    return v === undefined ? undefined : v.trim();
  };
  const title = unq(get("title") ?? "");
  if (!title) return "frontmatter needs a title";
  const list = /^\[(.*)\]$/.exec(get("sources") ?? "");
  if (!list) return "frontmatter needs sources: [repo-relative paths, ...]";
  const sources = list[1].split(",").map((s) => unq(s.trim())).filter(Boolean);
  const bad = sources.find((s) => s.startsWith("/") || s.split("/").includes(".."));
  if (bad) return `source ${bad} must be a repo-relative path`;
  const verified = unq(get("verified") ?? "");
  if (!/^[0-9a-f]{7,40}$/i.test(verified)) return "frontmatter needs verified: <commit sha of the project repo>";
  return { title, sources, verified, updated: unq(get("updated") ?? "") };
}

// [line, title, path, summary] of every page entry in index.md.
const indexLinks = (index: string) => index.split("\n").flatMap((l) => { const m = LINK.exec(l.trim()); return m ? [[l.trim(), m[1], m[2], m[3] ?? ""]] : []; });

// Mechanical checks of a wiki working copy; returns the problems (empty = valid).
export function lintDir(dir: string): string[] {
  const out: string[] = [];
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (p !== ".git") walk(p);
      } else if (!e.isFile()) out.push(`${p}: not a regular file`);
      else files.push(p);
    }
  };
  walk("");
  for (const p of files) if (!PATH.test(p)) out.push(`${p}: not allowed (only root .md files, modules/*.md and howto/*.md)`);
  const pages = files.filter((p) => PATH.test(p) && !SPECIAL.includes(p));
  for (const f of SPECIAL) if (!files.includes(f)) out.push(`${f} is missing`);
  const index = files.includes("index.md") ? readFileSync(join(dir, "index.md"), "utf8") : "";
  if (index.length > INDEX_MAX) out.push(`index.md is ${index.length} chars (at most ${INDEX_MAX}): shorten the summaries`);
  const linked = new Set<string>();
  for (const [, , path] of indexLinks(index)) {
    linked.add(path);
    if (!pages.includes(path)) out.push(`index.md links to ${path}, which is not a content page`);
  }
  for (const p of pages.sort()) {
    const text = readFileSync(join(dir, p), "utf8");
    if (text.length > PAGE_MAX) out.push(`${p} is ${text.length} chars (at most ${PAGE_MAX}): split it into linked pages`);
    const meta = frontmatter(text);
    if (typeof meta === "string") out.push(`${p}: ${meta}`);
    if (!linked.has(p)) out.push(`${p} is not linked from index.md`);
  }
  return out;
}

// --- reading the wiki repo (HEAD, never the working tree) ---

const show = async (ws: string, path: string) => git(await ensureWiki(ws), ["show", `HEAD:${path}`]).catch(() => undefined);
const safe = (dir: string, path: string) => {
  if (!PATH.test(path)) throw new AgentError("InvalidArguments", `not a wiki page path: ${path}`);
  return resolveIn(dir, path);
};

type PageInfo = { path: string; title: string; summary: string; line: string; sources: string[]; verified: string; updated: string; stale: string | null };

// Why the page's `verified` or `sources` don't name what is in the project repo (a missing source never shows up in a diff),
// or null.
async function unknownSource(repo: string, m: Meta) {
  const has = (spec: string) => git(repo, ["cat-file", "-e", spec]).then(() => true, () => false);
  if (!(await has(`${m.verified}^{commit}`))) return `verified commit ${m.verified} is not in the project repo`;
  for (const s of m.sources) if (!(await has(`${m.verified}:${s}`))) return `source ${s} does not exist at ${m.verified.slice(0, 8)}`;
  return null;
}

// The project files among `sources` that changed between `verified` and `base`, or null (fresh). An unknown verified sha or
// source counts as stale.
async function changed(repo: string, base: string, m: Meta | string) {
  if (typeof m === "string") return `invalid frontmatter (${m})`;
  if (!m.sources.length) return null;
  const unknown = await unknownSource(repo, m);
  if (unknown) return unknown;
  try {
    const files = (await git(repo, ["--literal-pathspecs", "diff", "--name-only", m.verified, base, "--", ...m.sources])).split("\n").filter(Boolean);
    return files.length ? files.slice(0, 5).join(", ") + (files.length > 5 ? `, … (${files.length} files)` : "") : null;
  } catch {
    return "verified commit unknown";
  }
}

// The index with one entry per linked page. stale: where to compute the flags (the project repo and the commit to compare to).
export async function pageList(ws: string, stale?: { repo: string; base: string }) {
  const index = (await show(ws, "index.md")) ?? "";
  const pages = await Promise.all(indexLinks(index).map(async ([line, title, path, summary]) => {
    const text = PATH.test(path) ? await show(ws, path) : undefined;
    const m = text === undefined ? "page is missing" : frontmatter(text);
    return { path, title, summary, line, sources: typeof m === "string" ? [] : m.sources, verified: typeof m === "string" ? "" : m.verified,
      updated: typeof m === "string" ? "" : m.updated, stale: stale ? await changed(stale.repo, stale.base, m) : null } satisfies PageInfo;
  }));
  return { index, pages };
}

export async function readPage(ws: string, path: string) {
  safe(await ensureWiki(ws), path);
  return show(ws, path);
}

// What the first user message carries (all roles): the index, its links as repo-root paths (.polaris/wiki/<path>, so a page
// is never mistaken for a code file), with a ⚠ flag on pages whose sources changed since they were verified (computed against
// `base`, the commit the run starts from). "" when the wiki has no pages.
export async function wikiSection(ws: string, repo: string, base: string) {
  const { index, pages } = await pageList(ws, { repo, base });
  if (!pages.length) return "";
  const byLine = new Map(pages.map((p) => [p.line, p]));
  const lines = index.split("\n").filter((l) => l.trim() && !l.startsWith("# ")).map((l) => {
    const p = byLine.get(l.trim());
    return p ? l.replace(`](${p.path})`, `](.polaris/wiki/${p.path})`) + (p.stale ? ` ⚠ may be stale: ${p.stale}` : "") : l;
  });
  return `# Project wiki\n\nRead the pages relevant to your task (.polaris/wiki/<path>) before exploring the code; trust code over the wiki when they disagree.\n\n${lines.join("\n")}`;
}

export async function wikiView(ws: string, stale?: { repo: string; base: string }) {
  const { index, pages } = await pageList(ws, stale);
  const dir = wikiDir(ws);
  const wt = await git(dir, ["status", "--porcelain"]);
  return { index, pages, log: (await show(ws, "log.md")) ?? "", problems: wt ? ["wiki working copy has uncommitted changes"] : await lintHead(ws) };
}

// Mechanical lint of HEAD (the Lint button): exports HEAD to a temp dir.
async function lintHead(ws: string) {
  const tmp = join(dataDir(), "worktrees", `wiki-lint-${randomUUID()}`);
  try {
    await snapshotTo(ws, tmp);
    return lintDir(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function history(ws: string) {
  const out = await git(await ensureWiki(ws), ["log", "-n", "100", "--format=%H%x1f%s%x1f%aI"]);
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, subject, date] = l.split("\x1f");
    return { sha, subject, date };
  });
}
export const wikiDiff = async (ws: string, sha: string) => {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new AgentError("InvalidArguments", "sha must be a commit id");
  return git(await ensureWiki(ws), ["show", "--no-color", "--format=%s%n", sha]);
};

// --- snapshot for runs ---

type Tree = Record<string, string>;
function readTree(dir: string, rel = "", out: Tree = {}) {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) readTree(dir, p, out);
    else out[p] = e.isFile() ? readFileSync(join(dir, p), "utf8") : "(not a file)";
  }
  return out;
}

async function snapshotTo(ws: string, dest: string) {
  const dir = await ensureWiki(ws);
  mkdirSync(dest, { recursive: true });
  await execFileP("sh", ["-c", 'git -C "$1" archive HEAD | tar -x -C "$2"', "sh", dir, dest]);
}

// Exports the wiki's HEAD to <worktree>/.polaris/wiki and returns its content: wikiTampered compares against it at the gate
// (the dir is git-excluded, so git can't see a write there; the sandbox mounts it read-only, the host sandbox does not).
export async function materialize(ws: string, worktree: string) {
  const dest = join(worktree, ".polaris/wiki");
  await snapshotTo(ws, dest);
  return readTree(dest);
}
export function wikiTampered(worktree: string, original: Tree) {
  const now = existsSync(join(worktree, ".polaris/wiki")) ? readTree(join(worktree, ".polaris/wiki")) : {};
  return [...new Set([...Object.keys(original), ...Object.keys(now)])].filter((p) => original[p] !== now[p]).sort().map((p) => `.polaris/wiki/${p}`);
}

// --- writing: a clone, validated, then fast-forwarded into the wiki repo ---

export async function openCopy(ws: string, dest: string) {
  const dir = await ensureWiki(ws);
  await git(dir, ["clone", "-q", dir, dest]);
}

export type Finished = { problems: string[] } | { unchanged: true } | { sha: string };

// Lints the clone (with `repo`, the project repo, also each page's verified sha and sources), then commits it with `message`
// and the log entry (log.md is the harness's: whatever the writer did to it is undone first) and fast-forwards the wiki repo.
// Nothing is committed when a problem is found or nothing changed.
export async function finishCopy(ws: string, copy: string, message: string, entry: string, repo?: string): Promise<Finished> {
  await git(copy, ["checkout", "-q", "--", "log.md"]).catch(() => {});
  const problems = lintDir(copy);
  if (!problems.length && repo)
    for (const [, , path] of indexLinks(readFileSync(join(copy, "index.md"), "utf8"))) {
      const why = await unknownSource(repo, frontmatter(readFileSync(join(copy, path), "utf8")) as Meta);
      if (why) problems.push(`${path}: ${why}`);
    }
  if (problems.length) return { problems };
  if (!(await git(copy, ["status", "--porcelain"]))) return { unchanged: true };
  appendFileSync(join(copy, "log.md"), `\n${entry}\n`);
  await git(copy, ["add", "-A"]);
  await git(copy, ["commit", "-q", "-m", message]);
  const dir = wikiDir(ws);
  await git(dir, ["fetch", "-q", copy, "HEAD"]);
  await git(dir, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
  return { sha: await git(dir, ["rev-parse", "HEAD"]) };
}

// A human edit of one existing page: same validation and commit flow as the maintainer's. `base`: the page as the editor
// opened it; a page that changed since (an ingest landed meanwhile) is refused rather than overwritten.
export function editPage(ws: string, path: string, body: string, email: string, o: { base?: string; repo?: string } = {}) {
  return wikiSerial(ws, async () => {
    const tmp = join(dataDir(), "worktrees", `wiki-edit-${randomUUID()}`);
    try {
      await openCopy(ws, tmp);
      const file = safe(tmp, path);
      if (path === "log.md" || !existsSync(file)) throw new AgentError("InvalidArguments", path === "log.md" ? "log.md is maintained by the harness" : `no such page: ${path}`);
      if (o.base !== undefined && readFileSync(file, "utf8").trimEnd() !== o.base.trimEnd()) throw new AgentError("InvalidArguments", `${path} changed since you opened it: reload it and edit again`);
      writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
      return await finishCopy(ws, tmp, `edit ${path} by ${email}`, `## [${today()}] edit | ${path} by ${email}`, o.repo);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// --- maintainer tasks (the first user message of a wiki run) ---

const MAX_DIFF = 15_000;

export function wikiTask(op: "ingest" | "bootstrap" | "lint", o: {
  repo: string; sha: string; index: string;
  ticket?: { key: string; title: string; spec: string }; files?: string[]; diff?: string; reply?: string; stale?: { path: string; why: string }[];
}) {
  const parts = [
    [
      "# Environment",
      `- Repository: ${o.repo}; \`code/\` is a read-only checkout at commit ${o.sha} (read_file, search)`,
      "- `wiki/` is the wiki's working copy: read it and edit it with edit_file (nothing else is writable). Read `wiki/SCHEMA.md` first",
      `- Commit for \`verified\`: ${o.sha}; today is ${today()}`,
    ].join("\n"),
  ];
  if (op === "ingest") {
    const t = o.ticket!;
    parts.push(
      `# Task: ingest an approved change\n\nThe change below was reviewed, merged (merge commit ${o.sha}) and is part of \`code/\`. Update the wiki for it.`,
      `# Ticket\n\n${t.key} ${t.title}${t.spec ? `\n\n${t.spec}` : ""}`,
      `# Files changed\n\n${o.files!.join("\n") || "(none)"}`,
      `# Merged diff\n\n\`\`\`diff\n${truncate(o.diff ?? "", MAX_DIFF, "head")}\n\`\`\``,
      `# The worker's final reply (it may contain a "## Wiki notes" section; check its claims against the code)\n\n${o.reply?.trim() ? truncate(o.reply.trim(), 4000, "head") : "(none)"}`,
    );
  } else if (op === "bootstrap")
    parts.push("# Task: build the wiki\n\nWrite `overview.md` (architecture map), a `modules/` page for each main part, `howto/` pages for common changes (from the README, AGENTS.md or CLAUDE.md if present, and from the code) and `gotchas.md`. Pages that already exist: improve them rather than duplicating.");
  else
    parts.push(`# Task: re-verify stale pages\n\nThe sources of these pages changed in the project since they were verified. Check each against the current code and fix or delete it, then set verified to ${o.sha}.\n\n${o.stale!.map((p) => `- ${p.path} — changed: ${p.why}`).join("\n")}`);
  parts.push(`# Current wiki/index.md\n\n${o.index.trim() || "(empty)"}`);
  return parts.join("\n\n");
}
