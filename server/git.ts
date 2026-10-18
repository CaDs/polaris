import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isProtected } from "./agent/tools.ts";

// All git work happens on the host via the git CLI; the sandbox never sees the repo's .git (see README).
const execFileP = promisify(execFile);
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  // Harness commits (passing runs, merges) never depend on the user's git identity.
  GIT_AUTHOR_NAME: "polaris",
  GIT_AUTHOR_EMAIL: "polaris@localhost",
  GIT_COMMITTER_NAME: "polaris",
  GIT_COMMITTER_EMAIL: "polaris@localhost",
};

export async function git(cwd: string, args: string[]) {
  try {
    // Hooks off: a hooksPath inside the work tree (husky etc.) is agent-writable and would run on the host.
    const { stdout } = await execFileP("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env, maxBuffer: 50e6 });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`git ${args[0]}: ${(err.stderr || err.message).trim()}`);
  }
}

// Settings validation: absolute path to the root of a repo with at least one commit, and an existing base branch
// (default: the branch checked out there).
export async function inspectRepo(repoPath: string, baseBranch: string): Promise<{ error: string } | { repo_path: string; base_branch: string }> {
  if (!isAbsolute(repoPath)) return { error: "Repository path must be an absolute path" };
  const top = await git(repoPath, ["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!top) return { error: `${repoPath} is not a git repository (or does not exist)` };
  if (realpathSync(top) !== realpathSync(repoPath)) return { error: `${repoPath} is inside a git repository; use its root ${top}` };
  // Not `rev-list --all`: it also reads every linked worktree's HEAD and fails while a run's `git worktree add` is half done
  // (~13% of checks under concurrent runs), so a run queued then got "no commits yet".
  const commit = (await git(repoPath, ["rev-list", "-n1", "--branches", "--tags", "--remotes"]).catch(() => "")) || (await git(repoPath, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => ""));
  if (!commit) return { error: "Repository has no commits yet" };
  const base = baseBranch || (await git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""));
  if (!base) return { error: "HEAD is detached; set a base branch" };
  if (!(await git(repoPath, ["rev-parse", "--verify", "-q", `refs/heads/${base}^{commit}`]).catch(() => ""))) return { error: `Branch "${base}" does not exist` };
  return { repo_path: repoPath, base_branch: base };
}

// The agent's scratch dirs (spilled tool outputs, compaction history, the read-only wiki snapshot) are never part of a
// change. .polaris/skills/ is not listed: skills are committed by humans.
export const POLARIS_SCRATCH = [".polaris/outputs", ".polaris/history", ".polaris/wiki"];
export const scratchPathspec = POLARIS_SCRATCH.map((p) => `:(exclude)${p}`);

// Adds them to the repo's shared info/exclude (read by every worktree), so status/add/ls-files skip them.
export async function excludeScratch(repo: string) {
  const file = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = POLARIS_SCRATCH.map((p) => `/${p}/`).filter((l) => !cur.split("\n").includes(l));
  if (!missing.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

// New branch at the base branch's current commit, checked out at `path`. Returns that commit (the run's base_sha).
export async function addWorktree(repo: string, baseBranch: string, path: string, branch: string) {
  const sha = await git(repo, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]);
  await git(repo, ["worktree", "add", "-q", "-b", branch, path, sha]);
  await excludeScratch(repo);
  return sha;
}

// Detached checkout of `sha` at `path`, no branch (eval cases: nothing is committed).
export async function addDetached(repo: string, sha: string, path: string) {
  await git(repo, ["worktree", "add", "-q", "--detach", path, sha]);
  await excludeScratch(repo);
}

// Best effort: a half-created or already-removed worktree/branch is fine. `dataRoot` guards the rm fallback.
export async function removeWorktree(repo: string, path: string | null, branch: string | null, dataRoot: string) {
  if (path)
    await git(repo, ["worktree", "remove", "--force", path]).catch(async () => {
      if (path.startsWith(dataRoot)) rmSync(path, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]).catch(() => {});
    });
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
      return readFileSync(join(worktree, f), "utf8").match(/\n/g)?.length ?? 0;
    } catch {
      return 0; // a symlink to a directory, an unreadable file
    }
  };
  return fresh.reduce((n, f) => n + count(f), sum);
}

export const protectedChanges = async (worktree: string, baseSha: string, protectedPaths: string[]) =>
  (await changedPaths(worktree, baseSha)).filter((f) => isProtected(f, protectedPaths));

export async function commitAll(worktree: string, message: string) {
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...POLARIS_SCRATCH]); // in case exclude is missing
  await git(worktree, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

// The worktree's content (tracked + untracked, minus scratch) as a tree id, and a reset back to one: the model review
// snapshots before the reviewer runs and undoes anything it wrote, since its changes must never reach the commit.
export async function snapshot(worktree: string) {
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...POLARIS_SCRATCH]);
  return git(worktree, ["write-tree"]);
}
export const restore = (worktree: string, tree: string) => git(worktree, ["read-tree", "--reset", "-u", tree]);

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
