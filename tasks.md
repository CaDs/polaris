# Tasks

## M0 — Skeleton (done)
- [x] Hono server, SQLite, migrations for providers/tickets/runs/events/prompts
- [x] Better Auth email/password + workspaces (organizations), session lands in last workspace
- [x] Workspace-scoped `/api/*` middleware + `GET /api/tickets`
- [x] React shell: sign in/up, create workspace, empty board
- [x] Test: session required, tickets isolated per workspace

## M1 — Agent core (done)
- [x] Internal message/block types (`server/agent/types.ts`)
- [x] `Provider` interface + scripted fake provider for tests/replays
- [x] Anthropic Messages adapter (streaming, usage incl. cache tokens)
- [x] Tools: read_file, edit_file (str_replace), shell, search — run on host for now
- [x] Loop with turn/token budget, classified tool errors
- [x] Event log writer; run token totals updated from `usage` events
- [x] CLI: `npm run agent -- <ticket-id>`
- [x] Test: fake provider drives loop to edit a file; events recorded in order

## M2 — Dashboard live (done)
- [x] Ticket CRUD (API + UI)
- [x] Start run from UI; run list per ticket
- [x] SSE stream of run events; live transcript view
- [x] Token/cost counters on board cards and run view
- [x] Cancel run

## M3 — Orchestration (done; harness takes over after this)
- [x] Run queue with N concurrent runs
- [x] Git worktree + branch per run
- [x] Docker container per run; shell tool → `docker exec`
- [x] Test gate: run `npm test` in container; up to 3 attempts with failure fed back
- [x] Review queue: approve → merge branch, reject → back to todo
- [x] Read-only enforcement for `tests/` and `evals/`
- [x] Seed tickets M4+ from this file

## M4 — Providers (done)
- [x] Provider settings UI; secrets encrypted at rest
- [x] OpenAI Responses adapter (API key), reasoning items preserved; `apply_patch` edit tool
- [x] Ollama via Anthropic-compatible endpoint + tool-calling smoke test per model
- [x] OpenAI ChatGPT OAuth auth type
- [x] Model picker per ticket / per retry

## M5 — Context management (done)
- [x] Long tool output → file, return path + tail
- [x] Compaction with searchable full-history file
- [x] Lazy-loaded tools/skills (names in prompt, definitions on demand) — skills as files read on demand; tools stay static (cache prefix), see SPEC
- [x] Cache-friendly request ordering + breakpoints; cache hit rate on dashboard
- [x] Reliability: provider retries, `max_tokens` continue, invalid tool JSON → InvalidArguments

## M6 — Self-improvement (done)
- [x] Reflection step → lessons (versioned in the DB, not a `LESSONS.md` in the repo; injected into the first user message)
- [x] Eval suite from replaying past tickets on clean checkouts (cases must fail at their base commit)
- [x] Prompt versions + eval-gated promotion UI (human click only; no auto-promotion)

## M7 — Planner (done)
- [x] Planner role: epic → child tickets (read-only planner rounds, dependencies, sub-epics to depth 2, limits)
- [x] Worker handoffs delivered back to planner (rounds on settle, batched; optional auto-approve of children)

## M8: model review
- [x] Reviewer agent (same model, read-only tools + `submit_review`) after the test gate; `model_review` workspace setting (default on)
- [x] Findings fed back to the worker's own conversation (`resume`), gate re-run, up to 3 rounds; fail-open when the reviewer errors
- [x] Transcript shows review rounds, verdicts and findings; demo provider plays reviewer (`REVIEW-ONCE`)

## Context rot
- [x] `read_file` returns a stub for an unchanged re-read within a conversation (reset on compaction)
- [x] Compaction: structured summary headings, harness-appended `git status`/`git diff` and list of files read
- [x] Ollama context window detected at run start (`/api/ps`, `/api/show`); `context` setup event in the transcript

## M9: automatic splitting
- [x] Planner `create_ticket` takes a per-child `test_command`; prompt maps protected tests onto children
- [x] Epic gate: `complete_epic` runs the epic's test command on the base branch head in a fresh worktree + sandbox, refused on failure (`epic_gate` event)
- [x] `auto_split` (default on): a task that fails its last attempt becomes a `Split:` epic with the failure context; under an epic it replaces the child for its dependents; depth limit respected
- [x] `child_size_hint` setting in every planner round's environment
- [x] Optional triage of new top-level tickets by a System One model (`triage_model`); score ≥ 3 splits, errors run directly
- [x] UI: "Escalated to" / "Split from" links, epic gate and triage in transcripts, settings; demo provider `SPLIT-ME`, `SPLIT-CHILD`, `EPIC-GATE-FAIL`

## M10: project wiki
- [x] Per-workspace wiki git repo (`SCHEMA.md`, `index.md`, `log.md`, overview/modules/howto/gotchas pages with sources + verified frontmatter); `wiki` setting (default on)
- [x] Every run (worker, planner, reviewer) gets a read-only `.polaris/wiki` snapshot and a `# Project wiki` index with mechanical staleness flags; a write there fails the gate
- [x] Approve queues a serialized wiki ingest (role `wiki`: read-only code checkout + wiki clone, `edit_file` only in the wiki); mechanical lint with fix rounds before the commit
- [x] Build wiki (bootstrap), Refresh stale pages (LLM lint), Lint button; human page edits as commits
- [x] Wiki page: index with stale flags, viewer/editor, history with diffs, maintainer runs; `## Wiki notes` asked of workers; demo maintainer

## Learnings from the ladder
- [x] Gate fix round: a failed gate resumes the worker's own conversation once per attempt (`gate_fix` event) before the fresh retry; not for evals
- [x] Flaky gate re-run (worker gate and epic gate): a failure that passes at once is a pass flagged `flaky`
- [x] Reviewer turn budget proportional to the change (`clamp(6 + ceil(lines / 8), 8, 25)`), shown in the transcript
- [x] `InvalidArguments` on a tool's input shape appends the expected input; the environment names `/work`; worker prompt: run relevant tests while iterating
- [x] Ticket view + New ticket dialog: per-ticket test command; demo `GATE-FIX-ONCE`

## M11: tracker (Linear-style)
- [x] Labels (palette, case-insensitive unique), priority, assignee, estimate, due date on tickets; workspace-scoped validation (migration 012)
- [x] Projects with ordered milestones and progress; cycles (no overlap, current/upcoming/past, scope change, move unfinished)
- [x] Filters, FTS5 search with key jump, sorts on `GET /api/tickets`; saved views (personal or shared)
- [x] Parent epic set by hand within the planner's rules
- [x] UI: filter bar with URL state, list layout with grouping, properties sidebar + shortcuts, command palette, Projects/Cycles/Views pages, labels in Settings
- [x] Agents: tracker header in worker/planner first messages; queue by priority; planner `create_ticket` labels/priority/estimate, children inherit project/milestone/cycle

## Learnings from the model benchmark
- [x] Fair worker budget: `max_turns` (10..500, 120) and `max_minutes` (5..600, 60) workspace settings; attempt-wide wall-clock `budget.deadline` in the loop (`time budget exhausted`), finishHint on 2 turns left or low time; evals use the frozen defaults
- [x] Reflection gets the run's real tool names and must not invent tools
- [x] `Split:` epics copy the original's tracker fields (labels, priority, assignee, estimate, due date, project, milestone, cycle)

## Learnings from the code review
- [x] Security: no agent-written `.git` path; host git with hooks and fsmonitor off and the recorded git dir; case-insensitive protected paths; scratch writes refuse symlinks; image setting validated
- [x] Security: loopback bind (`HOST`), sign-up closed after the first account (`POLARIS_OPEN_SIGNUP`), Origin check on cookie-authenticated mutations, provider secret cleared on `base_url` change, OAuth callback on 127.0.0.1
- [x] Run pipeline: reviewer snapshots on a throwaway index (its `git diff` shows the change); manual status only through the state machine; background work can't crash the process; restart recovery retries attempts and unsticks tickets; one fix-round rule; retry feedback from the previous run's reason
- [x] Planner: rounds only when a child failed, was deleted, or none is open; child delete/move; children inherit the epic's test command; no `create_ticket` after the round ended
- [x] Wiki: `delete_file`, passing no-op refresh, no queue slot while waiting, human edit refused when the page changed, `.polaris/wiki/` paths in the index section, validated sources
- [x] Evals compared on the same model only; settings PUT merges; agent tool edge cases; indexes (015); shared constants, `truncate`, `ticketKey`, `pipeline`, JSON errors, test helpers
- [x] Worker prompt matches the tools (every line numbered, git read-only); test command, git and budget in the environment block; a changed built-in prompt reaches workspaces on the unmodified one

## GPT / Ollama interoperability and accounting
- [x] Public Sign in with ChatGPT dynamic registration, validated identity, isolated encrypted registrations, rotating refresh, cancellation and logout
- [x] Account-visible GPT catalog, namespaced Responses tool round trips, safe account status, first-use confirmation and Manage usage
- [x] Append-only request-attempt usage ledger, historical backfill and explicit incomplete coverage
- [x] Execution/background attribution, mixed-provider reviews, cached/reasoning normalization, retry/partial/missing usage
- [x] Workspace and ticket-tree caps cover associated local, subscription, API-key and background usage
- [x] Shared token categories/totals and live usage refresh in transcripts, run/ticket views and Usage
- [x] Mock OAuth/provider, accounting and browser acceptance; live Ollama protected-test/review/approval smoke test
- [x] Live ChatGPT (`gpt-6.1-sol`) and Ollama (`qwen3.8:27b-mlx`) protected-test/review/approval smoke tests in separate disposable repositories, with reconciled execution/background usage

## M12 — Next (open; `npm run seed-tasks` turns these into tickets)
- [x] Wiki index lists pages with their full `.polaris/wiki/` path so agents don't mistake a wiki page for a code file
- [x] One turn budget per attempt: fix rounds get what is left (at least 10 turns)
- [ ] The 2M token cap per attempt, not per agent session
- [ ] Invite members and switch workspaces in the UI
- [ ] Benchmark in the repo: the complexity ladder (tickets, locked tests, answer keys, runner) with 3 runs per level and a held-out set
- [ ] Measure automatic splitting on levels a real model fails at the fair budget
- [x] Failure mining: per-run metrics (tool errors, repeated reads, budget use): `run_metrics`, `GET /api/metrics`
- [x] Failure mining: failure classes, draft improvement tickets
- [x] Stuck monitor: repeated call/error and no-progress heuristics; nudge, then end the attempt (retried fresh)
- [ ] Stuck monitor: a decision model checks every few turns whether the agent is stuck
- [x] Separate reviewer model per workspace (`review_provider_id`/`review_model`, Settings → Reviewer model; priced at its own rates)
- [x] Spending caps per epic and per workspace
- [x] Sandbox containers run as a non-root user
- [x] A planner round that crashes is restarted (once, by a fresh round; a second failure in a row fails the epic)
- [x] Ticket comments and notifications (bell; review/failed/comment) and the workspace event stream (`GET /api/events`) that replaced the board polling
- [ ] Candidate-harness pipeline: benchmark a proposed harness change against the stable one; human promotion with rollback
