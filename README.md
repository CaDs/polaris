<p align="center"><img src="docs/mark.svg" width="96" height="96" alt="The Polaris mark: a fixed point with two star trails turning around it"></p>

<h1 align="center">Polaris</h1>

<p align="center">A fixed point while your agents work: tickets in, reviewed diffs out.</p>

Polaris is a self-hosted coding-agent harness with a web dashboard. You file tickets; AI agents work them in isolated
sandboxes; tests and a model reviewer check every change before you see it; you approve and it merges. It runs on
hosted models (Anthropic, OpenAI) or entirely on your own machine with local models through Ollama.

Design and rules: [SPEC.md](SPEC.md) · Visual identity: [DESIGN.md](DESIGN.md) · Milestone checklist: [tasks.md](tasks.md)

## Why

Most agent demos work on toy tasks and fall apart on real ones. Polaris is built around the opposite goal: an agent loop
that does real, reviewable work on a real codebase, and gets better at it over time.

- **Tickets in, reviewed commits out.** Every change happens on its own branch in its own container, must pass your test
  command, is reviewed by a model, and waits for your approval before it touches your branch.
- **Local models are first class.** Everything works with a 27–35B model on a laptop or workstation. The harness is
  designed around their limits: small context windows, small steps, imperfect tool calls.
- **Complex work gets split.** A ticket that is too big for one agent becomes an epic: a planner breaks it into tickets the
  agents can finish, with their own acceptance checks.
- **It learns.** Each project keeps a wiki from approved work and lessons from execution feedback, and prompt changes are
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

Every step is an event in an append-only log, streamed live to the dashboard: you can watch each tool call and the model's
reasoning and reply as they are written, see what a run is doing right now (thinking, writing, or running a command and for
how long), see tokens and cost per run, and replay any transcript. On a wide screen the ticket and its runs sit side by side.

## What's done

| Area | What you get |
|---|---|
| **Chat** | A side panel (Cmd/Ctrl+J) to talk with the project. It knows the page you're on, takes `@` mentions of tickets, reads the code and the wiki, asks what's unclear, and proposes tickets as cards. Nothing is filed until you click **File** (or **File and run**); you can edit a proposal first. Replies stream; chats are private and resumable. |
| **Dashboard** | Linear-style UI in six palettes (Black + Blue by default), light, dark or system, under the circumpolar mark ([DESIGN.md](DESIGN.md)): board and list layouts, live transcripts, runs table with tokens, cache hit rate, cost and time per run, Usage page with execution and background token accounting for every provider. |
| **Accounts** | Email/password sign-in; the first account is the owner and sign-up then closes. Everything is scoped per workspace; inside it, each project is one repository with its own board, cycles, wiki and ticket keys. The UI creates one workspace per account; inviting members and switching workspaces have no UI yet. |
| **Providers** | Anthropic API, OpenAI API (and ChatGPT plan sign-in), local Ollama, OpenRouter (hundreds of models behind one key; its billed cost is tracked; providers that retain or train on prompts are excluded by default), a LiteLLM proxy. Provider calls are hardened: https off your network, no cloud-metadata addresses, no redirects, keys scrubbed from errors. ChatGPT plan connections use Polaris’s own OAuth registration and the public Responses API. Keys and tokens are encrypted at rest. A per-provider model picker and a "Test" button that checks tool calling. Ollama's real context window is detected automatically. |
| **Chat and Agent page** | Ask Polaris in a side panel (⌘J) or the full-width **Agent** page: it reads the code and the wiki and proposes tickets for you to file. Replies render as clean Markdown whatever the model's dialect. Each chat belongs to a project: the current project's past chats are listed under **Agent** in the sidebar and on **All chats** (search, delete). Attach **skills** to a message; create workspace skills that every agent gets, next to the repo's own `.polaris/skills/`. |
| **Agent loop** | Tools `read_file`, `edit_file` (or `apply_patch` for OpenAI models), `search`, `shell`. Append-only conversations (prompt caching friendly), provider retries, long output spilled to files. The first message states the environment: test command, read-only paths, budget, git read-only. |
| **Isolation** | One git worktree and branch per run, one Docker container per run, protected paths (your tests) mounted read-only and enforced three ways, the repo's `.git` mounted read-only so agents can `git diff` but not commit or rewrite history. |
| **Test gate** | Your test command must pass. A failure is re-run once (flaky tests don't fail good work), then fed back into the same conversation for a fix, then retried fresh (up to 3 attempts). |
| **Model review** | After the tests pass, the same model (or a reviewer model you pick per workspace) reviews the change with read-only tools and returns findings, which go back to the worker to fix (up to 3 reviews, so 2 fix rounds, per attempt). Any file the reviewer writes is undone. Its budget scales with the size of the diff. |
| **Budgets** | Max turns (default 120) and max minutes (default 60) per attempt, fix rounds included, with a "wrap up" note near either limit. Monthly spending caps per workspace and caps per epic or ticket (cost or tokens). A stuck monitor nudges, then ends an attempt that repeats itself or stops making progress. |
| **Context management** | Compaction into a structured summary plus the current `git diff`, re-reads of unchanged files skipped, per-model compaction thresholds, skills in `.polaris/skills/`. |
| **Planner and splitting** | Epics are planned by a planner agent into child tickets with dependencies, handoffs and their own test commands. A ticket that fails all attempts is turned into a `Split:` epic automatically. An epic only completes when the full test suite passes on the merged result. Optional size triage with a decision model. |
| **Memory** | A per-project LLM-maintained wiki (a git repo with index, pages, log; stale pages flagged against the code; written only from approved work) and versioned lessons from a reflection after every run. |
| **Self-improvement** | Eval cases from approved tickets (must fail at their base commit), prompt versions proposed by the model, eval-gated promotion with a human click (evals on the same model). Failure mining: per-run metrics, failure classes and draft improvement tickets. A new built-in worker prompt replaces an unmodified built-in; an edited prompt is kept and the new one waits as a candidate. |
| **Tracker** | Labels, priority (the run queue starts urgent tickets first), assignee, estimate, due date, projects with milestones, cycles (sprints), filters as shareable URLs, full-text search, saved views, command palette (Cmd/Ctrl+K), keyboard shortcuts, comments, a notification bell (runs to review, failures, comments) and a live board over a workspace event stream. |

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

Or with make: `make setup` does the install and writes `.env` with fresh secrets, `make dev` starts it, `make doctor`
checks Node, git, Docker and Ollama, `make check` runs typecheck and tests, `make e2e/headed` the browser suite. `make`
lists everything.

Or as a single process: `npm run build && npm start` (everything on http://localhost:3000; set `BETTER_AUTH_URL` and
`WEB_ORIGIN` to that address).

### First ticket

1. Open the dashboard, create an account (the first one; sign-up then closes) and a workspace.
2. **Projects → New project**: a name, a key (it prefixes ticket keys, `KEY-12`), the absolute path of a git repository
   with at least one commit, the base branch, a setup command (e.g. `npm ci`) and a test command (e.g. `npm test`).
   Protected paths are your tests, which agents must not weaken; they default to `tests/,evals/`, and `POST /api/projects/inspect`
   suggests them (and the commands) from the repository's base branch. **Add-only** (the default) lets agents add new files there,
   such as regression tests, but not change, delete or rename ones that existed when the run started; **read-only** lets them touch nothing there.
   Add a project per repository; each gets its group in the sidebar. The switcher at the top of the sidebar
   picks the project you work in (a new one is picked for you): new tickets, the home page and the Agent's chats (each chat belongs to one project) follow it.
3. **Settings → Models**: add Ollama (`http://localhost:11434`), Anthropic or OpenAI, click **Test**, then pick the
   workspace's default provider and model.
4. **New ticket**, describe the change, **Run agent**. Or open the chat (Cmd/Ctrl+J), describe what you want, and file the ticket it proposes. Watch the transcript, then **Approve** to merge into your base
   branch or **Reject** with a note for the next attempt.

For bigger work, choose **Epic** when creating the ticket and click **Run planner**.

### Working on Polaris with Polaris

Don't point a project at the checkout the server runs from. `npm run dev` restarts the API on every change there, and an
approved ticket merges into that checkout's `main`, so the restart fails every running run. Use two checkouts:

- **The instance**: its own clone (e.g. `../polaris-instance`), run with `npm run build && npm start`. It owns
  `polaris.db` and `data/`. Upgrade it when no run is live: `git pull && npm ci && npm run build`, then restart.
- **The repository it builds**: your usual checkout. The project's repository path points here; merges land here, and
  nothing watches it. Run `npm run dev` here only with its own database (the default `polaris.db` in this folder is a
  different file from the instance's).

The server warns at startup when it runs with `--watch` from a project's own repository.

## Ollama and your ChatGPT plan

Keep an Ollama provider as the workspace default (for example `qwen3.8:27b-mlx`, with context window left on auto).
Add another provider in **Settings → Models**: kind **openai**, auth **ChatGPT sign-in**. Save it and click
**Continue with ChatGPT**. Complete the browser authorization on this Mac and enable plan usage. Polaris registers
itself with OpenAI; no API key or Codex installation is needed. Existing experimental Codex-login credentials show
**Reconnect required** and must be connected again.

Pick that provider and an account-available GPT model on a ticket or in **Retry with…**. The workspace default stays
Ollama. You can also choose it as the reviewer for local workers. Each account registration is a separate provider;
reconnecting verifies the same identity. **Disconnect ChatGPT** clears tokens and attempts remote revocation while
retaining the registration for later sign-in. OAuth uses a temporary `127.0.0.1` callback, normally port 1455, with an
available-port fallback. Keep the `openai-host-id` file in your data directory across restarts.

All providers report input, output, cache-read/write and total processed tokens through the same accounting path.
**Input** is uncached input; the API’s legacy `tokens_in` includes cache writes. Total = input + output + cache reads +
cache writes. Reasoning tokens already included in output are not counted twice. Retries are separate requests.
Interrupted/missing usage is shown as partial/unavailable, not measured zero. Usage includes workers, reviews,
compaction, wiki/evals, reflections, prompt proposals, failure mining, triage and connection tests. Background usage
is separate from execution and does not change worker turn counts or eval scores. Ticket-associated background work
counts toward its ticket/epic token caps; all calls count toward workspace caps. Caps still allow a session already
in flight to finish. Local runs have no provider inference bill, subscription runs say **ChatGPT plan**, and API-key
costs are estimates where a verified price is available. Token totals do not imply remaining subscription allowance.

Use **Manage usage** to open [ChatGPT usage settings](https://chatgpt.com/settings/usage). A subscription-limit error
pauses further plan requests; explicitly use **Test** to recheck after managing usage, or select Ollama. Polaris never
automatically switches to paid API billing. The ledger preserves reconstructable historical run and reflection usage;
older unrecorded background calls cannot be recovered and are marked as incomplete coverage.

Official contract: [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source).

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
| `POLARIS_ALLOW_HTTP_PROVIDERS=1` | Allow plain http to a provider on a public address (default: http only on this machine or a private network, so a key never crosses the internet unencrypted). Never opens cloud-metadata addresses |
| `NODE_EXTRA_CA_CERTS` | A private CA (PEM) for a provider or LiteLLM proxy with an internal certificate |
| `POLARIS_ALLOW_INSECURE_TLS=1` | Start even with `NODE_TLS_REJECT_UNAUTHORIZED=0` (certificate checks off: not recommended) |
| `POLARIS_OAUTH_PORT` | Local callback port of the ChatGPT sign-in (default 1455) |
| `POLARIS_SLACK_WEBHOOK` | Slack incoming webhook: "ready for review" and "failed" pings with a link to the ticket |
| `POLARIS_PROVIDER=fake` | Scripted demo provider used by the tests |

Tests only: `POLARIS_SANDBOX=host` (commands on the host, no isolation), `POLARIS_COMPACT_AT`, `POLARIS_RETRY_BASE_MS`,
`POLARIS_OPENAI_AUTH_URL`, `POLARIS_OPENAI_PLAN_URL`, `POLARIS_OPENROUTER_URL`; for `npm run e2e`: `E2E_PORT`, `HEADED`, `REAL_MODEL`.

### Workspace settings (Settings page)

One tab per concern, each with its own Save: **Models** (providers, default model, model review (on) and its reviewer model),
**Automation** (auto-approve child tickets (off), automatic splitting (on), triage model (off, picked from the default
Ollama provider's models), child size hint, project wiki (on)), **Limits** (monthly spending caps, max turns and max
minutes per attempt, compaction cap), **Labels**. Saving merges: a field left out keeps its value, `null` resets it to
the default. **Appearance** is yours alone: a palette (Black + Blue by default, Graphite, Stone & Ink, Polar Night, Ember,
Deep Teal) and light/dark/system, saved for your account. Mode and sign-out are also in the account menu at the foot of the sidebar. A project's repository, base branch,
setup and test commands, protected paths and sandbox image are on its **Overview** page.

### In your repository

- `.polaris/skills/<name>.md` with `name` and `description` frontmatter: agents see the list and read the skills they need.
  Add `phases: worker, reviewer` (any of worker, planner, reviewer, chat) to offer a skill only to those agents; without it,
  the worker and the planner see it. Settings → Models → Models per phase gives the planner, chat and wiki their own model.
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
REAL_MODEL=qwen3.8:27b-mlx npm run e2e -- e2e/real-provider-usage.spec.ts # small protected-test/review/approval + usage smoke test
E2E_PORT=3201 npm run e2e   # if port 3200 is taken
```

Live acceptance has passed with `gpt-6.1-sol` through ChatGPT plan access and `qwen3.8:27b-mlx` through Ollama:
separate disposable repositories, protected tests, model review, approval/merge, and reconciled execution/background
token totals. ChatGPT model availability comes from the connected account's catalog.

## From your chat: Claude Code and Slack

You don't have to sit in the dashboard. Polaris is also an MCP server, so you can file, check, approve and reject
tickets from the conversation where the work was discussed:

```sh
npm run token        # prints an API token (valid 365 days; --email to pick the account, --days to change it)
claude mcp add polaris -s user -e POLARIS_TOKEN=<token> -- node "$PWD/server/mcp.ts"
```

Then ask Claude things like "file this as a Polaris ticket", "how is POL-12 doing?" (status, why it failed, review
findings, and the diff when it waits for review), or "approve POL-12". Tools: `create_ticket` (starts an agent unless
`run: false`), `list_tickets`, `ticket_status`, `run_ticket`, `approve_ticket`, `reject_ticket`. `POLARIS_URL`
(default `http://127.0.0.1:3000`) and `POLARIS_WEB_URL` (dashboard links, default `http://localhost:5173`) point it at
another instance. Any HTTP client can use the same token: `Authorization: Bearer <token>`. The token is a session:
signing out everywhere revokes it.

For Slack, create an [incoming webhook](https://api.slack.com/messaging/webhooks) and set `POLARIS_SLACK_WEBHOOK` in
`.env`: Polaris posts each run that is ready for review or failed, linked to the ticket. Reviewing and approving
from Slack itself is not built yet.

## Command line

```sh
npm run agent -- --task "text" --root DIR             # one-off agent run directly on DIR (no sandbox or gate)
npm run agent -- <ticket-id> --root DIR               # run an existing ticket the same way
npm run seed-tasks -- --workspace <slug> --project <KEY> [--file tasks.md]   # one ticket per open "- [ ]" item under "## Mn" headings
npm run reset-password -- you@example.com                                     # forgot it: asks for a new one (hidden), signs the account out everywhere
```

Polaris sends no email, so a forgotten password is reset from the machine it runs on: anyone who can run commands
there can read its database anyway. The sign-in page's "Forgot your password?" says the same.

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
- **Benchmark results.** The ladder is in `bench/` (tickets, locked tests, answer keys, runner, grader). Still missing: a
  held-out set, and committed results with 3 runs per level, so the findings above can be reproduced.
- **Candidate-harness pipeline and nightly loop.** Polaris proposes changes to itself, runs the benchmark on the candidate,
  and queues winners for human promotion with rollback: the recursive self-improvement loop. Today only worker prompts
  (evals) and memory (wiki, lessons) improve; failure mining drafts harness tickets but nothing evaluates them.
- **Stuck monitor, model-based.** The heuristic monitor (repeated calls or errors, no progress) is wired in. A small
  decision model (System One style) checking every few turns is not; an offline replay separated stuck runs from healthy
  ones cleanly.
- **Smaller items:**
  - inviting members and switching workspaces in the UI;
  - formatted dates.
- **Hardening:**
  - containers have network access;
  - spending caps are checked between agent sessions, so a session in flight can overshoot a cap;
  - a reviewer that errors is skipped (fail-open) and the change still goes to human review;
  - the CLI (`npm run agent`) runs on the host with no sandbox, test gate or spending cap;
  - automated provider and subscription tests use local mocks; live subscription acceptance requires signing in with your own eligible account.
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
- **Agents.** Workers and reviewers run in Docker containers limited to the project's CPUs and memory (default 4 and 4 GB) and 512 processes, with network
  access, as a non-root user with every capability dropped and `no-new-privileges`. On Linux that user has your uid and
  gid, so files agents create in the worktree are yours; under Docker Desktop it is the image's `polaris` (1000:1000),
  and Docker Desktop maps the files to you. A custom sandbox image runs as the same uid, so it needs a writable `HOME`.
  The built-in image is rebuilt when its `polaris.image.version` label is older than the harness expects.
  Your protected paths (in read-only mode; add-only mode enforces them in the file tools and the gate, so agents can add files there), the worktree's `.git` file and the repo's git dir are mounted read-only. The file tools never
  write a path with a `.git` segment, and compare paths case-insensitively on a case-insensitive filesystem. Planner and
  wiki agents run on the host with file tools only (no shell). Changes reach your branch only through Approve.
- **Host git.** Every git command the harness runs has hooks and fsmonitor off, and addresses a run's worktree by the git
  dir it recorded when it created it, never by the worktree's own `.git` file. It never descends into a nested repository,
  and a change that contains one fails the test gate. Harness writes into a worktree (spilled
  output, history) refuse symlinks. The sandbox image setting must be a plain image reference.
- **Scope.** Built for a single trusted user on their own machine. Anyone who can sign in can point a workspace at any
  git repository the server's user can read, merge into it, and spend the `ANTHROPIC_API_KEY` fallback. It is not
  hardened for untrusted users or workspaces side by side.
