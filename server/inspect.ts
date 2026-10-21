import { git, repoState, type RepoState } from "./git.ts";

// What the project form shows once a folder is set (POL-29): branches, protected-path candidates and command suggestions,
// all read from git objects of the base branch, never from the working tree.
const MAX_PATHS = 200_000; // ponytail: a repo with more files is listed up to this, the rest unseen
const TEST_DIRS = new Set(["test", "tests", "spec", "specs", "__tests__", "e2e", "evals", "eval"]);

// The glob that names a test file by its name, or "" when it is not one.
function testPattern(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = /\.(test|spec)\.([^.]+)$/.exec(name);
  if (m) return `*.${m[1]}.${m[2]}`;
  if (/^test_.*\.py$/.test(name)) return "test_*.py";
  const m2 = /_test\.(py|go)$/.exec(name);
  return m2 ? "*" + m2[0] : "";
}

export type Candidate = { path: string; files: number; pattern: string | null; suggested: boolean };
export function protectedCandidates(paths: string[]): Candidate[] {
  const dirs = new Map<string, { files: number; matches: Map<string, number> }>(); // named dirs at depth <= 2: every file under them
  const parents = new Map<string, Map<string, number>>(); // a test file's own dir at depth <= 2
  const top: Candidate[] = [];
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const f of paths) {
    const parts = f.split("/");
    const pat = testPattern(f);
    if (parts.length === 1 && pat) top.push({ path: f, files: 1, pattern: pat, suggested: false });
    for (let d = 1; d <= 2 && d < parts.length; d++) {
      if (!TEST_DIRS.has(parts[d - 1])) continue;
      const e = dirs.get(parts.slice(0, d).join("/")) ?? { files: 0, matches: new Map() };
      e.files++;
      if (pat) add(e.matches, pat);
      dirs.set(parts.slice(0, d).join("/"), e);
    }
    if (pat && parts.length >= 2 && parts.length <= 3) {
      const dir = parts.slice(0, -1).join("/");
      if (!parents.has(dir)) parents.set(dir, new Map());
      add(parents.get(dir)!, pat);
    }
  }
  const dominant = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const out: Candidate[] = [...dirs].map(([p, e]) => ({ path: p + "/", files: e.files, pattern: dominant(e.matches), suggested: true }));
  for (const [p, m] of parents) {
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    if (n >= 3 && !out.some((c) => p === c.path.slice(0, -1) || p.startsWith(c.path))) out.push({ path: p + "/", files: n, pattern: dominant(m), suggested: true });
  }
  return [...out.sort((a, b) => a.path.localeCompare(b.path)), ...top];
}

// Lockfile → [setup, test]; first match wins. The JS managers' test needs scripts.test in package.json.
const COMMANDS: [string[], string, string, boolean][] = [
  [["package-lock.json"], "npm ci", "npm test", true],
  [["pnpm-lock.yaml"], "pnpm install --frozen-lockfile", "pnpm test", true],
  [["yarn.lock"], "yarn install --frozen-lockfile", "yarn test", true],
  [["bun.lock", "bun.lockb"], "bun install --frozen-lockfile", "bun test", false],
  [["uv.lock"], "uv sync --frozen", "uv run pytest", false],
  [["requirements.txt"], "pip install -r requirements.txt", "pytest", false],
  [["go.mod"], "go mod download", "go test ./...", false],
  [["Cargo.toml"], "cargo fetch", "cargo test", false],
];
type Suggestion = { value: string; why: string } | null;
async function commands(root: string, base: string, top: Set<string>): Promise<{ setup: Suggestion; test: Suggestion }> {
  const hit = COMMANDS.find(([files]) => files.some((f) => top.has(f)));
  if (!hit) return { setup: null, test: null };
  const [files, setup, test, needsScript] = hit;
  const file = files.find((f) => top.has(f))!;
  let hasScript = !needsScript;
  if (needsScript && top.has("package.json")) {
    try {
      const t = JSON.parse(await git(root, ["cat-file", "blob", `refs/heads/${base}:package.json`])).scripts?.test;
      hasScript = typeof t === "string" && !/no test specified/.test(t);
    } catch {}
  }
  return { setup: { value: setup, why: file }, test: hasScript ? { value: test, why: needsScript ? "package.json scripts.test" : file } : null };
}

export async function inspectProject(repoPath: string, baseBranch: string) {
  const st: RepoState = await repoState(repoPath);
  if (st.state !== "ok") return st;
  const root = st.root!;
  const current = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")) || null;
  const rows = (await git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", "--format=%(refname:lstrip=2)%00%(committerdate:unix)%00%(subject)"]))
    .split("\n").filter(Boolean).map((l) => l.split("\0"));
  const branches = rows.filter(([n]) => !n.startsWith("polaris/")).map(([name, at, subject]) => ({ name, current: name === current, committed_at: Number(at) * 1000, subject }));
  const base = baseBranch || current || branches[0]?.name || "";
  const exists = rows.some(([n]) => n === base);
  const paths = exists ? (await git(root, ["ls-tree", "-r", "--name-only", "-z", `refs/heads/${base}`])).split("\0").slice(0, MAX_PATHS) : [];
  const { setup, test } = await commands(root, base, new Set(paths.filter((p) => !p.includes("/"))));
  return { state: "ok" as const, repo_path: repoPath, root, current, branches, base_branch: base, base_exists: exists, protected: protectedCandidates(paths), setup_command: setup, test_command: test };
}
