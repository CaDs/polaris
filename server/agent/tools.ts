import { spawn, execFile, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AgentError, type ErrorKind, type ToolDef, type ToolUseBlock } from "./types.ts";

// Shell execution is injected so M3 can swap the host for `docker exec` without touching the tools.
export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };
export type Exec = (command: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<ExecResult>;
// protectedPaths: repo-relative dirs/files edit_file must not write (tests/, evals/). The sandbox also mounts them read-only.
// turn/callId/tool name the spill file of a long result (see spill below). reads: read_file outputs of the current conversation (loop.ts).
export type ToolContext = { root: string; exec: Exec; signal?: AbortSignal; protectedPaths?: string[]; turn?: number; callId?: string; tool?: string; reads?: Map<string, { out: string; turn: number }> };
export type Tool = { def: ToolDef; run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string> };

const MAX_OUTPUT = 30_000; // read_file only: shell/search output over SPILL_AT goes to a file instead
const MAX_CAPTURE = 20_000_000; // hard cap per stream on pathological output (it is also what ends up on disk)
export const SPILL_AT = 8_000;
const SPILL_TAIL = 2_000;

export function truncate(s: string, max = MAX_OUTPUT) {
  if (s.length <= max) return s;
  const half = max / 2;
  return `${s.slice(0, half)}\n[... ${s.length - max} chars truncated ...]\n${s.slice(-half)}`;
}

// A result longer than SPILL_AT is written in full to .polaris/outputs/<turn>-<tool>-<id>.txt in the run root (visible as
// /work/.polaris/outputs in the sandbox; git-excluded) and the model gets the path, the size and the last ~2000 chars.
export function spill(ctx: ToolContext, text: string) {
  if (text.length <= SPILL_AT) return text;
  const rel = `.polaris/outputs/${ctx.turn ?? 0}-${ctx.tool ?? "tool"}-${(ctx.callId ?? "x").replace(/[^\w.-]/g, "_")}.txt`;
  writeScratch(ctx.root, rel, text);
  const lines = text.split("\n").length;
  return `[Output too long: saved to ${rel}]\nTotal: ${text.length} chars, ${lines} lines. Last ${SPILL_TAIL} chars:\n${text.slice(-SPILL_TAIL)}\n[Use read_file with offset/limit on ${rel}, or rg/tail via shell, to see the rest.]`;
}

// Harness writes into the run root (spilled outputs, history): the agent may have planted symlinks there, so the dir must
// resolve inside root and the file is opened without following one.
// ponytail: check, then open; a dir swapped in between (by a process still running in the sandbox) wins. openat if that matters.
export function writeScratch(root: string, rel: string, text: string, append = false) {
  const dir = resolveIn(root, dirname(rel));
  mkdirSync(dir, { recursive: true });
  const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_APPEND, O_TRUNC } = constants;
  const fd = openSync(join(dir, basename(rel)), O_WRONLY | O_CREAT | O_NOFOLLOW | (append ? O_APPEND : O_TRUNC), 0o644);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// Resolves a model-supplied path to a real path inside root, following symlinks. Security boundary. .native: the on-disk
// case of every existing component (on a case-insensitive filesystem TESTS/x is tests/x).
export function resolveIn(root: string, p: string) {
  const realRoot = realpathSync.native(root);
  // Models see the sandbox, where the workspace is mounted at /work: accept /work/... as workspace-relative.
  const abs = resolve(realRoot, p === "/work" || p.startsWith("/work/") ? `.${p.slice(5)}` : p);
  // Resolve the deepest entry that exists (lstat, so a dangling symlink counts and gets resolved).
  let probe = abs;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      probe = dirname(probe);
    }
  }
  let real: string;
  try {
    real = join(realpathSync.native(probe), relative(probe, abs));
  } catch {
    throw new AgentError("InvalidArguments", `cannot resolve path: ${p}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new AgentError("InvalidArguments", `path is outside the workspace: ${p}`);
  return real;
}

const badInput = (message: string) => Object.assign(new AgentError("InvalidArguments", message), { badInput: true });

function str(input: Record<string, unknown>, key: string, optional = false) {
  const v = input[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string") throw badInput(`"${key}" must be a string`);
  return v;
}

function num(input: Record<string, unknown>, key: string, fallback: number) {
  const v = input[key] ?? fallback;
  if (typeof v !== "number" || !(v >= 0)) throw badInput(`"${key}" must be a non-negative number`);
  return v;
}

const CAPPED = `\n[output capped at ${MAX_CAPTURE} chars]`;

// Spawns a process and captures its output. On timeout/abort, `kill` must stop everything it started.
export function capture(child: ChildProcess, kill: () => void, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }) {
  return new Promise<ExecResult>((done) => {
    const out = { stdout: "", stderr: "" };
    let timedOut = false;
    // ponytail: capture stops at MAX_CAPTURE per stream (the tail beyond it is lost).
    const collect = (k: "stdout" | "stderr") => (d: Buffer) => {
      if (out[k].length < MAX_CAPTURE) out[k] += d;
      else if (!out[k].endsWith(CAPPED)) out[k] += CAPPED;
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      done({ ...out, code, timedOut });
    };
    child.on("error", (e) => {
      out.stderr += e.message;
      finish(null);
    });
    child.on("close", finish);
  });
}

export const hostExec: Exec = (command, { cwd, timeoutMs, signal }) => {
  // Own process group, so timeout/abort kills everything the command started.
  const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };
  return capture(child, kill, { timeoutMs, signal });
};

// "tests/, ./evals" → ["tests", "evals"]. Entries are repo-relative; settings reject "..".
export const parseProtected = (list: string) =>
  list.split(",").map((p) => p.trim().replace(/^(\.\/)+|\/+$/g, "")).filter(Boolean);

// Case-insensitive filesystem (macOS default)? Then TESTS/ is tests/ and .GIT is .git, so path checks compare folded.
// ponytail: probed once in tmpdir; a worktree on a volume with other case rules gets tmpdir's.
const caseless = (() => {
  const d = mkdtempSync(join(tmpdir(), "polaris-case-"));
  try {
    return existsSync(join(dirname(d), basename(d).toUpperCase()));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
const fold = (s: string) => (caseless ? s.toLowerCase() : s);

// True if `rel` (repo-relative, "/"-separated) is or is under one of the (parsed) protected paths.
export function isProtected(rel: string, protectedPaths: string[]) {
  const r = fold(rel);
  return protectedPaths.map(fold).some((p) => r === p || r.startsWith(p + "/"));
}

// Path for writing: inside root, not protected, and no .git anywhere in it (a .git file or dir is what the host's git
// reads: pointed at agent-written config, it runs commands on the host). Returns the real path.
function writable(root: string, p: string, protectedPaths: string[]) {
  const file = resolveIn(root, p);
  const rel = relative(realpathSync.native(root), file).split(sep).join("/");
  if (isProtected(rel, protectedPaths) || rel.split("/").some((s) => fold(s) === ".git")) throw new AgentError("InvalidArguments", `${p} is read-only (protected path)`);
  return file;
}

const readFile: Tool = {
  def: {
    name: "read_file",
    description:
      "Read a text file. Every line is prefixed with its line number and a tab (not part of the file). Use offset/limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        offset: { type: "integer", description: "First line to read (1-based, default 1)" },
        limit: { type: "integer", description: "Max lines to read (default 2000)" },
      },
      required: ["path"],
    },
  },
  async run(input, { root, reads, turn }) {
    const p = str(input, "path")!;
    const file = resolveIn(root, p);
    if (!existsSync(file)) throw new AgentError("InvalidArguments", `file not found: ${p}`);
    const lines = readFileSync(file, "utf8").split("\n");
    const start = Math.max(1, num(input, "offset", 1));
    const end = Math.min(lines.length, start - 1 + num(input, "limit", 2000));
    // Every line numbered: a bare tab gutter got copied into edit_file's old_string by local models.
    const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`);
    const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}; use offset to read more]` : "";
    const out = truncate(body.join("\n")) + more;
    // Byte-identical to an earlier output of this conversation: point at it instead of repeating it (any edit changes the bytes).
    const key = JSON.stringify([p, start, end]);
    const prev = reads?.get(key);
    if (prev?.out === out) return `[unchanged since your read_file of ${p} at turn ${prev.turn}; that output is above in this conversation]`;
    reads?.set(key, { out, turn: turn ?? 0 });
    return out;
  },
};

const editFile: Tool = {
  def: {
    name: "edit_file",
    description:
      "Replace old_string with new_string in a file. old_string must match exactly (no line-number gutter) and occur exactly once; include surrounding lines to make it unique. To create a new file, pass an empty old_string and the full content as new_string.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(input, { root, protectedPaths = [] }) {
    const p = str(input, "path")!;
    const oldS = str(input, "old_string")!;
    const newS = str(input, "new_string")!;
    const file = writable(root, p, protectedPaths);
    const exists = existsSync(file);
    if (oldS === "") {
      if (exists) throw new AgentError("InvalidArguments", `${p} already exists; old_string must be non-empty to edit it`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, newS);
      return `created ${p}`;
    }
    if (!exists) throw new AgentError("InvalidArguments", `file not found: ${p}`);
    const text = readFileSync(file, "utf8");
    const count = text.split(oldS).length - 1;
    if (count === 0) throw new AgentError("InvalidArguments", `old_string not found in ${p} (it must match the file exactly, without read_file's line-number prefix)`);
    if (count > 1) throw new AgentError("InvalidArguments", `old_string occurs ${count} times in ${p}; include more context to make it unique`);
    writeFileSync(file, text.replace(oldS, () => newS));
    return `edited ${p}`;
  },
};

// The wiki maintainer's only way to remove a page (it has no shell).
const deleteFile: Tool = {
  def: {
    name: "delete_file",
    description: "Delete a file.",
    input_schema: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root" } }, required: ["path"] },
  },
  async run(input, { root, protectedPaths = [] }) {
    const p = str(input, "path")!;
    const file = writable(root, p, protectedPaths);
    if (!existsSync(file)) throw new AgentError("InvalidArguments", `file not found: ${p}`);
    unlinkSync(file);
    return `deleted ${p}`;
  },
};

// V4A patch format (what GPT models are trained on). Checked in full before anything is written.
const PATCH_HELP = "Patch format: '*** Begin Patch', then '*** Add File: p' (+lines) | '*** Delete File: p' | '*** Update File: p' (hunks: optional '@@ header', then ' context', '-old', '+new' lines), then '*** End Patch'.";

// Index of `old` (a run of lines) in `lines` at or after `from`; exact, then ignoring trailing, then all whitespace.
function findRun(lines: string[], old: string[], from: number) {
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()])
    for (let i = from; i + old.length <= lines.length; i++) if (old.every((o, j) => norm(lines[i + j]) === norm(o))) return i;
  return -1;
}

function applyHunks(path: string, text: string, hunks: { header?: string; lines: string[] }[]) {
  const eol = text.endsWith("\n");
  const lines = text.split("\n");
  if (eol) lines.pop();
  let pos = 0;
  hunks.forEach((h, n) => {
    const old = h.lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const next = h.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    if (h.header) {
      const at = findRun(lines, [h.header], pos);
      if (at < 0) throw new AgentError("InvalidArguments", `${path}: hunk ${n + 1}: header line not found: ${h.header}`);
      pos = at + 1;
    }
    // A hunk with nothing to match is a pure insertion: after the header line, else at the end of the file.
    const at = old.length ? findRun(lines, old, pos) : h.header ? pos : lines.length;
    if (at < 0) throw new AgentError("InvalidArguments", `${path}: hunk ${n + 1} does not apply: these lines were not found (in order, after the previous hunk):\n${old.join("\n")}`);
    lines.splice(at, old.length, ...next);
    pos = at + next.length;
  });
  return lines.join("\n") + (eol || !lines.length ? "\n" : "");
}

const applyPatch: Tool = {
  def: {
    name: "apply_patch",
    description: `Add, update or delete files with one patch. ${PATCH_HELP} Context lines must match the file; paths are relative to the workspace root.`,
    input_schema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
  },
  async run(input, { root, protectedPaths = [] }) {
    const lines = str(input, "patch")!.replace(/\r\n/g, "\n").split("\n");
    while (lines.at(-1) === "") lines.pop();
    if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") throw new AgentError("InvalidArguments", `patch must start with '*** Begin Patch' and end with '*** End Patch'. ${PATCH_HELP}`);
    // Virtual file state, so later operations see earlier ones; null = deleted.
    const state = new Map<string, string | null>();
    const read = (file: string) => (state.has(file) ? state.get(file)! : existsSync(file) ? readFileSync(file, "utf8") : null);
    const out: string[] = [];
    for (let i = 1; i < lines.length - 1; ) {
      const m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i].trim());
      if (!m) throw new AgentError("InvalidArguments", `unexpected line in patch: ${lines[i]}. ${PATCH_HELP}`);
      const [, op, p] = m;
      const file = writable(root, p.trim(), protectedPaths);
      let j = i + 1;
      while (j < lines.length - 1 && !lines[j].startsWith("*** ")) j++;
      const body = lines.slice(i + 1, j).filter((l) => l !== "*** End of File");
      i = j;
      const cur = read(file);
      if (op === "Add") {
        if (cur !== null) throw new AgentError("InvalidArguments", `${p} already exists; use Update File`);
        if (body.some((l) => l[0] !== "+")) throw new AgentError("InvalidArguments", `${p}: every line of an added file must start with '+'`);
        state.set(file, body.map((l) => l.slice(1)).join("\n") + "\n");
      } else if (cur === null) {
        throw new AgentError("InvalidArguments", `file not found: ${p}`);
      } else if (op === "Delete") {
        state.set(file, null);
      } else {
        // ponytail: no '*** Move to:' (renames); use shell mv.
        const hunks: { header?: string; lines: string[] }[] = [];
        for (const l of body) {
          if (l.startsWith("@@")) hunks.push({ header: l.slice(2).trim() || undefined, lines: [] });
          else {
            if (!hunks.length) hunks.push({ lines: [] });
            if (l !== "" && !" +-".includes(l[0])) throw new AgentError("InvalidArguments", `${p}: hunk line must start with ' ', '-' or '+': ${l}`);
            hunks.at(-1)!.lines.push(l === "" ? " " : l); // models often drop the space of an empty context line
          }
        }
        if (!hunks.length) throw new AgentError("InvalidArguments", `${p}: Update File has no hunks`);
        state.set(file, applyHunks(p, cur, hunks));
      }
      out.push(`${op === "Add" ? "added" : op === "Delete" ? "deleted" : "updated"} ${p.trim()}`);
    }
    if (!out.length) throw new AgentError("InvalidArguments", `patch contains no operations. ${PATCH_HELP}`);
    for (const [file, text] of state) {
      if (text === null) unlinkSync(file);
      else (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
    }
    return out.join("\n");
  },
};

const shell: Tool = {
  def: {
    name: "shell",
    description:
      "Run a shell command (sh -c) in the workspace root and return its exit code, stdout and stderr. Use for running tests, builds and git; use read_file/edit_file/search for files.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Seconds before the command is killed (default 120, max 600)" },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const { root, exec, signal } = ctx;
    const command = str(input, "command")!;
    const timeoutMs = Math.min(num(input, "timeout", 120), 600) * 1000;
    const r = await exec(command, { cwd: root, timeoutMs, signal });
    const text = spill(ctx, `exit code: ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    if (signal?.aborted) throw new AgentError("UserAborted", `command aborted\n${text}`);
    if (r.timedOut) throw new AgentError("Timeout", `command timed out after ${timeoutMs / 1000}s\n${text}`);
    return text;
  },
};

const search: Tool = {
  def: {
    name: "search",
    description: "Search file contents with ripgrep (regex). Returns matching lines as path:line:text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Rust regex" },
        path: { type: "string", description: "File or directory to search (default: workspace root)" },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const { root, signal } = ctx;
    const pattern = str(input, "pattern")!;
    const glob = str(input, "glob", true);
    const target = relative(realpathSync.native(root), resolveIn(root, str(input, "path", true) ?? ".")) || ".";
    const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", ...(glob ? ["--glob", glob] : []), "-e", pattern, "--", target];
    return new Promise((done, fail) => {
      execFile("rg", args, { cwd: root, timeout: 30_000, maxBuffer: MAX_CAPTURE, signal }, (err, stdout, stderr) => {
        if (!err) return done(spill(ctx, stdout));
        if (err.code === 1) return done("no matches");
        if (signal?.aborted) return fail(new AgentError("UserAborted", "search aborted"));
        if (err.killed) return fail(new AgentError("Timeout", "search timed out after 30s"));
        if (err.code === "ENOENT") return fail(new AgentError("UnexpectedEnvironment", "rg (ripgrep) is not installed"));
        fail(new AgentError("InvalidArguments", stderr.trim() || err.message));
      });
    });
  },
};

export const tools: Tool[] = [readFile, editFile, shell, search];
// Planner (M7): reads code, never writes it.
export const readOnlyTools: Tool[] = [readFile, search];
// Model review (M8): reads and runs commands (git diff, tests), never edits.
export const reviewTools: Tool[] = [readFile, search, shell];
// Wiki maintainer (M10): reads the code, edits only the wiki copy (the caller protects the code checkout).
export const wikiTools: Tool[] = [readFile, editFile, deleteFile, search];
// Edit tool per model family: GPT models are trained on apply_patch, everything else gets str_replace.
export const toolsFor = (kind?: string): Tool[] => (kind === "openai" ? [readFile, applyPatch, shell, search] : tools);

// Never throws: every failure becomes an is_error result the model can read.
// {command: string, timeout?: integer}, from the tool's input_schema.
const expectedInput = (def: ToolDef) => {
  const s = def.input_schema as { properties?: Record<string, { type?: string }>; required?: string[] };
  return `{${Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${v.type ?? "any"}`).join(", ")}}`;
};

export async function runTool(all: Tool[], call: ToolUseBlock, ctx: ToolContext): Promise<{ content: string; is_error: boolean; kind?: ErrorKind }> {
  const tool = all.find((t) => t.def.name === call.name);
  try {
    if (!tool) throw new AgentError("InvalidArguments", `unknown tool: ${call.name}`);
    if (call.invalid_input !== undefined)
      throw new AgentError("InvalidArguments", `the arguments of this ${call.name} call were not valid JSON (the output was probably cut off by the token limit): ${call.invalid_input.slice(0, 200)}${call.invalid_input.length > 200 ? "…" : ""}\nNothing was run. Call it again with smaller arguments, e.g. split a large edit into several.`);
    return { content: await tool.run(call.input ?? {}, { ...ctx, tool: call.name, callId: call.id }), is_error: false };
  } catch (e) {
    // fs errors (EISDIR, EACCES, ...) are the environment's; anything else is a harness bug.
    const kind: ErrorKind = e instanceof AgentError ? e.kind : typeof (e as NodeJS.ErrnoException).code === "string" ? "UnexpectedEnvironment" : "Unknown";
    return { content: `${kind}: ${(e as Error).message}${e instanceof AgentError && e.badInput && tool ? `\nExpected input: ${expectedInput(tool.def)}` : ""}`, is_error: true, kind };
  }
}
