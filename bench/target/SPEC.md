# Agent Harness — Spec

A self-hosted coding-agent harness with a web dashboard. You file tickets; agents work them in
sandboxed git worktrees; tests gate the result; you approve merges. From M3 on, the harness
builds its own remaining milestones (`tasks.md`).

## Architecture

- **One TypeScript process**: Hono API + N concurrent agent loops. Split workers out only when one process can't keep up.
- **SQLite** via `node:sqlite`. Raw SQL, no ORM. Our migrations: `server/migrations/NNN_*.sql`, run once in order (`PRAGMA user_version`).
- **Auth**: Better Auth (email/password) + organization plugin. **Workspace = organization.**
- **Dashboard**: React + Vite in `web/`, live updates over SSE.
- **Sandbox**: one Docker container per run, worktree mounted at `/work`; every shell tool call is a `docker exec`.

## Core abstractions (do not bypass)

1. **Workspace scoping.** Every resource has `workspace_id` (directly, or via its ticket). Every `/api/*` route except auth goes through the session + membership middleware in `server/app.ts` and filters by `c.get("workspaceId")`.
2. **Event log is the source of truth.** A run appends `events(run_id, seq, type, payload)`; dashboard views, token totals, replays and evals are projections. Never store state only in memory.
3. **Ticket → Run → Event.** A ticket has many runs (retries, other models). A run records role, model, worktree, attempt, status, token totals.
4. **Secrets** (provider keys, OAuth tokens) are encrypted at rest with a key from env and never enter agent context or events.

## Agent loop

```
messages = [system, task]
loop: resp = provider.stream(messages, tools) → append → no tool calls? done
      else run each tool, append result (errors returned as text, classified)
      stop on turn/token budget
```

- Tools: `read_file`, `edit_file` (`str_replace` for Claude, `apply_patch` for GPT), `shell`, `search` (rg).
- Fresh context per run: SPEC + PROGRESS notes + LESSONS + ticket + last failure.
- A reply that stops on `max_tokens` without a tool call is not an answer: a "continue" user message is appended (≤ 2 in a row, then the run fails).
- A tool call whose JSON arguments were cut off is answered with an `InvalidArguments` tool_result; the tool does not run.
- Error classes: `InvalidArguments`, `UnexpectedEnvironment`, `ProviderError`, `Timeout`, `UserAborted`; anything else is a harness bug.

## Context management (M5)

**Conversations are append-only.** Current Claude models bind thinking blocks to the exact conversation that produced them:
editing, reordering or deleting earlier messages invalidates them (newer accounts get a 400 on edited history), and it
busts the prompt cache. So within a conversation the loop only ever appends. The tool list and the system prompt are
never changed mid-conversation either (cache prefix, model behaviour).

- **Request layout** (stable prefix first): tools (static per provider kind, keys serialized in sorted order) → system
  prompt (the workspace's active prompt version, v1 = `prompts/worker.md`; static, no per-run or per-repo text) → messages.
  The *first user message* carries everything that differs per run, ahead of the ticket: `# Environment` (sandbox OS/node,
  repo, base branch, read-only paths), the skills list, `# Lessons from earlier runs` (M6), the latest reviewer note, the
  previous attempt's gate failure, then `# Task`.
- **Cache breakpoints** (Anthropic, 3 of the 4 allowed): end of tools, end of system, and a moving one on the last content
  block of the last message, so each turn reads the previous turn's prefix. OpenAI sends `prompt_cache_key` (the ticket id,
  so retries of a ticket share a cache). Cache hit rate = `cache_read / (input + cache_read + cache_write)`, shown per run
  and on the Usage page (`GET /api/usage`: totals, last 14 days, per model, top 10 tickets by tokens).
- **Long tool output → file.** `shell` and `search` results over 8,000 chars are written in full to
  `.harness/outputs/<turn>-<tool>-<id>.txt` in the run root (`/work/.harness/...` in the sandbox); the model gets the path,
  size, line count and the last ~2,000 chars, and reads the rest with `read_file` offset/limit or `rg`/`tail`. Capture is
  capped at 20 MB per stream. (`read_file` keeps its own 30k-char cap; it has offset/limit already, and spilling its output
  would make reading a spilled file spill again.) `.harness/outputs/` and `.harness/history/` are added to the repo's
  shared `info/exclude` when a worktree is created, and are also left out of `git add`, the diff and the protected-path
  check. `.harness/skills/` is *not* excluded: skills are committed by humans.
- **Compaction = summarize, then start a new conversation.** When the latest request's context size
  (`input + cache_read + cache_write`) exceeds `min(70% of the provider's context_window, workspace compact_at_tokens)`
  (defaults: anthropic 1M, openai 400k, ollama 32,768; cap 150,000; `HARNESS_COMPACT_AT` overrides both, for tests):
  (a) the whole conversation is written as markdown to `.harness/history/<n>.md` (every message, tool call with input,
  tool result as the model saw it); (b) a user message asks for a progress summary (done, left, key files, open
  problems), appended at the end with the same tools and system, "no tool calls" instructed, calls made anyway are ignored;
  (c) a fresh `messages` array starts with original task + `Context was compacted. Summary: …` + `Full history:
  .harness/history/1.md, … (search it with rg/read_file if a detail is missing)`. Event
  `compaction {n, tokens_before, summary_chars, history_path}`; the transcript renders a divider. Turn and token budgets
  span compactions (the summary turn counts).
- **Skills = our lazy loading.** Skills are `.harness/skills/*.md` with `name`/`description` frontmatter (plus optional
  scripts beside them). Only `name — description — path` goes into the first user message; the model reads the file with
  `read_file` when relevant. Tool definitions are *not* loaded on demand: changing the tool list mid-conversation busts the
  cache prefix, so tools stay static per run and only the (cheap, append-only) text of skills is lazy. Same idea as
  Cursor's lazy loading, without touching the prefix.
- **Provider retries.** HTTP 429/500/502/503/504/529, "overloaded" and network errors are retried up to 4 times with
  exponential backoff (1 s base, ×2, ≤ 30 s) plus jitter, or the `retry-after` header when present. Each retry is an
  `error` event with `retrying: true`. Never after output started streaming.

## Providers

```ts
interface Provider {
  stream(req: { system: Block[]; messages: Msg[]; tools: ToolDef[]; model: string },
         onEvent: (e: StreamEvent) => void): Promise<{ message: Msg; usage: Usage }>
}
```

| Backend | Adapter | Auth |
|---|---|---|
| Anthropic | Messages | API key |
| Ollama | Messages (Anthropic-compatible endpoint) | none + `base_url` |
| OpenAI | Responses | API key |
| OpenAI subscription | Responses via Codex backend | ChatGPT OAuth (unofficial; personal use) |

Internal message format is Anthropic-style content blocks. Reasoning is an opaque block passed back verbatim.

## Self-improvement (M6)

The harness gets better at the user's repo in three loops of increasing risk. Everything they produce lives in the DB
(`lessons`, `prompts`, `eval_cases`, `eval_runs`, `eval_results`; migration 006), never in the worktree, so no agent tool
can read or write it, and every change is a new version you can see in full on the **Improvement** page.

1. **Reflection → lessons** (lowest risk, applies at once). When a run series ends (it passed → review, it failed for
   good after its retries, or a reviewer rejected it with a note) the harness makes one extra call: a fresh one-message
   conversation, no tools, the run's own provider and model, system prompt = the reflection instructions. Input: the current
   lessons + a compact digest of the series (ticket key/title, final status, per attempt: status/reason, turns, tokens,
   model, tool errors with their class and first line, setup/gate failures with a 1,000-char output tail, the reviewer
   note); never the transcript. Output: the full updated document (short imperative bullets about this repo and harness,
   deduped), capped at 8,000 chars (≈ 2,000 tokens; asked for in the prompt, then cut at a line break), common secret
   shapes redacted. Same text → no new version. Each version records its source (reflection on run X / human edit /
   restore of vN). The latest version goes into the first user message of every new run as `# Lessons from earlier runs`
   (never the system prompt: that would bust the cache prefix); runs record `lessons_version`. Because lessons apply
   immediately, the Improvement page shows them in full with a diff per version and one-click **Restore** (a new version).
   The run gets a `reflection` event (lessons version, chars, usage) just before `run_finished`, so it shows in the
   transcript; reflection tokens are not booked on the run. Reflections of one workspace are serialized.
2. **Eval suite from past tickets.** "Add to evals" on an approved (done) ticket freezes a case: title + spec, repo,
   `base_sha` = the commit the approved run started from, and the workspace's setup/test command, protected paths and image
   as they are now. **A case must fail at base_sha**: the harness checks out base_sha in a clean detached worktree + sandbox,
   runs setup and the test command, and rejects the case if the tests already pass. A case that passes without the change
   can't tell an agent that solved it from one that did nothing, so it would only add noise to every score. An **eval
   run** scores one prompt version on every case (or a chosen subset): one queued run per case through the normal FIFO
   queue and `HARNESS_CONCURRENCY` slots, each with a fresh detached worktree at base_sha + sandbox, the same pipeline
   (setup → agent → test gate incl. protected-path check) with that prompt version and the lessons version active when
   the eval started; but no retries, no commit, no review, no reflection, the source ticket's status and run list never
   change, and the worktree is always removed (there is no branch). Results per case: passed, turns, tokens, cost, duration,
   run id (the transcript is viewable). Score = cases passed / cases; tie-break = mean `tokens_in + tokens_out`.
3. **Prompt versions + eval-gated promotion** (highest risk, applies only after a human click). The worker system prompt
   is versioned per workspace in `prompts` (role `worker`, v1 seeded from `prompts/worker.md`). The active version is
   recorded on each run when it is queued (`prompt_version`, shown as "prompt vN" in the transcript); a run's system prompt
   never changes mid-run, so a promotion applies to runs queued after it. New versions come from "New version" (a human
   edits a copy) or **Propose improvement**: a fresh no-tools call with the current prompt, the lessons and digests of the
   5 most recent failed runs (incl. eval runs), returning a full revised prompt (≤ 20,000 chars) + a one-paragraph
   rationale, stored as an inactive version. **Promotion rule:** a version can be promoted only if its latest finished eval
   on the *current* case set (same case ids) beats the active version's latest finished eval on that same set: strictly
   more cases passed, or as many with ≥ 10% fewer mean tokens. Otherwise Promote is disabled and the reason is shown (no
   eval yet, active version has no eval on this set, not better). Changing the case set invalidates earlier evals for
   promotion. **There is deliberately no auto-promotion:** eval sets are small and agent runs noisy, so a human reads the
   prompt and the scores before it affects every run.

Guardrails specific to M6: agents can't write lessons, prompts, cases or results (DB only, no tool reaches them);
reflection and proposal calls get no tools; lessons and prompts are size-capped and shown in full before they matter.
Agent-written tools (`tools/`) are not built.

## Planner (M7)

Large goals are **epics** (`tickets.kind = 'epic'`; migration 007). Design follows what worked for Cursor's long-running
agents: a root planner that owns the goal and writes no code, workers that each finish one task in isolation and return
one handoff, handoffs flowing back to the planner that asked, and recursion through sub-planners.

- **Roles.** A *planner run* (`runs.role = 'planner'`, `attempt` = round number) works on a detached checkout of the
  base branch's current commit with `read_file` and `search` only (on the host, no sandbox, no edit/patch/shell tool) plus
  `create_ticket {title, spec, depends_on?: [sibling keys], kind?: task|epic}`, `list_children {}`, `finish_round {notes}`
  and `complete_epic {summary}`. System prompt: `prompts/planner.md`, a file, not versioned like the worker prompt: there is
  no eval that could score planning, so the M6 promotion loop would have nothing to gate on. Planner runs go through the
  same FIFO queue; no test gate, commit, review, retry or reflection; the checkout is always removed. *Workers* are normal
  ticket runs; a child's first user message names its epic and asks for a final `## Handoff` section (results, concerns,
  findings).
- **Rounds = the feedback loop.** Round 1 plans, creates children, `finish_round`. The epic stays `running` ("waiting for
  children"). Whenever a child **settles** (done = merged, failed after its retries, or rejected, which counts as failed
  and appends the note to its handoff) and no round is queued or running, the next round starts as a **new run** (fresh
  conversation; conversations stay append-only). Its first message: environment (checkout commit, test gate, limits),
  skills, lessons, a reviewer's note if the epic was sent back, the epic, the notes of every earlier round, and every child
  with status, latest run, dependencies and handoff, those settled since the previous round started marked new. Rounds
  never overlap: children settling while a round is queued are seen by it; children settling while it runs start the next
  round as soon as it ends, so one round handles all of them (`tickets.settled_at` vs the round's start).
  `finish_round`/`complete_epic` end the run at once (loop `finished` check, no extra turn).
- **Ending.** `complete_epic` is refused (tool error listing them) while a child is open: queued, running, in review,
  waiting on dependencies, or stopped by a cancel. A child whose dependency failed or is blocked is *blocked*, not open:
  it never starts on its own; the planner replaces it or leaves it out. Completed → epic `review` with the summary
  (`tickets.handoff`) → **Approve** marks it `done` (nothing to merge: children were merged one by one); **Reject** sends it
  back to `todo`, and the note goes to the next round (Run planner). An epic `failed`s with its reason in `handoff` when a
  round fails (provider error, budget), the round limit is reached, or a round ends without `complete_epic` while nothing
  is open (nothing would ever wake it). `finish_round` with nothing open is refused for the same reason.
- **Scheduling.** A child is queued when created, unless a `depends_on` ticket is not `done`; it is queued when its last
  dependency becomes done. Children branch from the base branch when they start, so they see merged dependencies.
  Dependents of a failed child are not started. A child that cannot be queued fails with the reason (the planner hears of
  it). Children inherit the epic's provider/model choice.
- **Limits.** ≤ 12 children per epic (`MAX_CHILDREN`), ≤ 8 rounds (`MAX_ROUNDS`, `server/planner.ts`); epics nest to depth
  2: a root epic's planner may create sub-epics, whose planners cannot. A sub-epic is a child like any other: its summary
  is its handoff, its approval settles it.
- **Auto-approve** (workspace setting, default off). On: a child whose run passes the gate is merged through the same
  code path as the Approve button (a merge conflict leaves it in review with the error on the run), and a completed sub-epic
  is approved; the root epic always waits for a human. Cursor accepted a small error rate for throughput: agents commit
  straight to the branch and later work fixes earlier mistakes. Here the human gate is the default, because the only
  automatic check is the repo's test command; turn it on when the tests are good enough to be the reviewer.
- **Not built, on purpose:** messaging between workers or from planner to a running worker (workers only hand off at the
  end); shared state or plan files that agents read and write (with locks), which serialized Cursor's agents; a central
  integrator agent that merges everything (merges are per child, by the harness); a judge agent that grades handoffs
  (the test gate and the human reviewer do); re-planning of children already running.
- **API.** `POST /api/tickets {kind}`; `GET /api/tickets/:id` of an epic adds `children` (every descendant with its state
  label and dependency keys); `POST /api/tickets/:id/runs` on an epic queues its next round; approve/reject as for tasks;
  deleting an epic deletes its children (refused while any of their runs is active); `auto_approve_children` in
  `/api/settings`. Events: `handoff {text}` on a child's last run, `round_finished {round, notes, completed}` on a round.

## Guardrails

- `tests/` and `evals/` are read-only to agents (harness rejects writes).
- The harness never edits its running code; changes land through the review queue.
- Every run has a token budget; every passing run is a commit on its own branch.

## Conventions

- Node ≥ 26 runs `.ts` directly (type stripping): erasable syntax only, imports use `.ts` extensions.
- Tests: `node:test` in `test/`, in-memory DB (`npm test`). Each non-trivial piece leaves one test.
- Deps pinned via lockfile; install with `npm install --before <date ≥ 2 weeks ago>`.
