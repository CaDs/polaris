import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { capture, hostExec, truncate, type Exec } from "./agent/tools.ts";
import { AgentError } from "./agent/types.ts";
import { git, sandboxGitDir } from "./git.ts";

// One Docker container per run: the worktree is bind-mounted at /work, protected paths are re-mounted read-only on
// top (not in add-only mode: see tools.ts readOnlyPaths), and every shell command (tool calls, setup, tests) is a `docker exec`. POLARIS_SANDBOX=host runs commands on
// the host instead (unit tests only: no isolation at all).
const execFileP = promisify(execFile);
export const SANDBOX_IMAGE = "polaris-sandbox:1"; // the tag stays; IMAGE_VERSION below is what triggers a rebuild
// What the built-in image has and lacks (docker/sandbox.Dockerfile), told to workers and planners: both sol attempts on
// POL-29 probed for Docker and ran `npx playwright install`.
export const SANDBOX_TOOLS = "node, npm, git and ripgrep; no Docker, no browser and no Playwright";
export const COMMAND_TIMEOUT = 10 * 60_000; // setup and test commands
// A docker image reference ([host[:port]/]path[:tag][@sha256:digest]), so a setting can't smuggle `docker run` flags.
export const IMAGE_REF = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/;
export const dataDir = () => resolve(process.env.POLARIS_DATA_DIR ?? "data");
const dockerDir = fileURLToPath(new URL("../docker/", import.meta.url));

// endSetup: called once the setup command is done; with network "setup-only" it takes the container off the network.
export type Sandbox = { name: string; exec: Exec; endSetup: () => Promise<void>; close: () => Promise<void> };

// Commands run as this uid:gid. On Linux the host user's, so files the agent creates in the bind-mounted worktree stay
// theirs (the image is built with the same ids). Docker Desktop (macOS, Windows) maps bind-mount ownership to the host
// user itself: the image's default user.
export const SANDBOX_USER = process.platform === "linux" ? `${process.getuid!()}:${process.getgid!()}` : "1000:1000";
export const IMAGE_VERSION = 3; // bump with docker/sandbox.Dockerfile: an image labelled older (or unlabelled) is rebuilt
const NPM_CACHE = "/home/polaris/.npm";

let building: Promise<unknown> | undefined;
// Builds the default image from docker/sandbox.Dockerfile when it is missing or its polaris.image.version label is older
// than IMAGE_VERSION. Custom images must exist.
export function ensureImage(image: string) {
  if (image !== SANDBOX_IMAGE) return Promise.resolve();
  const [uid, gid] = SANDBOX_USER.split(":");
  building ??= execFileP("docker", ["image", "inspect", "-f", '{{index .Config.Labels "polaris.image.version"}}', image])
    .then(({ stdout }) => Number(stdout.trim()) >= IMAGE_VERSION || Promise.reject(new Error("outdated")))
    .catch(() =>
      execFileP("docker", ["build", "-q", "-t", image, "--label", `polaris.image.version=${IMAGE_VERSION}`, "--build-arg", `UID=${uid}`,
        "--build-arg", `GID=${gid}`, "-f", join(dockerDir, "sandbox.Dockerfile"), dockerDir], { maxBuffer: 50e6 }))
    .catch((e) => {
      building = undefined;
      throw new Error(`building ${image} failed: ${truncate(String(e.stderr || e.message), 2000, "tail")}`);
    });
  return building;
}

// Killing the local `docker exec` client does not stop the command inside the container. So the command runs under
// `setsid` (new process group) and records the group leader's pid; timeout/abort kills that whole group in there.
// ponytail: the pid file is agent-writable, so a hostile agent can dodge the kill (the run's deadline and close() still end
// it); a pid read from outside (`docker top`) would not trust the container.
function dockerExec(name: string): Exec {
  return (command, { timeoutMs, signal }) => {
    const pidFile = `/tmp/.polaris-exec-${randomUUID()}`;
    const wrapped = `echo $$ > ${pidFile}; exec sh -c "$1"`;
    const child = spawn("docker", ["exec", "-w", "/work", name, "setsid", "-w", "sh", "-c", wrapped, "sh", command], { stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      // An immediate abort can beat the pid file: wait for it up to 5s.
      const script = `for i in $(seq 50); do [ -s ${pidFile} ] && break; sleep 0.1; done; kill -KILL -$(cat ${pidFile})`;
      execFile("docker", ["exec", name, "sh", "-c", script], () => child.kill("SIGKILL"));
    };
    return capture(child, kill, { timeoutMs, signal });
  };
}

// A project's sandbox size and network (its sandbox_cpus / sandbox_memory_gb / sandbox_network; the DB defaults repeat these).
// network: "none" never has one (setup needs a warm cache), "setup-only" has it until endSetup() (after the setup command,
// before any agent turn or test run), "full" keeps it.
export const NETWORKS = ["none", "setup-only", "full"];
export type Resources = { cpus: number; memory_gb: number; network?: string };
export const SANDBOX_RESOURCES = { cpus: 4, memory_gb: 4, network: "setup-only" };
// Refuse to grow past this (host `du` of the worktree): a loop writing zeros would otherwise fill the host's disk.
const worktreeMaxMb = () => Number(process.env.POLARIS_WORKTREE_MAX_MB) || 5120;

// Not root, no capabilities, no privilege gain through setuid binaries, bounded process count, no swap, a read-only root
// (tmpfs for /tmp and HOME; the project's npm cache volume is HOME/.npm), PID 1 that reaps orphans. `mounts`: extra -v flags.
export const dockerRunArgs = (name: string, worktree: string, mounts: string[], image: string, r: Resources, repo = "") => [
  "run", "-d", "--init", "--name", name, "--label", "polaris=1", "--label", `polaris.data=${dataDir()}`,
  "-v", `${worktree}:/work`, ...mounts, "-v", `${cacheVolume(repo)}:${NPM_CACHE}`, "-w", "/work",
  "--user", SANDBOX_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
  "--cpus", String(r.cpus), "--memory", `${r.memory_gb}g`, "--memory-swap", `${r.memory_gb}g`, "--ulimit", "nofile=65536:65536",
  "--read-only", "--tmpfs", "/tmp:size=512m,mode=1777", "--tmpfs", `/home/polaris:size=512m,uid=${SANDBOX_USER.split(":")[0]},gid=${SANDBOX_USER.split(":")[1]}`,
  "-e", "HOME=/home/polaris", ...(r.network === "none" ? ["--network", "none"] : []), image, "sleep", "infinity",
];

// One npm cache per repository: a cache an agent poisoned reaches only later runs of the same repository. A new volume
// starts as the image's (sandbox-user-owned) /home/polaris/.npm.
const cacheVolume = (repo: string) => `polaris-npm-cache-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;

// readOnly: the paths to mount read-only (tools.ts readOnlyPaths). One missing from the worktree is made an empty directory
// first, so it is read-only too instead of something the agent can create.
export async function openSandbox(runId: string, worktree: string, readOnly: string[], image: string, resources: Resources = SANDBOX_RESOURCES, repo = ""): Promise<Sandbox> {
  if (process.env.POLARIS_SANDBOX === "host") return { name: "host", exec: hostExec, endSetup: async () => {}, close: async () => {} };
  if (!IMAGE_REF.test(image)) throw new Error(`not a docker image reference: ${image}`); // rows saved before the settings check
  if (SANDBOX_USER.startsWith("0:") && !process.env.POLARIS_ALLOW_ROOT_SANDBOX) throw new Error("refusing to run sandboxes as root (uid 0 owns the worktree files); run Polaris as a normal user, or set POLARIS_ALLOW_ROOT_SANDBOX=1");
  await ensureImage(image);
  const name = `polaris-${runId}`;
  for (const p of readOnly) if (!existsSync(join(worktree, p)) && resolve(worktree, p).startsWith(worktree + "/")) mkdirSync(join(worktree, p), { recursive: true });
  const ro = readOnly.filter((p) => existsSync(join(worktree, p))).flatMap((p) => ["-v", `${join(worktree, p)}:/work/${p}:ro`]);
  // Git inside: a throwaway git dir at /git (this run's HEAD and index, the repo's objects and branches, no config, remotes
  // or credentials) behind a .git file over the worktree's, both read-only: git status/diff/log work, a commit fails (the
  // harness commits on the host). Neither the repo's real git dir nor its host path is visible.
  const gitRoot = join(dataDir(), "gitdirs", name);
  if (await sandboxGitDir(worktree, join(gitRoot, "git")).catch(() => false)) {
    writeFileSync(join(gitRoot, "dotgit"), "gitdir: /git\n");
    ro.push("-v", `${join(gitRoot, "git")}:/git:ro`, "-v", `${join(gitRoot, "dotgit")}:/work/.git:ro`);
  } else if (existsSync(join(worktree, ".git"))) ro.push("-v", `${join(worktree, ".git")}:/work/.git:ro`);
  try {
    await execFileP("docker", dockerRunArgs(name, worktree, ro, image, resources, repo));
  } catch (e) {
    rmSync(gitRoot, { recursive: true, force: true });
    throw e;
  }
  let killed = "";
  const watchdog = setInterval(async () => {
    const mb = await execFileP("du", ["-sk", worktree]).then(({ stdout }) => Number(stdout.split("\t")[0]) / 1024, () => 0);
    if (mb > worktreeMaxMb() && !killed) {
      killed = `the sandbox was stopped: its worktree grew past ${worktreeMaxMb()} MB (${Math.round(mb)} MB)`;
      removeContainer(name);
    }
  }, 5000).unref();
  const run = dockerExec(name);
  return {
    name,
    exec: async (command, o) => {
      if (killed) throw new AgentError("UnexpectedEnvironment", killed);
      const r = await run(command, o);
      if (killed) throw new AgentError("UnexpectedEnvironment", killed); // it died with the container
      return r;
    },
    endSetup: async () => {
      if (resources.network === "setup-only") await execFileP("docker", ["network", "disconnect", "bridge", name]);
    },
    close: async () => {
      clearInterval(watchdog);
      await removeContainer(name);
      rmSync(gitRoot, { recursive: true, force: true });
    },
  };
}

const removeContainer = (name: string) => execFileP("docker", ["rm", "-f", name]).then(() => {}, () => {});

// Startup: containers left by a dead process of this harness (same data dir). Other instances' containers are untouched.
export async function removeStaleContainers() {
  if (process.env.POLARIS_SANDBOX === "host") return;
  try {
    const { stdout } = await execFileP("docker", ["ps", "-aq", "--filter", "label=polaris=1", "--filter", `label=polaris.data=${dataDir()}`]);
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await execFileP("docker", ["rm", "-f", ...ids]);
    rmSync(join(dataDir(), "gitdirs"), { recursive: true, force: true });
  } catch {} // docker not running: nothing to clean
}
