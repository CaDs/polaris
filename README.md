# Polaris

Polaris is a self-hosted coding-agent harness with a web dashboard. You file tickets; AI agents work them in isolated
sandboxes; tests and a model reviewer check every change before you see it; you approve and it merges. It runs on
hosted models (Anthropic, OpenAI) or entirely on your own machine with local models through Ollama.

Design and rules: [SPEC.md](SPEC.md) · Milestone checklist: [tasks.md](tasks.md)

## Why

Most agent demos work on toy tasks and fall apart on real ones. Polaris is built around the opposite goal: an agent loop
that does real, reviewable work on a real codebase, and gets better at it over time.

- **Tickets in, reviewed commits out.** Every change happens on its own branch in its own container, must pass your test
  command, is reviewed by a model, and waits for your approval before it touches your branch.
- **Local models are first class.** Everything works with a 27–35B model on a laptop or workstation. The harness is
  designed around their limits: small context windows, small steps, imperfect tool calls.
- **Complex work gets split.** A ticket that is too big for one agent becomes an epic: a planner breaks it into tickets the
  agents can finish, with their own acceptance checks.
- **It learns.** Each project keeps a wiki and lessons written from the agents' own approved work, and prompt changes are
  promoted only when they beat the current prompt on an eval set built from past tickets.
- **Measured, not assumed.** Changes to the harness are validated on a complexity ladder of real tickets on its own
  codebase (see [What we learned](#what-we-learned)).

## How it works

```
ticket ──▶ (optional triage) ──▶ run: git worktree + branch polaris/<KEY>-… ──▶ Docker sandbox (/work)
   │                                        │
   │                              agent loop: read_file · edit_file · search · shell
   │                                        │
   │                              test gate (your test command + protected paths)
   │                                 fail → re-run once (flaky?) → fix round in the same conversation → fresh retry
   │                                        │
   │                              model review (same model, read-only) → findings → fix round → review again
   │                                        │
   └── too big / failed all attempts ──▶ "Split:" epic ──▶ planner creates child tickets ──▶ each runs the same way
                                            │
                              human review: Approve (merge) or Reject (note → next attempt)
                                            │
                              wiki ingest + lessons ──▶ every later run starts with this memory
```

Every step is an event in an append-only log, streamed live to the dashboard: you can watch each tool call, see tokens and
cost per run, and replay any transcript.

## What's done

| Area | What you get |
|---|---|
| **Dashboard** | Linear-style UI with dark and light themes: board and list layouts, live transcripts, runs table with tokens, cache hit rate, cost and time per run, Usage page. |
| **Accounts** | Email/password sign-in; the first account is the owner and sign-up then closes. Everything is scoped per workspace (one repository each). The UI creates one workspace per account; inviting members and switching workspaces have no UI yet. |
| **Providers** | Anthropic API, OpenAI API (and experimental ChatGPT sign-in), local Ollama. Keys encrypted at rest. A per-provider model picker and a "Test" button that checks tool calling. Ollama's real context window is detected automatically. |
| **Agent loop** | Tools `read_file`, `edit_file` (or `apply_patch` for OpenAI models), `search`, `shell`. Append-only conversations (prompt caching friendly), provider retries, long output spilled to files. The first message states the environment: test command, read-only paths, budget, git read-only. |
| **Isolation** | One git worktree and branch per run, one Docker container per run, protected paths (your tests) mounted read-only and enforced three ways, the repo's `.git` mounted read-only so agents can `git diff` but not commit or rewrite history. |
| **Test gate** | Your test command must pass. A failure is re-run once (flaky tests don't fail good work), then fed back into the same conversation for a fix, then retried fresh (up to 3 attempts). |
| **Model review** | After the tests pass, the same model reviews the change with read-only tools and returns findings, which go back to the worker to fix (up to 3 reviews, so 2 fix rounds, per attempt). Any file the reviewer writes is undone. Its budget scales with the size of the diff. |
| **Budgets** | Max turns per agent session (default 120; each fix round gets as many again) and max minutes per attempt (default 60, fix rounds included), with a "wrap up" note near either limit. |
| **Context management** | Compaction into a structured summary plus the current `git diff`, re-reads of unchanged files skipped, per-model compaction thresholds, skills in `.polaris/skills/`. |
| **Planner and splitting** | Epics are planned by a planner agent into child tickets with dependencies, handoffs and their own test commands. A ticket that fails all attempts is turned into a `Split:` epic automatically. An epic only completes when the full test suite passes on the merged result. Optional size triage with a decision model. |
| **Memory** | A per-project LLM-maintained wiki (a git repo with index, pages, log; stale pages flagged against the code; written only from approved work) and versioned lessons from a reflection after every run. |
| **Self-improvement** | Eval cases from approved tickets (must fail at their base commit), prompt versions proposed by the model, eval-gated promotion with a human click (evals on the same model). A new built-in worker prompt replaces an unmodified built-in; an edited prompt is kept and the new one waits as a candidate. |
| **Tracker** | Labels, priority (the run queue starts urgent tickets first), assignee, estimate, due date, projects with milestones, cycles (sprints), filters as shareable URLs, full-text search, saved views, command palette (Cmd/Ctrl+K), keyboard shortcuts. |

## Getting started

### Requirements

- macOS or Linux
- **Node.js 26 or newer** (Polaris runs TypeScript directly with Node's type stripping)
- **git**
- **Docker** (Docker Desktop on macOS), running. The sandbox image builds automatically on the first run.
- A model: an **Anthropic** or **OpenAI** API key, or **[Ollama](https://ollama.com)** with a tool-capable model
  (tested with `qwen3.8:27b-mlx`)

### Install and run

```sh
git clone https://github.com/CaDs/polaris.git
cd polaris
npm ci
cp .env.example .env
```

Fill in `.env`:

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32)   # signs sessions
POLARIS_SECRET_KEY=$(openssl rand -hex 32)   # encrypts provider keys at rest; keep it, or stored keys become unreadable
```

Start it:

```sh
npm run dev       # dashboard on http://localhost:5173 (API on :3000)
```

Or as a single process: `npm run build && npm start` (everything on http://localhost:3000; set `BETTER_AUTH_URL` and
`WEB_ORIGIN` to that address).

### First ticket

1. Open the dashboard, create an account (the first one; sign-up then closes) and a workspace.
2. **Settings → Repository**: the absolute path of a git repository with at least one commit, the base branch, a setup
   command (e.g. `npm ci`) and a test command (e.g. `npm test`). Protected paths default to `tests/,evals/`.
3. **Settings → Providers**: add Ollama (`http://localhost:11434`), Anthropic or OpenAI, click **Test**, then pick the
   workspace's default provider and model.
4. **New ticket**, describe the change, **Run agent**. Watch the transcript, then **Approve** to merge into your base
   branch or **Reject** with a note for the next attempt.

For bigger work, choose **Epic** when creating the ticket and click **Run planner**.

## Configuration

### Environment (`.env`)

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | Session signing secret (required, 32+ characters) |
| `BETTER_AUTH_URL` | Public URL of the API (default `http://localhost:3000`) |
| `WEB_ORIGIN` | Origin of the dashboard (default `http://localhost:5173` in dev) |
| `POLARIS_SECRET_KEY` | 64 hex characters; encrypts provider API keys and OAuth tokens at rest |
| `PORT` | API port (default 3000) |
| `HOST` | Interface the API listens on (default `127.0.0.1`; `0.0.0.0` exposes it to your network) |
| `POLARIS_OPEN_SIGNUP=1` | Allow sign-ups after the first account (by default the first account is the owner and sign-up then closes) |
| `DB_PATH` | SQLite database file (default `polaris.db`) |
| `POLARIS_DATA_DIR` | Worktrees, wikis and run data (default `./data`) |
| `POLARIS_CONCURRENCY` | Runs at the same time (default 2; use 1 with a single local model) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Fallback provider when a workspace has none configured (the base URL can point at Ollama) |
| `POLARIS_MODEL` | Model of the fallback provider and the CLI (default `claude-sonnet-5-5`) |
| `OPENAI_BASE_URL` | Base URL for OpenAI providers saved without one (default `https://api.openai.com`) |
| `POLARIS_OAUTH_PORT` | Local callback port of the ChatGPT sign-in (default 1455) |
| `POLARIS_PROVIDER=fake` | Scripted demo provider used by the tests |

Tests only: `POLARIS_SANDBOX=host` (commands on the host, no isolation), `POLARIS_COMPACT_AT`, `POLARIS_RETRY_BASE_MS`,
`POLARIS_OPENAI_AUTH_URL`, `POLARIS_CHATGPT_BASE_URL`; for `npm run e2e`: `E2E_PORT`, `HEADED`, `REAL_MODEL`.

### Workspace settings (Settings page)

Repository and commands, protected paths, sandbox image, compaction cap, model review (on), automatic splitting (on),
child size hint for the planner, triage model (off), auto-approve child tickets (off), project wiki (on),
max turns per agent session and max minutes per attempt, labels. Saving merges: a field left out keeps its value, `null`
resets it to the default.

### In your repository

- `.polaris/skills/<name>.md` with `name` and `description` frontmatter: agents see the list and read the skills they need.
- Polaris also creates `.polaris/outputs/`, `.polaris/history/` and `.polaris/wiki/` inside its worktrees. They are
  git-excluded and never committed.

## Testing

```sh
npm test                    # unit and integration tests (in-memory DB, host sandbox; the Docker test skips without a daemon)
npm run typecheck
npx playwright install chromium   # once
npm run e2e                 # end-to-end tests in a headless browser, real Docker sandbox, scripted model
npm run e2e:headed          # the same, in a visible browser
REAL_MODEL=qwen3.8:27b-mlx npm run e2e   # against your local Ollama model instead
E2E_PORT=3201 npm run e2e   # if port 3200 is taken
```

## Command line

```sh
npm run agent -- --task "text" --root DIR             # one-off agent run directly on DIR (no sandbox or gate)
npm run agent -- <ticket-id> --root DIR               # run an existing ticket the same way
npm run seed-tasks -- --workspace <slug> [--file tasks.md]   # one ticket per open "- [ ]" item under "## Mn" headings
```

## What we learned

Polaris was developed by running it on its own code. A seven-level ladder of real tickets on its codebase, from a 6-line
filter to a 305-line feature over 11 files, each with locked tests and a hidden answer key, measured two local models on
an Apple M4 Max:

- **Qwen 3.8 27B passes all 7 levels** once the budget fits the work (120 turns or 60 minutes). With a fixed 50-turn
  budget it failed L5 and L7, which is why budgets are now time and turn based.
- **Ornith 1.5 35B passes L1–L3** but not L4–L6 even with 120 turns: a real limit for that model, and the case automatic
  splitting is for.
- **Project memory made Qwen 28% faster** (97 → 70 minutes on the levels it passed both ways) but did not change which
  levels pass. Memory only grows from approved work, so a model that fails a lot learns little.
- **Every failure in the memory experiment (13 of 13) was the turn budget running out**, never a failing test or a crash.
- Running the harness on itself found many of its own bugs: a line-number gutter that broke local models' edits, a wrong
  context window that caused endless compaction, flaky gates, a git race between concurrent runs. All are fixed.
- **We optimized for benchmarks before quality.** Pass rates went up while a full code review afterwards found two
  sandbox escapes (an agent could rewrite the worktree's `.git` and have the host's git run its command; protected paths
  could be bypassed by changing letter case), a server open to the network with open sign-up, a ticket status that could
  be set to anything by hand, and a crash on a common reject-then-delete. The ladder measured whether tickets pass, not
  whether the harness is safe or correct.
- **A scripted test reviewer never exercised the diff.** The demo reviewer answers by script, so every test passed while
  the real reviewer saw an empty `git diff` (the harness's write guard staged the change on the real index). Tests with
  scripted models check the plumbing; they need at least one assertion on what the model would actually see.
- **Prompts drift from the code.** The worker prompt described an old `read_file` gutter and said git was unusable after
  both had changed, and the copy seeded into each workspace never saw a prompt-file change. The environment block now
  states those facts from the code, and a changed built-in prompt reaches workspaces still on the old one.

## What's left

- **Prove splitting on real failures.** Splitting is built and tested with scripted models, but not yet measured on the
  levels a real model fails (Ornith L4–L6).
- **Benchmark in the repository.** Move the ladder (tickets, locked tests, answer keys, runner) into this repo, with 3 runs
  per level and a held-out set, so results are trustworthy and reproducible.
- **Failure mining.** Per-run metrics (tool errors, repeated reads, stuck score, budget use), failure classes, and draft
  improvement tickets generated from them.
- **Candidate-harness pipeline and nightly loop.** Polaris proposes changes to itself, runs the benchmark on the candidate,
  and queues winners for human promotion with rollback: the recursive self-improvement loop.
- **Stuck monitor.** A small decision model (System One style) checks every few turns whether the agent is stuck. An
  offline replay separated stuck runs from healthy ones cleanly; it is not wired in yet.
- **Smaller items:**
  - one turn and token budget per attempt (today both apply per agent session, so an attempt with fix rounds can use
    up to 4 × max turns);
  - inviting members and switching workspaces in the UI;
  - a separate reviewer model per workspace;
  - ticket comments and notifications;
  - formatted dates.
- **Hardening:**
  - containers run as root, with network access;
  - no spending caps per epic or workspace;
  - the Anthropic and OpenAI APIs and the ChatGPT sign-in are tested only against mocks, not with real keys.
- **Not in scope yet:** multi-user deployment, hosting, backups.

## Project layout

```
server/           API (Hono), runs and orchestration, planner, review, wiki, tracker, git, sandbox
  agent/          agent loop, tools, context management, prompts, providers (Anthropic, OpenAI, Ollama, demo, fake)
  migrations/     numbered SQLite migrations (applied in order at startup)
  cli/            agent and seed-tasks commands
web/              React dashboard (board, list, ticket view, projects, cycles, views, wiki, improvement, settings)
docker/           sandbox image
test/             unit and integration tests (node --test)
e2e/              Playwright end-to-end tests
SPEC.md           architecture, abstractions, every subsystem's rules
tasks.md          milestone checklist
```

## Security notes

- **Server.** Listens on `127.0.0.1` unless `HOST` says otherwise. The first account is the owner; sign-up then closes
  (`POLARIS_OPEN_SIGNUP=1` reopens it). Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must come from a
  trusted origin (`BETTER_AUTH_URL`, `WEB_ORIGIN` or the API's own host). The ChatGPT sign-in callback listens on
  `127.0.0.1` only.
- **Secrets.** Provider keys and tokens are encrypted at rest with `POLARIS_SECRET_KEY`, never returned by the API and
  never put in agent context or events. Changing a provider's base URL clears its stored key or tokens unless a new key
  is sent with it, so "Test" can't send them to another host.
- **Agents.** Workers and reviewers run in Docker containers limited to 2 CPUs and 2 GB, as root, with network access.
  Your protected paths, the worktree's `.git` file and the repo's git dir are mounted read-only. The file tools never
  write a path with a `.git` segment, and compare paths case-insensitively on a case-insensitive filesystem. Planner and
  wiki agents run on the host with file tools only (no shell). Changes reach your branch only through Approve.
- **Host git.** Every git command the harness runs has hooks and fsmonitor off, and addresses a run's worktree by the git
  dir it recorded when it created it, never by the worktree's own `.git` file. Harness writes into a worktree (spilled
  output, history) refuse symlinks. The sandbox image setting must be a plain image reference.
- **Scope.** Built for a single trusted user on their own machine. Anyone who can sign in can point a workspace at any
  git repository the server's user can read, merge into it, and spend the `ANTHROPIC_API_KEY` fallback. It is not
  hardened for untrusted users or workspaces side by side.
