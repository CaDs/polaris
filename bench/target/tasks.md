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
