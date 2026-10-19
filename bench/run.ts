// npm run bench -- --model <ollama model> [--levels L1,L2] [--runs N] [--split 0|1] [--wiki 0|1] [--max-turns N] [--max-minutes N]
//                  [--out bench/results/x.jsonl] [--tag <label>] [--server-dir <polaris checkout>] [--ollama URL]
// npm run bench -- --check [--levels ...]   (no model: each level's base must fail the grader, base + answer key must pass)
// Complexity ladder (bench/README.md): one Polaris server on a free port with a temp DB and data dir; per level and run a
// fresh target repo, user and workspace; the ticket runs with the real model + Docker sandbox until it settles, then the
// grader re-runs the tests on the result with the locked tests restored, and one JSON line per run goes to --out.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { COMMAND_TIMEOUT, openSandbox, SANDBOX_IMAGE } from "../server/sandbox.ts";
import { truncate } from "../server/agent/tools.ts";
import { report } from "./report.ts";

const BENCH = fileURLToPath(new URL(".", import.meta.url));
export type Level = { level: string; title: string; spec: string; test_files: string[]; key_lines: number; key_files: number };
export const LEVELS: Level[] = JSON.parse(readFileSync(join(BENCH, "tickets.json"), "utf8"));
export const SETUP = "npm ci --no-audit --no-fund";
export const TEST = "npm test";
const PROTECTED = "test/,e2e/"; // covers every level's locked test (and the rest of the target's suite)

const sh = (cwd: string, cmd: string, ...args: string[]) => execFileSync("sh", ["-c", cmd, "sh", ...args], { cwd, encoding: "utf8" }).trim();
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=bench", "-c", "user.email=bench@localhost", ...args], { encoding: "utf8" }).trim();
const level = (id: string) => LEVELS.find((l) => l.level === id.toUpperCase() || l.level === `L${id}`) ?? die(`unknown level ${id}`);
function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// A fresh target repo for a level: the template + the level's patch (its locked test; for L2, the code it asks for removed),
// one commit on main. The answer key is never applied here.
export function prepare(l: Level, dir = realpathSync(mkdtempSync(join(tmpdir(), `polaris-bench-${l.level}-`)))) {
  cpSync(join(BENCH, "target"), dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "apply", join(BENCH, "levels", `${l.level}.patch`));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `bench ${l.level} base`);
  return dir;
}

// The answer key on top of a prepared repo, on branch `key` (for --check and the grader's unit test).
export function applyKey(l: Level, repo: string) {
  git(repo, "checkout", "-q", "-b", "key");
  git(repo, "apply", join(BENCH, "keys", `${l.level}.patch`));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `bench ${l.level} answer key`);
  git(repo, "checkout", "-q", "main");
}

// Grades `ref` of `repo`: its tree exported to a temp dir, the level's locked tests restored from a fresh prepare()
// (whatever the agent did to them), then `command` in a throwaway sandbox container. Pass = exit 0.
export async function grade(l: Level, repo: string, ref: string, command = `${SETUP} && ${TEST}`) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `polaris-bench-grade-`)));
  const pristine = prepare(l);
  try {
    sh(repo, 'git archive "$1" | tar -x -C "$2"', ref, dir);
    for (const f of l.test_files) cpSync(join(pristine, f), join(dir, f));
    const sb = await openSandbox(randomUUID(), dir, [], SANDBOX_IMAGE);
    try {
      // The target's own suite has a few timing-sensitive tests: a failure gets one rerun; a pass then is marked flaky.
      const exec = () => sb.exec(command, { cwd: dir, timeoutMs: COMMAND_TIMEOUT });
      const first = await exec();
      const r = first.code === 0 ? first : await exec();
      return { pass: r.code === 0, flaky: r !== first && r.code === 0, code: r.code, timed_out: r.timedOut, tail: first.code ? truncate(first.stdout + first.stderr, 3000, "tail") : "" };
    } finally {
      await sb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pristine, { recursive: true, force: true });
  }
}

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => done(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A Polaris server from `serverDir` (this checkout, or an older one) on its own port, DB and data dir.
async function startServer(serverDir: string, home: string) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), DB_PATH: join(home, "polaris.db"), POLARIS_DATA_DIR: join(home, "data"), POLARIS_OPEN_SIGNUP: "1",
    POLARIS_CONCURRENCY: "1", // one model call at a time: the GPU is shared, and split children / wiki runs queue behind each other
    POLARIS_SECRET_KEY: randomBytes(32).toString("hex"), BETTER_AUTH_SECRET: randomBytes(24).toString("hex"), BETTER_AUTH_URL: base,
  };
  delete env.POLARIS_PROVIDER;
  const out = openSync(join(home, "server.log"), "a");
  const child = spawn(process.execPath, [join(serverDir, "server/index.ts")], { cwd: serverDir, env, stdio: ["ignore", out, out] });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) die(`server exited (${child.exitCode}); see ${home}/server.log`);
    if (await fetch(`${base}/api/settings`).then(() => true, () => false)) return { base, child };
    await sleep(500);
  }
  die(`server did not start; see ${home}/server.log`);
}

function client(base: string) {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { cookie, origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (set) cookie = set;
    const json = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}
type Api = ReturnType<typeof client>;

// The ticket and, when it was split, the epic tree it handed off to; done = nothing in it is todo or running.
async function settled(api: Api, id: string): Promise<{ done: boolean; id: string; status: string; kind: string; chain: string[]; children: number }> {
  const t = await api("GET", `/api/tickets/${id}`);
  if (t.escalated_to) return settled(api, t.escalated_to).then((s) => ({ ...s, chain: [t.key, ...s.chain] }));
  const open = (s: string) => s === "todo" || s === "running";
  const kids: { status: string }[] = t.children ?? [];
  return { done: !open(t.status) && !kids.some((k) => open(k.status)), id: t.id, status: t.status, kind: t.kind, chain: [t.key], children: kids.length };
}

// Per-workspace metrics from the server's DB (read-only).
function metrics(dbPath: string, ws: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runs = db.prepare("SELECT r.id, r.role FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE t.workspace_id = ? ORDER BY r.rowid").all(ws) as { id: string; role: string }[];
    const m = { runs: runs.length, worker_runs: 0, planner_runs: 0, turns: 0, tool_calls: 0, tool_errors: 0, compactions: 0, input: 0, output: 0, cache_read: 0, secs: 0, review_rounds: 0, review: [] as string[] };
    for (const r of runs) {
      if (r.role === "planner") m.planner_runs++;
      else if (r.role !== "wiki") m.worker_runs++;
      const evs = db.prepare("SELECT type, payload, created_at FROM events WHERE run_id = ? ORDER BY seq").all(r.id) as { type: string; payload: string; created_at: number }[];
      if (evs.length) m.secs += (evs.at(-1)!.created_at - evs[0].created_at) / 1000;
      for (const e of evs) {
        const p = JSON.parse(e.payload);
        if (e.type === "usage") (m.turns++, (m.input += p.input), (m.output += p.output), (m.cache_read += p.cache_read));
        if (e.type === "tool_call") m.tool_calls++;
        if (e.type === "tool_result" && p.is_error) m.tool_errors++;
        if (e.type === "compaction") m.compactions++;
        if (e.type === "model_review") (m.review_rounds++, m.review.push(p.verdict));
      }
    }
    m.secs = Math.round(m.secs);
    return m;
  } finally {
    db.close();
  }
}

// What to grade: a task in review = its latest passed run's branch; an epic = the base branch its children merged into.
function gradeRef(dbPath: string, s: { id: string; kind: string }) {
  if (s.kind === "epic") return "main";
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const r = db.prepare("SELECT branch FROM runs WHERE ticket_id = ? AND status = 'passed' AND branch IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(s.id) as { branch: string } | undefined;
    return r?.branch;
  } finally {
    db.close();
  }
}

async function check(levels: Level[]) {
  let ok = true;
  for (const l of levels) {
    const repo = prepare(l);
    applyKey(l, repo);
    const [base, key] = [await grade(l, repo, "main"), await grade(l, repo, "key")];
    const good = !base.pass && key.pass;
    ok &&= good;
    log(`${good ? "ok  " : "BAD "} ${l.level} base ${base.pass ? "passes" : "fails"}, base + key ${key.pass ? "passes" : "fails"}`);
    if (!key.pass) console.log(key.tail);
    rmSync(repo, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  const { values: o } = parseArgs({
    options: {
      model: { type: "string" },
      levels: { type: "string", default: LEVELS.map((l) => l.level).join(",") },
      runs: { type: "string", default: "1" },
      split: { type: "string", default: "0" },
      wiki: { type: "string", default: "0" },
      "max-turns": { type: "string", default: "120" },
      "max-minutes": { type: "string", default: "60" },
      out: { type: "string", default: "bench/results/results.jsonl" },
      tag: { type: "string" },
      "server-dir": { type: "string", default: resolve(BENCH, "..") },
      ollama: { type: "string", default: "http://localhost:11434" },
      check: { type: "boolean", default: false },
    },
  });
  const levels = o.levels.split(",").map(level);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-bench-")));
  process.env.POLARIS_DATA_DIR = join(home, "data"); // grader containers carry the bench server's data-dir label, not ./data's
  if (o.check) await check(levels);
  if (!o.model) die("--model is required (an Ollama model name)");
  const serverDir = resolve(o["server-dir"]);
  const tag = o.tag ?? sh(serverDir, "git rev-parse --short HEAD");
  const out = resolve(o.out);
  mkdirSync(dirname(out), { recursive: true });
  const { base, child } = await startServer(serverDir, home);
  const stop = (code: number) => (child.kill(), process.exit(code));
  process.on("SIGINT", () => stop(130));
  const dbPath = join(home, "polaris.db");
  log(`bench ${tag}: ${o.model}, ${levels.map((l) => l.level).join(" ")} x${o.runs}, server ${serverDir} at ${base}, temp ${home}`);
  const t00 = Date.now();
  for (const l of levels) {
    for (let run = 1; run <= Number(o.runs); run++) {
      const name = `${l.level}r${run}-${Date.now()}`.toLowerCase(); // ticket key: L1R-1
      const repo = prepare(l, join(home, "repos", name));
      const baseSha = git(repo, "rev-parse", "HEAD");
      const api = client(base);
      await api("POST", "/api/auth/sign-up/email", { email: `${name}@bench.localhost`, password: "password-123", name });
      const ws = (await api("POST", "/api/auth/organization/create", { name, slug: name })).id;
      await api("PUT", "/api/settings", {
        repo_path: repo, base_branch: "main", setup_command: SETUP, test_command: TEST, protected_paths: PROTECTED,
        model_review: true, auto_split: o.split === "1", auto_approve_children: true, wiki: o.wiki === "1",
        max_turns: Number(o["max-turns"]), max_minutes: Number(o["max-minutes"]),
      });
      const prov = await api("POST", "/api/providers", { name: "Ollama", kind: "ollama", base_url: o.ollama });
      await api("PUT", "/api/settings/default-provider", { provider_id: prov.id, model: o.model });
      const t = await api("POST", "/api/tickets", { title: l.title, spec: l.spec });
      await api("POST", `/api/tickets/${t.id}/runs`);
      log(`start ${l.level} run ${run} (${t.key})`);
      const t0 = Date.now();
      let s: Awaited<ReturnType<typeof settled>> | undefined;
      // ponytail: fixed 3h ceiling per level (a split epic at the default budget fits); make it a flag if a level needs more.
      while (Date.now() - t0 < 3 * 3600_000) {
        await sleep(15_000);
        s = await settled(api, t.id).catch((e) => (log(`poll: ${e.message}`), s));
        if (s?.done) break;
      }
      const status = s?.done ? s.status : "timeout";
      const harness_pass = status === "review" || status === "done";
      const ref = harness_pass && s ? gradeRef(dbPath, s) : undefined;
      const g = ref ? await grade(l, repo, ref) : undefined;
      const stat = ref ? git(repo, "diff", "--shortstat", baseSha, ref) : "";
      const diff_lines = ref ? [/(\d+) insertion/, /(\d+) deletion/].reduce((n, re) => n + Number(re.exec(stat)?.[1] ?? 0), 0) : null;
      const row = {
        tag, model: o.model, level: l.level, run, ticket: t.key, pass: !!g?.pass, harness_pass, status, chain: s?.chain ?? [t.key], kind: s?.kind ?? "task", children: s?.children ?? 0,
        wall_secs: Math.round((Date.now() - t0) / 1000), ...metrics(dbPath, ws), diff_lines, key_lines: l.key_lines,
        budget: { max_turns: Number(o["max-turns"]), max_minutes: Number(o["max-minutes"]) }, split: o.split === "1", wiki: o.wiki === "1",
        date: new Date().toISOString(), home, flaky: g?.flaky, grade: g?.tail || undefined,
      };
      appendFileSync(out, JSON.stringify(row) + "\n");
      log(`${row.pass ? "PASS" : "FAIL"} ${l.level} run ${run}: ${status}${g ? ` grader ${g.pass ? "pass" : `fail (exit ${g.code})`}` : ""} ${row.wall_secs}s turns=${row.turns} runs=${row.runs} chain=${row.chain.join(">")}`);
    }
  }
  log(`done in ${Math.round((Date.now() - t00) / 60_000)} min; server data kept in ${home}`);
  console.log(report([out]));
  stop(0);
}
