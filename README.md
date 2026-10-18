# agent-harness

Coding-agent harness with a web dashboard. Design: [SPEC.md](SPEC.md). Roadmap: [tasks.md](tasks.md).

```sh
cp .env.example .env   # set BETTER_AUTH_SECRET: openssl rand -hex 32
npm install
npm run dev            # dashboard http://localhost:5173, api :3000
npm test
npm run typecheck
npm run build && npm start   # single process on :3000
npm run agent -- <ticket-id> --root DIR      # ANTHROPIC_API_KEY; or --base-url http://localhost:11434 --model qwen3.8:27b-mlx
npm run agent -- --task "text" --root DIR    # throwaway ticket in workspace "cli"
npm run seed-tasks -- --workspace <slug> [--file tasks.md]  # one ticket per open "- [ ]" item under "## Mn" headings
```

Requires Node ≥ 26, git and Docker. `npm test` needs no Docker except `test/docker.test.ts` (skipped without a daemon);
`npm run e2e` uses the real Docker sandbox.

## Orchestration (M3)

Set the workspace's repository in **Settings** (absolute path to a repo root with at least one commit; base branch
defaults to its checked-out branch). Run agent then:

```
queued ──(slot free: HARNESS_CONCURRENCY, default 2, FIFO)──▶ running
  setup: git worktree + branch harness/<KEY>-<attempt>-<run8> from base → container → setup_command
  agent loop (shell = docker exec; file tools on the host worktree)
  gate: test_command (10 min) + no changes under protected paths
    pass → commit on the branch → run passed, ticket review → Approve (merge, done) | Reject (todo, note → next task)
    fail → run failed; attempt < 3 ? next attempt queued with "Previous attempt failed: …" : ticket failed
cancel (queued or running) → run cancelled, ticket todo, no retry
```

- **Sandbox**: one container per run (`agent-harness-sandbox:1`, built from `docker/sandbox.Dockerfile` on first use),
  worktree at `/work`, protected paths re-mounted read-only, 2 CPUs / 2 GB, shared `agent-harness-npm-cache` volume.
  Removed when the run ends; stale ones (label `agent-harness=1`, same data dir) are removed at startup.
  Commands run under `setsid` with their pid recorded, because killing the local `docker exec` client leaves the command
  running in the container; timeout/cancel kills the whole process group inside the container.
- **Git stays on the host.** A worktree's `.git` is a file pointing into the repo's `.git` on the host, so git does not
  work inside the container; we don't mount the repo's `.git` either (that would let the agent rewrite any branch).
  The harness creates the worktree, checks the diff, commits (author `agent-harness <harness@localhost>`, hooks off)
  and merges. `read_file`/`edit_file`/`search` work on the host worktree path.
- **Worktrees/branches**: a passed run keeps both until the ticket is approved, rejected or deleted; failed and cancelled
  runs are cleaned up when they finish (their output stays in the event log).
- **Approve**: if the base branch is checked out (normally your checkout) and clean, `git merge --no-ff` there; dirty → 409.
  If it isn't checked out anywhere, the merge commit is built with `merge-tree`/`commit-tree` and the branch ref moved,
  without touching any checkout.
- **Protected paths** (`tests/,evals/` by default) are enforced three times: `edit_file` refuses them, the container
  mounts them read-only, and the gate fails the run if the diff touches them.
- The **CLI** (`npm run agent`) still runs the M1 way: directly on the host in `--root`, no queue, sandbox or gate.

## Context management (M5)

Runs are append-only conversations (see [SPEC.md](SPEC.md)). In the worktree the harness keeps `.harness/outputs/`
(full text of long shell/search output) and `.harness/history/` (full transcript of a compacted conversation); both are
git-excluded and never committed. Put skills in your repo as `.harness/skills/<name>.md` with `name` and `description`
frontmatter; agents see the list and read the ones they need. Context windows are set per provider (Settings → Providers),
the compaction cap in Settings → Context. The **Usage** page shows tokens, cost and cache hit rate.
`HARNESS_COMPACT_AT=<tokens>` forces the compaction threshold; `HARNESS_RETRY_BASE_MS` sets the provider retry backoff.

## Self-improvement (M6)

The **Improvement** page has the three loops (details in [SPEC.md](SPEC.md)):

- **Lessons**: after each finished ticket a short no-tools reflection call updates the workspace's lessons (stored in the
  DB with every version). The latest version goes into the first message of every new run. Edit it, diff versions, or
  **Restore** an old one; every change is a new version.
- **Eval cases**: **Add to evals** on a done (approved) ticket. The harness first checks that the test command *fails* at
  the commit that ticket's run started from (clean worktree + sandbox); otherwise the case is rejected.
- **Prompt versions**: v1 is `server/agent/prompts/worker.md`. **New version** or **Propose improvement** (the model
  revises the prompt from the lessons and recent failures) adds an inactive version; **Run eval** replays every case with
  it (same queue and concurrency as normal runs; the source tickets are never touched); **Promote** is enabled only when
  its eval on the current cases beats the active version's (more passed, or the same with ≥ 10% fewer mean tokens).
  Nothing is promoted automatically.

## Project wiki (M10)

Each workspace has a wiki (a git repo under the data dir) that an LLM maintains from approved work and every agent reads first:
the **Wiki** page shows the index (pages whose source files changed since they were verified are flagged), lets you read and edit
pages, and lists the history with diffs. After you **Approve** a ticket a maintainer agent updates the pages the change affects;
its edit only lands if the mechanical lint passes. **Build wiki** writes a first version from the code, **Refresh stale pages**
re-verifies flagged ones, **Lint** checks the structure. Runs see the pages read-only at `.harness/wiki/`. Off per workspace in
Settings. Details: [SPEC.md](SPEC.md#project-wiki-m10).

## Planner (M7)

New ticket → **Epic**, describe the goal, **Run planner**. A planner agent (read-only checkout, no code changes) creates
child tickets; they run like any ticket, each in its own worktree and sandbox, queued as soon as their dependencies are
merged. Each child ends with a `## Handoff` for the planner. Whenever a child settles (approved, failed, rejected), the
planner gets a new round with every child's status and handoff and creates follow-ups or completes the epic, which then
waits for your Approve. The epic page shows the rounds, the children tree with handoffs, the summary and the total tokens.
**Settings → Auto-approve child tickets** merges children that pass the gate without a click (off by default). Rules and
limits: [SPEC.md](SPEC.md#planner-m7).

```
epic: todo ─Run planner─▶ running (round 1 … finish_round) ─▶ waiting for children ─(a child settles)─▶ next round …
      … complete_epic (refused while children are open) ─▶ review ─Approve─▶ done  |  Reject ─▶ todo (note → next round)
      failed: a round failed, 8 rounds used, or a round ended with no complete_epic and nothing open
child: todo (waiting on deps) ─▶ queued ─▶ … review ─Approve (or auto)─▶ done | Reject ─▶ failed | retries used ─▶ failed
```

With `HARNESS_PROVIDER=fake` the demo planner creates "Create a.txt" and "Create b.txt" (after a.txt) and completes the epic
once both are done; the demo worker creates the file its child ticket names. `PARALLEL` in the epic drops the dependency;
`FAIL-GATE` makes b.txt's worker also write under `tests/`, so it fails every attempt and the planner creates a follow-up.

With `HARNESS_PROVIDER=fake` the demo agent creates `ok.txt` on a first attempt only if the system prompt contains
`ALWAYS-CREATE-OK`, and a proposal appends exactly that, so a `test -f ok.txt` eval scores 0/1 for v1 and 1/1 for v2.
