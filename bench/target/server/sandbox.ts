import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { capture, hostExec, type Exec } from "./agent/tools.ts";

// One Docker container per run: the worktree is bind-mounted at /work, protected paths are re-mounted read-only on
// top, and every shell command (tool calls, setup, tests) is a `docker exec`. HARNESS_SANDBOX=host runs commands on
// the host instead (unit tests only: no isolation at all).
const execFileP = promisify(execFile);
export const SANDBOX_IMAGE = "agent-harness-sandbox:1";
export const dataDir = () => resolve(process.env.HARNESS_DATA_DIR ?? "data");
const dockerDir = fileURLToPath(new URL("../docker/", import.meta.url));

export type Sandbox = { name: string; exec: Exec; close: () => Promise<void> };

let building: Promise<unknown> | undefined;
// Builds the default image from docker/sandbox.Dockerfile the first time it is missing. Custom images must exist.
export function ensureImage(image: string) {
  if (image !== SANDBOX_IMAGE) return Promise.resolve();
  building ??= execFileP("docker", ["image", "inspect", image]).catch(() =>
    execFileP("docker", ["build", "-q", "-t", image, "-f", join(dockerDir, "sandbox.Dockerfile"), dockerDir], { maxBuffer: 50e6 }).catch((e) => {
      building = undefined;
      throw new Error(`building ${image} failed: ${String(e.stderr || e.message).slice(-2000)}`);
    }),
  );
  return building;
}

// Killing the local `docker exec` client does not stop the command inside the container. So the command runs under
// `setsid` (new process group) and records the group leader's pid; timeout/abort kills that whole group in there.
export function dockerExec(name: string): Exec {
  return (command, { timeoutMs, signal }) => {
    const pidFile = `/tmp/.harness-exec-${randomUUID()}`;
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

export async function openSandbox(runId: string, worktree: string, protectedPaths: string[], image: string): Promise<Sandbox> {
  if (process.env.HARNESS_SANDBOX === "host") return { name: "host", exec: hostExec, close: async () => {} };
  await ensureImage(image);
  const name = `harness-${runId}`;
  const ro = protectedPaths.filter((p) => existsSync(join(worktree, p))).flatMap((p) => ["-v", `${join(worktree, p)}:/work/${p}:ro`]);
  // ponytail: runs as root; on Linux hosts files it creates in the worktree are root-owned. Add --user when that bites.
  await execFileP("docker", [
    "run", "-d", "--name", name, "--label", "agent-harness=1", "--label", `agent-harness.data=${dataDir()}`,
    "-v", `${worktree}:/work`, ...ro, "-v", "agent-harness-npm-cache:/root/.npm",
    "-w", "/work", "--cpus", "2", "--memory", "2g", image, "sleep", "infinity",
  ]);
  return { name, exec: dockerExec(name), close: () => removeContainer(name) };
}

export const removeContainer = (name: string) => execFileP("docker", ["rm", "-f", name]).then(() => {}, () => {});

// Startup: containers left by a dead process of this harness (same data dir). Other instances' containers are untouched.
export async function removeStaleContainers() {
  if (process.env.HARNESS_SANDBOX === "host") return;
  try {
    const { stdout } = await execFileP("docker", ["ps", "-aq", "--filter", "label=agent-harness=1", "--filter", `label=agent-harness.data=${dataDir()}`]);
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await execFileP("docker", ["rm", "-f", ...ids]);
  } catch {} // docker not running: nothing to clean
}
