import { execFile } from "node:child_process";
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { foldPath, isProtected, MAX_FILE } from "./agent/tools.ts";
import { dataDir } from "./sandbox.ts";

// All git work happens on the host via the git CLI; the sandbox never sees the repo's .git (see README).
const execFileP = promisify(execFile);
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  // No /etc/gitconfig or system gitattributes (filters, helpers) on the host's git.
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  // Harness commits (passing runs, merges) never depend on the user's git identity.
  GIT_AUTHOR_NAME: "polaris",
  GIT_AUTHOR_EMAIL: "polaris@localhost",
  GIT_COMMITTER_NAME: "polaris",
  GIT_COMMITTER_EMAIL: "polaris@localhost",
};

// Worktree path → its git dir, read right after `worktree add` (before any agent ran). git() passes it explicitly instead of
// discovering it: the worktree's .git file is writable from the sandbox shell, and pointed at a repo the agent wrote, that
// repo's config (core.fsmonitor, aliases, ...) would run commands on the host.
// ponytail: in memory; a restart fails every running run (recoverOrphans), so no worktree outlives it.
const gitDirs = new Map<string, string>();

export async function git(cwd: string, args: string[], extraEnv?: Record<string, string>) {
  const dir = gitDirs.get(cwd);
  try {
    // Hooks and fsmonitor off: a hooksPath inside the work tree (husky etc.) is agent-writable and would run on the host.
    // Submodules ignored: diff/status recurse into a gitlink's repo with *its* config, and a nested repo is agent-made
    // (nestedRepos), so a filter it defines would run here too.
    const { stdout } = await execFileP("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "diff.ignoreSubmodules=all", "-c", "submodule.recurse=false", "-C", cwd, ...(dir ? [`--git-dir=${dir}`, `--work-tree=${cwd}`] : []), ...args], { env: { ...env, ...extraEnv }, maxBuffer: 50e6 });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`git ${args[0]}: ${(err.stderr || err.message).trim()}`);
  }
}

const under = (p: string, root: string) => p === root || p.startsWith(root + sep);
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// What is at a folder, as a state the form can act on (POL-29): not_found, not_a_repo, inside_repo (`root` is the repository's
// root), no_commits, ok, or refused. `error` is the message project create/update fail with. Host git runs in a project's
// repo (worktree add, merge), and repo-local config such as a smudge filter would run there, so before any git command
// (POL-2): not under the data dir (worktrees and wikis are agent-writable), under POLARIS_REPO_ROOTS when the operator set
// it (colon-separated), and owned by the server's user.
// ponytail: repo-local filters and attributes of an allowed repo still run on the host; the allowlist is what keeps members off foreign repos.
export type RepoState = { state: "not_found" | "not_a_repo" | "inside_repo" | "no_commits" | "ok" | "refused"; root?: string; error?: string };
export async function repoState(repoPath: string): Promise<RepoState> {
  if (!isAbsolute(repoPath)) return { state: "not_found", error: "Repository path must be an absolute path" };
  const at = real(repoPath);
  if (under(at, real(dataDir()))) return { state: "refused", error: "Repository path is inside Polaris's data directory" };
  const roots = (process.env.POLARIS_REPO_ROOTS ?? "").split(":").filter(Boolean);
  if (roots.length && !roots.some((r) => under(at, real(r)))) return { state: "refused", error: "Repository path is outside POLARIS_REPO_ROOTS" };
  const owner = existsSync(at) ? statSync(at).uid : undefined;
  if (owner !== undefined && process.getuid && owner !== process.getuid()) return { state: "refused", error: "Repository must be owned by the user Polaris runs as" };
  if (!existsSync(repoPath)) return { state: "not_found", error: `${repoPath} is not a git repository (or does not exist)` };
  const top = await git(repoPath, ["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!top) return { state: "not_a_repo", error: `${repoPath} is not a git repository (or does not exist)` };
  if (realpathSync(top) !== realpathSync(repoPath)) return { state: "inside_repo", root: top, error: `${repoPath} is inside a git repository; use its root ${top}` };
  // Not `rev-list --all`: it also reads every linked worktree's HEAD and fails while a run's `git worktree add` is half done
  // (~13% of checks under concurrent runs), so a run queued then got "no commits yet".
  const commit = (await git(repoPath, ["rev-list", "-n1", "--branches", "--tags", "--remotes"]).catch(() => "")) || (await git(repoPath, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => ""));
  if (!commit) return { state: "no_commits", root: top, error: "Repository has no commits yet" };
  return { state: "ok", root: top };
}

// Settings validation: absolute path to the root of a repo with at least one commit, and an existing base branch
// (default: the branch checked out there).
export async function inspectRepo(repoPath: string, baseBranch: string): Promise<{ error: string } | { repo_path: string; base_branch: string }> {
  const st = await repoState(repoPath);
  if (st.error) return { error: st.error };
  const base = baseBranch || (await git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""));
  if (!base) return { error: "HEAD is detached; set a base branch" };
  if (!(await git(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${base}^{commit}`]).catch(() => ""))) return { error: `Branch "${base}" does not exist` };
  return { repo_path: repoPath, base_branch: base };
}

// The agent's scratch dirs (spilled tool outputs, compaction history, the read-only wiki snapshot and workspace skills) are
// never part of a change. .polaris/skills/ is not listed: repo skills are committed by humans.
const POLARIS_SCRATCH = [".polaris/outputs", ".polaris/history", ".polaris/wiki", ".polaris/workspace-skills"];
export const scratchPathspec = POLARIS_SCRATCH.map((p) => `:(exclude)${p}`);

// Adds them to the repo's shared info/exclude (read by every worktree), so status/add/ls-files skip them.
export async function excludeScratch(repo: string) {
  const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  let cur = "";
  try {
    cur = readFileSync(file, "utf8");
  } catch {}
  const missing = POLARIS_SCRATCH.map((p) => `/${p}/`).filter((l) => !cur.split("\n").includes(l));
  if (!missing.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

// New branch at the base branch's current commit, checked out at `path`. Returns that commit (the run's base_sha).
export async function addWorktree(repo: string, baseBranch: string, path: string, branch: string) {
  const sha = await git(repo, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]);
  await git(repo, ["worktree", "add", "-q", "-b", branch, path, sha]);
  gitDirs.set(path, await git(path, ["rev-parse", "--absolute-git-dir"]));
  await excludeScratch(repo);
  return sha;
}

// A worktree made before a restart (gitDirs is in memory): its git dir found from the repository's side, never from the
// worktree's own .git file, which the agent could have rewritten. Returns false when the repo doesn't list it.
export async function adoptWorktree(repo: string, path: string) {
  const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const admin = join(common, "worktrees");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // git records the resolved path (/private/var on macOS for /var)
    }
  };
  const want = real(join(path, ".git"));
  for (const name of existsSync(admin) ? readdirSync(admin) : []) {
    let points = "";
    try {
      points = readFileSync(join(admin, name, "gitdir"), "utf8").trim();
    } catch {}
    if (points && real(points) === want) {
      gitDirs.set(path, join(admin, name));
      return true;
    }
  }
  return false;
}

// Detached checkout of `sha` at `path`, no branch (eval cases: nothing is committed).
export async function addDetached(repo: string, sha: string, path: string) {
  await git(repo, ["worktree", "add", "-q", "--detach", path, sha]);
  gitDirs.set(path, await git(path, ["rev-parse", "--absolute-git-dir"]));
  await excludeScratch(repo);
}

// A git dir for the sandbox at `dest`: the run's HEAD and index, the repository's branches and (hard-linked) objects, the
// repo's info/exclude, and none of its config (remote URLs and credentials), hooks, stashes or other worktrees' metadata.
// ponytail: one hard link per object file (a copy across filesystems), once per run; alternates would be instant but put the
// repo's path in the container.
export async function sandboxGitDir(worktree: string, dest: string) {
  const admin = gitDirs.get(worktree);
  if (!admin) return false;
  const common = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  mkdirSync(dirname(dest), { recursive: true });
  await execFileP("git", ["clone", "-q", "--local", "--bare", common, dest]);
  writeFileSync(join(dest, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  for (const f of ["HEAD", "index"]) if (existsSync(join(admin, f))) copyFileSync(join(admin, f), join(dest, f));
  if (existsSync(join(common, "info/exclude"))) copyFileSync(join(common, "info/exclude"), join(dest, "info/exclude"));
  return true;
}

// Best effort: a half-created or already-removed worktree/branch is fine. `dataRoot` guards the rm fallback.
export async function removeWorktree(repo: string, path: string | null, branch: string | null, dataRoot: string) {
  if (path) {
    gitDirs.delete(path);
    await git(repo, ["worktree", "remove", "--force", path]).catch(async () => {
      if (path.startsWith(dataRoot)) rmSync(path, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]).catch(() => {});
    });
  }
  if (branch) await git(repo, ["branch", "-D", branch]).catch(() => {});
}

// Every path that differs from base: committed, staged, unstaged, deleted, or untracked (not ignored).
export async function changedPaths(worktree: string, baseSha: string) {
  const tracked = await git(worktree, ["diff", "--name-only", "--no-renames", "-z", baseSha]);
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...tracked.split("\0"), ...untracked.split("\0")].filter((f) => f && !isProtected(f, POLARIS_SCRATCH));
}

// Lines added + removed against base: tracked files by numstat (binary counts 0), new files by their line count.
export async function changedLines(worktree: string, baseSha: string) {
  const sum = (await git(worktree, ["diff", "--numstat", baseSha, "--", ".", ...scratchPathspec])).split("\n").reduce((n, l) => n + (Number(l.split("\t")[0]) || 0) + (Number(l.split("\t")[1]) || 0), 0);
  const fresh = (await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((f) => f && !isProtected(f, POLARIS_SCRATCH));
  const count = (f: string) => {
    try {
      // A FIFO would block the server in open(), a huge sparse file would fill its memory: only small regular files. Checked
      // on the open descriptor (non-blocking, no symlinks), so the agent can't swap the file between the check and the read.
      const fd = openSync(join(worktree, f), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        return st.isFile() && st.size <= MAX_FILE ? readFileSync(fd, "utf8").match(/\n/g)?.length ?? 0 : 0;
      } finally {
        closeSync(fd);
      }
    } catch {
      return 0; // an unreadable file, or a symlink
    }
  };
  return fresh.reduce((n, f) => n + count(f), sum);
}

// The changed paths that break the protection. read_only: anything under a protected path. add_only: a file under one that
// existed at base and was modified, deleted or had its type changed (a rename is a delete plus an add); added and untracked
// files are fine. `fixed` (.polaris/..., see runs.ts) are read-only in both modes.
export async function protectedChanges(worktree: string, baseSha: string, protectedPaths: string[], mode = "read_only", fixed: string[] = []) {
  const all = await changedPaths(worktree, baseSha);
  if (mode !== "add_only") return all.filter((f) => isProtected(f, [...protectedPaths, ...fixed]));
  const status = (await git(worktree, ["diff", "--name-status", "--no-renames", "-z", baseSha])).split("\0");
  const edited = new Set<string>();
  for (let i = 0; i + 1 < status.length; i += 2) if (status[i] !== "A") edited.add(status[i + 1]);
  return all.filter((f) => isProtected(f, fixed) || (edited.has(f) && isProtected(f, protectedPaths)));
}

// Files under the protected paths at `baseSha`, case-folded: what add-only mode keeps agents from changing.
export async function protectedFilesAt(worktree: string, baseSha: string, protectedPaths: string[]) {
  const all = (await git(worktree, ["ls-tree", "-r", "--name-only", "-z", baseSha])).split("\0");
  return new Set(all.filter((f) => f && isProtected(f, protectedPaths)).map(foldPath));
}

// Untracked nested repositories: directories with their own .git (or a .git file), which git lists with a trailing slash.
// `add -A` would record one as a gitlink, and host git then reads that repo's agent-written config (filters, ...).
// The gate fails on them; commitAll refuses them in case one appeared after the gate.
export const nestedRepos = async (worktree: string) =>
  (await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((f) => f.endsWith("/"));

export async function commitAll(worktree: string, message: string) {
  const nested = await nestedRepos(worktree);
  if (nested.length) throw new Error(`refusing to commit nested git repositories: ${nested.join(", ")}`);
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...POLARIS_SCRATCH]); // in case exclude is missing
  await git(worktree, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

// The worktree's content (tracked + untracked, minus scratch) as a tree id, and a reset back to one: the model review
// snapshots before the reviewer runs and undoes anything it wrote, since its changes must never reach the commit.
// Both work on a throwaway copy of the index with everything added, so the real one stays as the worker left it: the
// reviewer's `git diff` shows the change and new files stay untracked.
async function withIndex<T>(worktree: string, fn: (e: { GIT_INDEX_FILE: string }) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "polaris-index-"));
  const e = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    const real = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(real)) copyFileSync(real, e.GIT_INDEX_FILE);
    await git(worktree, ["add", "-A"], e);
    await git(worktree, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...POLARIS_SCRATCH], e);
    return await fn(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export const snapshot = (worktree: string) => withIndex(worktree, (e) => git(worktree, ["write-tree"], e));
export const restore = (worktree: string, tree: string) => withIndex(worktree, (e) => git(worktree, ["read-tree", "--reset", "-u", tree], e));

export class MergeError extends Error {}

// Merges `branch` into `base` with a merge commit. If base is checked out somewhere (normally the user's checkout),
// merge there, but only into a clean tree. Otherwise build the merge commit without any checkout and move the ref.
export async function merge(repo: string, base: string, branch: string, message: string) {
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).split("\n\n").map((b) => b.split("\n"));
  const checkout = worktrees.find((lines) => lines.includes(`branch refs/heads/${base}`))?.[0].slice("worktree ".length);
  if (checkout) {
    if (await git(checkout, ["status", "--porcelain", "--untracked-files=no"]))
      throw new MergeError(`${base} is checked out at ${checkout} with uncommitted changes. Commit or stash them, then approve again.`);
    try {
      await git(checkout, ["merge", "--no-ff", "-q", "-m", message, branch]);
    } catch (e) {
      await git(checkout, ["merge", "--abort"]).catch(() => {});
      throw new MergeError(`Cannot merge ${branch} into ${base}: ${(e as Error).message}`);
    }
    return git(checkout, ["rev-parse", "HEAD"]);
  }
  const old = await git(repo, ["rev-parse", "--verify", `refs/heads/${base}`]);
  const tree = await git(repo, ["merge-tree", "--write-tree", old, branch]).catch(() => {
    throw new MergeError(`${branch} conflicts with ${base}; reject it and run the ticket again.`);
  });
  const sha = await git(repo, ["commit-tree", tree.split("\n")[0], "-p", old, "-p", branch, "-m", message]);
  await git(repo, ["update-ref", `refs/heads/${base}`, sha, old]);
  return sha;
}
