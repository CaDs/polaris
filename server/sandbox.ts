import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { capture, hostExec, truncate, type Exec } from "./agent/tools.ts";
import { git } from "./git.ts";

// One Docker container per run: the worktree is bind-mounted at /work, protected paths are re-mounted read-only on
// top (not in add-only mode: see tools.ts readOnlyPaths), and every shell command (tool calls, setup, tests) is a `docker exec`. POLARIS_SANDBOX=host runs commands on
// the host instead (unit tests only: no isolation at all).
const execFileP = promisify(execFile);
export const SANDBOX_IMAGE = "polaris-sandbox:1";
// What the built-in image has and lacks (docker/sandbox.Dockerfile), told to workers and planners: both sol attempts on
// POL-29 probed for Docker and ran `npx playwright install`.
export const SANDBOX_TOOLS = "node, npm, git and ripgrep; no Docker, no browser and no Playwright";
export const COMMAND_TIMEOUT = 10 * 60_000; // setup and test commands
// A docker image reference ([host[:port]/]path[:tag][@sha256:digest]), so a setting can't smuggle `docker run` flags.
export const IMAGE_REF = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/;
export const dataDir = () => resolve(process.env.POLARIS_DATA_DIR ?? "data");
const dockerDir = fileURLToPath(new URL("../docker/", import.meta.url));

export type Sandbox = { name: string; exec: Exec; close: () => Promise<void> };

// Commands run as this uid:gid. On Linux the host user's, so files the agent creates in the bind-mounted worktree stay
// theirs (the image is built with the same ids). Docker Desktop (macOS, Windows) maps bind-mount ownership to the host
// user itself: the image's default user.
export const SANDBOX_USER = process.platform === "linux" ? `${process.getuid!()}:${process.getgid!()}` : "1000:1000";
export const IMAGE_VERSION = 2; // bump with docker/sandbox.Dockerfile: an image labelled older (or unlabelled) is rebuilt
const NPM_CACHE = "/home/polaris/.npm";

let building: Promise<unknown> | undefined;
// Builds the default image from docker/sandbox.Dockerfile when it is missing or its polaris.image.version label is older
// than IMAGE_VERSION, then makes the npm cache volume the sandbox user's (one an older image used is root-owned).
// Custom images must exist.
export function ensureImage(image: string) {
  if (image !== SANDBOX_IMAGE) return Promise.resolve();
  const [uid, gid] = SANDBOX_USER.split(":");
  building ??= execFileP("docker", ["image", "inspect", "-f", '{{index .Config.Labels "polaris.image.version"}}', image])
    .then(({ stdout }) => Number(stdout.trim()) >= IMAGE_VERSION || Promise.reject(new Error("outdated")))
    .catch(() =>
      execFileP("docker", ["build", "-q", "-t", image, "--label", `polaris.image.version=${IMAGE_VERSION}`, "--build-arg", `UID=${uid}`,
        "--build-arg", `GID=${gid}`, "-f", join(dockerDir, "sandbox.Dockerfile"), dockerDir], { maxBuffer: 50e6 }))
    .then(() => execFileP("docker", ["run", "--rm", "--user", "root", "-v", `polaris-npm-cache:${NPM_CACHE}`, image, "sh", "-c",
      `[ "$(stat -c %u:%g ${NPM_CACHE})" = ${SANDBOX_USER} ] || chown -R ${SANDBOX_USER} ${NPM_CACHE}`]))
    .catch((e) => {
      building = undefined;
      throw new Error(`building ${image} failed: ${truncate(String(e.stderr || e.message), 2000, "tail")}`);
    });
  return building;
}

// Killing the local `docker exec` client does not stop the command inside the container. So the command runs under
// `setsid` (new process group) and records the group leader's pid; timeout/abort kills that whole group in there.
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

// A project's sandbox size (its sandbox_cpus / sandbox_memory_gb; the DB defaults repeat these).
export type Resources = { cpus: number; memory_gb: number };
export const SANDBOX_RESOURCES: Resources = { cpus: 4, memory_gb: 4 };

// Not root, no capabilities, no privilege gain through setuid binaries, bounded process count. `mounts`: the extra -v flags.
export const dockerRunArgs = (name: string, worktree: string, mounts: string[], image: string, r: Resources) => [
  "run", "-d", "--name", name, "--label", "polaris=1", "--label", `polaris.data=${dataDir()}`,
  "-v", `${worktree}:/work`, ...mounts, "-v", `polaris-npm-cache:${NPM_CACHE}`, "-w", "/work",
  "--user", SANDBOX_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
  "--cpus", String(r.cpus), "--memory", `${r.memory_gb}g`, image, "sleep", "infinity",
];

// readOnly: the paths to mount read-only (tools.ts readOnlyPaths). One missing from the worktree is made an empty directory
// first, so it is read-only too instead of something the agent can create.
export async function openSandbox(runId: string, worktree: string, readOnly: string[], image: string, resources = SANDBOX_RESOURCES): Promise<Sandbox> {
  if (process.env.POLARIS_SANDBOX === "host") return { name: "host", exec: hostExec, close: async () => {} };
  if (!IMAGE_REF.test(image)) throw new Error(`not a docker image reference: ${image}`); // rows saved before the settings check
  await ensureImage(image);
  const name = `polaris-${runId}`;
  // .git too: the host's git must not be pointed elsewhere (git.ts also never reads it for worktrees it created).
  for (const p of readOnly) if (!existsSync(join(worktree, p)) && resolve(worktree, p).startsWith(worktree + "/")) mkdirSync(join(worktree, p), { recursive: true });
  const ro = [...readOnly, ".git"].filter((p) => existsSync(join(worktree, p))).flatMap((p) => ["-v", `${join(worktree, p)}:/work/${p}:ro`]);
  // A worktree's .git file points at the repo's git dir by its host path: mount that read-only at the same path so
  // git status/diff/log work inside (writes such as commit fail; the harness commits on the host).
  const gitDir = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
  if (gitDir) ro.push("-v", `${gitDir}:${gitDir}:ro`);
  await execFileP("docker", dockerRunArgs(name, worktree, ro, image, resources));
  return { name, exec: dockerExec(name), close: () => removeContainer(name) };
}

const removeContainer = (name: string) => execFileP("docker", ["rm", "-f", name]).then(() => {}, () => {});

// Startup: containers left by a dead process of this harness (same data dir). Other instances' containers are untouched.
export async function removeStaleContainers() {
  if (process.env.POLARIS_SANDBOX === "host") return;
  try {
    const { stdout } = await execFileP("docker", ["ps", "-aq", "--filter", "label=polaris=1", "--filter", `label=polaris.data=${dataDir()}`]);
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await execFileP("docker", ["rm", "-f", ...ids]);
  } catch {} // docker not running: nothing to clean
}
