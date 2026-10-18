# Polaris — Spec

Polaris is a self-hosted coding-agent harness with a web dashboard. You file tickets; agents work them in
sandboxed git worktrees; tests gate the result; you approve merges. From M3 on, the harness
builds its own remaining milestones (`tasks.md`).

## Architecture

- **One TypeScript process**: Hono API + N concurrent agent loops. Split workers out only when one process can't keep up.
- **SQLite** via `node:sqlite`. Raw SQL, no ORM. Our migrations: `server/migrations/NNN_*.sql`, run once in order (`PRAGMA user_version`).
- **Auth**: Better Auth (email/password) + organization plugin. **Workspace = organization.**
- **Dashboard**: React + Vite in `web/`, live updates over SSE.
- **Sandbox**: one Docker container per run, worktree mounted at `/work`; every shell tool call is a `docker exec`. The repo's git dir is
  mounted read-only at its host path, so `git status`/`diff`/`log` work inside but commits and ref changes do not (the harness
  commits on the host).

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
      stop on turn/token/time budget
```

Worker budget: workspace settings `max_turns` (10..500, default 120) and `max_minutes` (5..600, default 60). `max_minutes`
is one wall-clock deadline for the whole attempt (counted from the run's start; the first run, gate fix rounds and review
fix rounds share it); `max_turns` applies per agent call (the first run and each fix round count separately). The loop
checks `budget.deadline` (epoch ms) at the top of each turn and ends with `time budget exhausted (<n> min)`. The
`finishHint` fires once, when 2 turns are left or less than max(2 min, 10% of the call's window) remains, whichever
comes first. Planner (50 turns), reviewer, wiki and CLI runs keep their own budgets. Eval case runs use the frozen
defaults (120/60), not the workspace's values, so scores stay comparable when Settings change.

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
  `.polaris/outputs/<turn>-<tool>-<id>.txt` in the run root (`/work/.polaris/...` in the sandbox); the model gets the path,
  size, line count and the last ~2,000 chars, and reads the rest with `read_file` offset/limit or `rg`/`tail`. Capture is
  capped at 20 MB per stream. (`read_file` keeps its own 30k-char cap; it has offset/limit already, and spilling its output
  would make reading a spilled file spill again.) `.polaris/outputs/` and `.polaris/history/` are added to the repo's
  shared `info/exclude` when a worktree is created, and are also left out of `git add`, the diff and the protected-path
  check. `.polaris/skills/` is *not* excluded: skills are committed by humans.
- **Compaction = summarize, then start a new conversation.** When the latest request's context size
  (`input + cache_read + cache_write`) exceeds `min(70% of the provider's context_window, workspace compact_at_tokens)`
  (defaults: anthropic 1M, openai 400k, ollama 32,768; cap 150,000; an Ollama provider still at 32,768 is "auto": the run asks Ollama for the served context at start (`/api/ps` `context_length` of the loaded model, else `/api/show` `*.context_length`), any other stored value wins, detection failure falls back to the stored value; a `setup {step: "context", window, source, compact_at}` event records it; `POLARIS_COMPACT_AT` overrides both, for tests):
  (a) the whole conversation is written as markdown to `.polaris/history/<n>.md` (every message, tool call with input,
  tool result as the model saw it); (b) a user message asks for a progress summary with fixed headings (Goal, Done, Decisions, Key facts as file:line → fact, Left, Next step), appended at the end with the same tools and system, "no tool calls" instructed, calls made anyway are ignored;
  (c) a fresh `messages` array starts with original task + `Context was compacted. Summary: …` + the harness's own `git status --short` / `git diff` (cut at 12,000 chars; omitted outside a git repo) + the paths the old conversation read + `Full history:
  .polaris/history/1.md, … (search it with rg/read_file if a detail is missing)`. Event
  `compaction {n, tokens_before, summary_chars, history_path}`; the transcript renders a divider. Turn and token budgets
  span compactions (the summary turn counts).
- **read_file dedupe.** A `read_file` whose output is byte-identical to an earlier one (same path and range) in the *current* conversation returns a one-line stub naming that turn; any edit changes the bytes, so the content comes back. The memory is dropped on compaction and is empty on `resume`.
- **Skills = our lazy loading.** Skills are `.polaris/skills/*.md` with `name`/`description` frontmatter (plus optional
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
   lessons + the run's real tool names (`<tools>`; the instructions say to name tools exactly as listed, never invent one) + a compact digest of the series (ticket key/title, final status, per attempt: status/reason, turns, tokens,
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
   `base_sha` = the commit the approved run started from, the workspace's setup command, the test command (the ticket's own, else the workspace's), protected paths and image
   as they are now. **A case must fail at base_sha**: the harness checks out base_sha in a clean detached worktree + sandbox,
   runs setup and the test command, and rejects the case if the tests already pass. A case that passes without the change
   can't tell an agent that solved it from one that did nothing, so it would only add noise to every score. An **eval
   run** scores one prompt version on every case (or a chosen subset): one queued run per case through the normal FIFO
   queue and `POLARIS_CONCURRENCY` slots, each with a fresh detached worktree at base_sha + sandbox, the same pipeline
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
  `create_ticket {title, spec, depends_on?: [sibling keys], kind?: task|epic, test_command?}`, `list_children {}`, `finish_round {notes}`
  and `complete_epic {summary}` (M9: gated by the epic gate). System prompt: `prompts/planner.md`, a file, not versioned like the worker prompt: there is
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

## Orchestration: the test gate

After a worker's loop ends, the gate runs the ticket's test command (its own `test_command`, else the workspace's) and
checks that no protected path changed. A failed attempt is retried fresh (`MAX_ATTEMPTS` = 3, failure fed back: the
previous run's `run_finished` reason, its failing gate output, and the last review findings when the review failed it).

- **Restart.** At startup a run left `running` fails with `interrupted by server restart` (worktree and container
  removed); a ticket attempt is then retried like a gate failure while attempts remain, else the ticket fails (a child
  hands off, a planner round fails its epic). A task left `running` with no active run gets its latest run's outcome.
- **Manual status.** `PATCH /api/tickets/:id {status}` (the Status select) moves only between `todo`, `done` and
  `failed`, or `review` back to `todo` (its branch is dropped), never while a run is active; anything else is a 409
  `{error: "invalid_transition", from, to}`. It goes through the same transition as the pipeline: a child marked done
  starts its dependents and wakes its planner; a child put back in `todo` under a running epic starts once its
  dependencies are done.

- **Flaky re-run.** A failure that is a non-zero exit or a timeout, with no protected path touched, is run once more at
  once (the epic gate too). If that passes, the gate passes: `test_result` (`epic_gate`) gets `flaky: true` and
  `first_failure {code, timed_out, output}`, and the transcript says "Tests passed on a re-run (flaky)". If it fails
  again, the second result is the failure. This happens before any fix round, so a flake never triggers one.
- **Gate fix round.** A failed gate resumes the *worker's own conversation* (`RunOptions.resume`, like review fix rounds)
  with the failure (command, exit code or timeout, protected paths touched with "revert these", output tail) and "Fix it
  and finish; the tests run again.", then re-checks. `GATE_FIX_ROUNDS` = 1 per attempt, counted across the whole attempt:
  a gate failure after a review fix round uses it too, if it is still unused. Only a gate that still fails fails the
  attempt (then the fresh retry applies). The round's turns and usage add to the run; a `gate_fix {reason}` event marks
  it ("Tests failed — fixing in the same run"). Not for eval case runs (they measure the unassisted worker) or planners.
- **Environment.** The first message says the repository is at `/work` in the sandbox, also every shell command's working
  directory; tool paths are relative to it (absolute `/work/...` is accepted).
- **Tool input errors.** `InvalidArguments` about a tool's input shape (missing or mistyped field) ends with
  `Expected input: {command: string, timeout?: number}`, derived from the tool's schema. Path errors do not.
- **Per-ticket test command.** The ticket view and New ticket dialog edit `tickets.test_command` (empty = workspace default).

## Model review (M8)

Workspace setting `model_review` (migration 009, default on). After a worker run passes the test gate, the run's own
provider and model review the change before a human sees it (not for eval case runs or planner rounds).

- **Reviewer.** A fresh conversation in the same worktree and sandbox, system prompt `prompts/reviewer.md` (a file, not
  versioned), tools `read_file`, `search`, `shell` and `submit_review {verdict: approve | request_changes, findings:
  [{file, line?, problem, fix}]}` (request_changes needs a finding; `InvalidArguments` otherwise), which ends its loop.
  Budget: `clamp(6 + ceil(lines / 8), 8, 25)` turns for `lines` changed lines (git numstat against base plus new
  files, minus `.polaris/` scratch), same token cap as a worker. It runs *before* the commit and inspects `git status --short` and
  `git diff` (new files are untracked: it reads them). Its first message: ticket, base sha, the test command that passed.
  It hunts correctness bugs against the spec and neighbouring code paths, not style.
- **Fix rounds.** `request_changes`: the findings are appended to the worker's own conversation (`RunOptions.resume`, still
  append-only), the worker fixes and finishes, the gate runs again, then the next review. At most 3 review rounds per
  attempt; if round 3 still requests changes the attempt fails with `model review: changes still requested after 3 rounds`
  and the normal retry rules apply (the next attempt's first message includes the last findings). A gate failure after a
  fix round may use the attempt's gate fix round (see the test gate), else it fails the attempt. Either kind of fix round
  that ends without finishing (budget, provider) fails the attempt as `<why>; the fix round ended: <reason>` and is
  retried like a gate failure; a provider or environment error there is not split either.
- **Fail-open.** A reviewer that errors, or ends without `submit_review` (budget, provider error), is logged as a
  `model_review` event with verdict `error` and the change goes to human review anyway.
- **Events and cost.** `model_review_started {round, budget, lines}` before each reviewer, `model_review {round, verdict: approve |
  request_changes | error, findings, message?}` after; reviewer tool calls and usage go to the same run's log, so the run's
  tokens and cost include review. The transcript shows both.

## Automatic splitting (M9)

Local models (27–35B) finish small tickets and fail large ones, so the harness turns work that is too large into an epic
whose planner splits it into tickets of a size the worker model can finish. Migration 010.

- **Per-child test command.** `create_ticket` takes an optional `test_command` (validated like the API: a string of ≤ 2,000
  chars, `""` = none) stored as the child's `tickets.test_command`, which replaces the workspace command in its gate. The
  planner gives one to a child whose part can't pass the full suite until later children land (a single test file, a
  `--test-name-pattern`, `npx tsc --noEmit`). The children list shows each child's command.
- **Epic gate.** `complete_epic` (after the open-children check) runs the epic's test command (its own `test_command`,
  else the workspace's) on the base branch's current head, after the setup command, in a fresh detached worktree +
  sandbox that is always removed (planner rounds have no sandbox of their own). It fails → the call is refused with the
  command, exit code, sha and output tail; the round goes on, so the planner creates fix-up children and `finish_round`s.
  Event `epic_gate {passed, command, code, timed_out, output, sha}` on the round, shown in its transcript. No command → no
  gate. A split epic keeps the test command of the ticket it replaced, so a split child is gated by its own slice, not by
  a full suite that its siblings still have to make pass.
- **Escalate on failure.** Workspace setting `auto_split` (default on). When a task's series ends failed (its last
  attempt failed and no retry follows; not cancelled, not a human reject, not an eval case run), the harness creates a
  new epic `Split: <title>` with the same spec plus `## Previous direct attempt` (status/reason/turns of every attempt,
  the last gate failure with a 2,000-char output tail, the last model review findings, the worker's final reply), the
  same provider/model choice and test command, and the original's tracker fields (labels, priority, assignee, estimate,
  due date, project, milestone, cycle; its children inherit them as the planner's do), sets the task's `escalated_to` to it, and queues the epic's round 1.
  Under an epic, the new epic is created under the same parent (the parent's planner sees it as a child), the task's
  dependents depend on the new epic instead, and the task is failed *without* waking the parent's planner (the new
  epic is open in its place; the planner hears of both when something next settles). The task's label is `split into
  KEY (failed as one ticket)`, not open. Not split: children of a sub-epic (the new epic would be a third level), a
  child whose epic already has `MAX_CHILDREN`, a ticket that was already split once (a manual re-run that fails stays
  failed), and failures that a smaller ticket would hit too (`ProviderError`, `UnexpectedEnvironment`, `Unknown`). The
  UI shows "Escalated to KEY" on the task and "Split from KEY" on the epic. A split epic that can't be queued fails with
  the reason, which wakes the parent.
- **Size hint.** Workspace setting `child_size_hint` (default "at most 3 files and about 60 changed lines, finishable in
  20 agent turns"; empty = none) goes into every round's environment: "the worker model reliably finishes tickets of
  this size: …; make every child at most that size". Meant to be calibrated per model from a benchmark.
- **Triage** (optional). Workspace setting `triage_model` (default "", off). With `auto_split` on, queueing the first
  run of a top-level task first asks a System One decision model on the workspace's default provider (must be Ollama):
  `POST {base_url}/v1/systemone {model, state: "<title>\n\n<spec>", questions: {size: score 0–4, five criteria}}`,
  10 s timeout. `answers.size.score ≥ 3` → the ticket is split as above (a `## Triage` section instead of the previous
  attempt; no direct run; the API returns the epic's round 1). Event `triage {model, split, score, probabilities,
  confidence | error}` is the first event of the run that follows (the direct run, or the epic's round 1). Any error →
  logged, run directly. Children are not triaged: their planner sized them, and triage would stall its `create_ticket`.
- **Planner prompt.** Size children by the hint; use per-child `test_command`, mapped from the repo's protected tests;
  when a child fails and the environment says failed children are split, expect a `Split:` child instead of creating a
  same-size follow-up; call `complete_epic` only when the epic gate can pass.
- **Demo provider.** `SPLIT-ME` in a ticket also writes `tests/broken.txt`, failing every attempt; an epic whose spec says
  `SPLIT-ME` plans `part1.txt`/`part2.txt` with their own test commands. `SPLIT-CHILD` passes `SPLIT-ME` on to the
  epic's first child. `EPIC-GATE-FAIL` plans only `a.txt` (own command), and answers an epic-gate refusal with
  "Fix: create fix.txt".

## Project wiki (M10)

Per-project memory as an "LLM wiki" (Karpathy): a persistent, interlinked markdown wiki that an LLM maintains and agents read
with their normal tools. Workspace setting `wiki` (migration 011, default on); off = no snapshot, no section, no ingest, no
bootstrap (existing pages stay readable in the UI).

- **Storage.** A git repository per workspace at `<dataDir>/wikis/<workspace_id>/`, created with an initial commit on first use,
  owned by the harness (`server/wiki.ts`). Files: `SCHEMA.md` (conventions, seeded from `prompts/wiki-schema.md`, humans may
  edit), `index.md` (one line per page: `- [Title](path.md) — summary`; ≤ 6,000 chars), `log.md` (append-only,
  `## [date] ingest | KEY Title (merge sha8)` / `lint | …` / `edit | path by user`; **written by the harness**, never by the agent:
  the agent's changes to it are undone before the entry is appended), `overview.md`, `gotchas.md`, `modules/*.md`, `howto/*.md`.
  Each content page has frontmatter `title`, `sources: [repo-relative paths]`, `verified: <sha of the project repo>`, `updated`;
  ≤ 3,500 chars (the maintainer splits longer pages). Reads always use the repo's HEAD (`git show`), never the working tree.
- **Reading (worker, planner, reviewer; not frozen eval cases).** At run start the HEAD is exported into the run's worktree at
  `.polaris/wiki/` (git-excluded like `.polaris/outputs`; added to the run's protected paths: the sandbox mounts it read-only, and
  because git cannot see an excluded dir the gate also compares it with the exported snapshot, so a write there fails the gate
  as a protected-path change). The first user message gets `# Project wiki`: an instruction line ("Read the pages relevant to your
  task (.polaris/wiki/<path>) before exploring the code; trust code over the wiki when they disagree.") and the index, with a
  ` ⚠ may be stale: <files>` flag on each page whose `sources` changed in the project repo between its `verified` sha and the run's
  base sha (`git diff --name-only <verified> <base> -- <sources>`; a verified sha the repo does not have = stale; no sources =
  fresh). Absent when the wiki has no pages. Per-run text only in the first user message (the cache prefix rule). A wiki that
  cannot be read does not stop the run (an `error` event, no section).
- **Writing: one serialized maintainer, only from approved work.** Approve (button or auto-approve of children; not an epic's)
  queues a **wiki ingest**: a run with `role = 'wiki'`, `wiki_op = 'ingest'`, `base_sha` = the merge commit, on the ticket
  (listed in its run list as "wiki", never the default transcript, not counted in its status or totals), with the approved
  run's provider and model (else the workspace default). It goes through the normal FIFO queue and concurrency slots, and
  `wikiSerial` makes runs of one workspace (ingest, bootstrap, lint, human edit) go strictly one at a time, so each sees the
  previous commit. Environment: a temp dir with `code/` (detached, read-only checkout of the merge commit) and `wiki/` (a clone of
  the wiki repo). Tools: `read_file`, `search`, `edit_file` only; `code/` and `wiki/.git` (its config could run commands on the host) are protected paths, so `edit_file` there fails. **No
  shell**: a host shell could write anywhere, and the planner works the same way. System prompt `prompts/wiki.md` (static).
  First message: environment, ticket title and spec, the files changed, the merged diff (15,000 chars), the worker's final reply
  (which may contain a `## Wiki notes` section; worker.md asks for one when it learned something non-obvious) and the current
  index. Budget 30 turns.
- **Validation and commit.** After the agent ends, the harness lints the clone (below). Problems go back into the same conversation
  (`resume`, ≤ 2 more rounds of ≤ 10 turns), then the result is rejected: nothing is committed, the run fails, a `wiki` event
  lists the problems and an `error` event says so; the approval stands. A valid change is committed in the clone with
  `ingest KEY: title (merge sha8)` and fast-forwarded into the wiki repo; nothing changed = no commit (`wiki {unchanged}`).
  Event `wiki {op, commit | unchanged | problems}`. An ingest that cannot be queued is logged on the approved run.
- **Mechanical lint** (`lintDir`, on every commit and the **Lint** button): every content page has valid frontmatter (title, a
  `sources: [...]` list of repo-relative paths, hex `verified`); every content page is linked from `index.md` and every index link is
  a content page; page and index size caps; only root `.md` files, `modules/*.md` and `howto/*.md` exist (no other files, no
  symlinks).
- **Bootstrap** (**Build wiki**, `POST /api/wiki/bootstrap`): the same flow on the base branch head, task: overview, a page per main
  part, howto pages (from README/AGENTS.md/CLAUDE.md and the code), gotchas. Commit `bootstrap: <repo> at <branch> <sha8>`.
  **Refresh stale pages** (`POST /api/wiki/lint`, 409 when nothing is stale): the task lists the pages stale against the base head;
  the maintainer re-verifies each against the code and fixes or deletes it. Commit `lint: re-verify N stale pages at <sha8>`.
  Bootstrap and lint runs have no ticket: they hang off one hidden ticket per workspace (`tickets.hidden`, number -1).
- **UI.** The **Wiki** nav entry (`web/Wiki.tsx`): the index with stale flags, a page viewer (small markdown subset, internal links)
  and editor (`PUT` → mechanical lint → commit `edit <path> by <email>` + log entry), history with a per-commit diff, the maintainer
  runs with their transcripts, the buttons above. Transcripts show a "First message" disclosure for each conversation.
- **API** (workspace-scoped; page paths are checked against the allowed layout and resolved with `resolveIn`): `GET /api/wiki`
  (index, pages with stale flags, log, lint problems of HEAD, recent maintainer runs), `GET|PUT /api/wiki/page`,
  `GET /api/wiki/history`, `GET /api/wiki/diff?sha=`, `POST /api/wiki/bootstrap`, `POST /api/wiki/lint`. Humans can edit existing
  pages only (new pages come from the maintainer; `log.md` is the harness's).
- **Demo provider.** The maintainer is recognized by its system prompt. Ingest writes `modules/demo.md` (sources = the files the
  merged diff touched, verified = the merge sha) and lists it in the index; bootstrap writes `overview.md`; lint re-verifies the first
  stale page; an existing page is updated line by line. `WIKI-NOTES` in a ticket adds a `## Wiki notes` section to the worker's reply,
  `WIKI-WRITE` makes the worker write `.polaris/wiki/x` with the shell (the gate must fail it), `WIKI-BAD` / `WIKI-FIXME` make the
  maintainer of its ingest produce an invalid wiki that it never fixes / fixes in the first fix round.
- **Not built, on purpose:** embeddings or search over the wiki (the index plus `read_file`/`rg` is enough at this size); the
  worker writing the wiki directly (only approved, linted, serialized changes land); LLM lint on a schedule (a button);
  multi-file human edits (a new page has to be linked from the index in the same commit, so humans edit existing pages).

## Tracker (M11)

The board is a Linear-style issue tracker whose workers are agents. Migration 012, server in `server/tracker.ts` (routes
under `/api`, all workspace-scoped: every id a body or a filter names is looked up in the caller's workspace, a foreign id
is a 400 in a body and matches nothing in a filter).

- **Data model.** `labels {name 1–40 chars, unique per workspace case-insensitively (Unicode, plus a NOCASE index), color
  from a fixed palette}` ↔ tickets via `ticket_labels`. On tickets: `priority` (Linear's numbers: 0 none, 1 urgent, 2 high,
  3 medium, 4 low), `assignee_id` (a workspace member: the human who owns the outcome and the review; agents run either
  way), `estimate` (1, 2, 3, 5, 8 points), `due_date`, `project_id`, `milestone_id` (a milestone of that project; moving
  the ticket to another project clears it), `cycle_id` and `cycle_added_at`. `projects {name, description, status
  planned|started|paused|completed|canceled, lead (member), target_date}` with ordered `milestones {name, target_date,
  position}`. `cycles {number (per workspace), name?, starts_at, ends_at}`: calendar days (UTC), both ends included, never
  overlapping within a workspace; current / upcoming / past come from the dates. `views {name, filters (the query params),
  sort, layout board|list, shared}`: a personal view is seen only by its owner, a shared one by the workspace; only the
  owner changes or deletes it. Deleting a label/project/milestone/cycle unsets it on its tickets. Dates are `YYYY-MM-DD`.
- **Ticket JSON** adds `priority, estimate, due_date, labels [{id, name, color}], project {id, name}, milestone {id, name},
  cycle {id, number, name}, assignee {id, name, email}`; `POST/PATCH /api/tickets` take `priority, estimate, due_date,
  assignee_id, project_id, milestone_id, cycle_id, label_ids` (null clears) with 400s naming the field.
- **Parent epic by hand** (`parent_id`): only a todo task without runs moves (the planner owns everything else), into an
  epic that is todo or running and has fewer than `MAX_CHILDREN` children; never out of an epic when a sibling depends on
  it, or when it is the last open child of a running epic (its planner would wait forever). Moving clears `depends_on`
  (sibling ids).
- **Filters** on `GET /api/tickets` (AND across fields, OR within one, comma-separated): `status`, `label` + `label_mode`
  any|all, `priority`, `assignee` (ids, `me`, `none`), `project`, `milestone`, `cycle` (ids, `current`, `none`), `kind`,
  `parent` (id, `none`), `due_before` / `due_after` (inclusive). Unknown params are ignored (the UI keeps `layout` and
  `group` in the same query); bad values are a 400. **Sort**: `manual` (number; the default), `priority` (urgent → low, none
  last), `updated`, `created`, `due` (undated last).
- **Search** `q`: SQLite FTS5 (`tickets_fts`, external content kept by triggers, `unicode61 remove_diacritics`) over title
  + spec, every word prefix-matched and quoted (no FTS syntax gets through), ranked by bm25 with title weighted 10:1;
  `ABC-12` (this workspace's prefix) or a bare number also matches that ticket and ranks it first. An explicit sort
  replaces relevance.
- **Projects / cycles API.** `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (with lead, milestones and
  progress = total, done, points, by status), `POST /api/projects/:id/milestones`, `PUT …/milestones/order {ids}`,
  `PATCH/DELETE /api/milestones/:id`; `GET/POST /api/cycles`, `GET/PATCH/DELETE /api/cycles/:id` (`current` works as an
  id), each with state, progress and `added_after_start` (scope change: tickets that entered after it started);
  `POST /api/cycles/:id/move-unfinished` moves every ticket that is not done to the next cycle (the first starting after
  this one ends; none → 400). `GET /api/tracker` returns what the pickers need in one request (me, members, labels,
  projects with milestones, cycles); `GET /api/members`; `GET/POST/PATCH/DELETE /api/labels`, `/api/views`.
- **UI.** Board and **List** layouts share a filter bar: search (`/` focuses it; Enter on a key opens the ticket), a chip
  per active filter (click to edit, × to remove, labels toggle any/all), **+ Filter** menu, Clear, sort, layout, group
  (list: status, priority, project, assignee, cycle, label), **Save view**. All of it lives in the URL query, so a view is
  a bookmarkable link, and back/forward step through filter changes (typing in search replaces the entry instead).
  Cards and dense list rows show priority, labels, due date, assignee (initials); rows also key, status, parent epic,
  project, cycle. The ticket page has a **properties sidebar** (status, priority, assignee, labels with "create label",
  project, milestone, cycle, estimate, due date, parent epic) with shortcuts `s` `p` `a` `l`; run controls and transcript
  are unchanged. **Command palette** (Cmd/Ctrl+K): tickets by key prefix or title, Create ticket, Go to pages. Pages:
  Projects (list + project page with progress, milestones, tickets), Cycles (current/upcoming/past + cycle page with
  progress, scope change, Move unfinished), Current cycle shortcut, Views; labels are managed in Settings. New ticket
  dialog takes every field (prefilled with the project or cycle whose page is open). Native selects and date inputs
  only: keyboard-friendly, both themes, phone width.
- **Agents.** The first user message of a worker (`# Task`) and of a planner round (`# Epic`) has a header line under the
  title: `Priority: Urgent · Labels: bug, ui · Project: Core › v1 · Due: 2026-11-30` (only what is set; eval case runs keep
  their frozen text). The run queue starts ticket work (worker and planner runs; not eval cases or wiki runs) by the
  ticket's priority, urgent first, then FIFO; no priority comes after low. Planner `create_ticket` takes optional `labels`
  (names, matched case-insensitively, unknown ones created), `priority` (default: the epic's) and `estimate`; children
  inherit the epic's project, milestone and cycle.
- **Not built, on purpose:** comments (separate work), custom workflow states (statuses are the harness's run states),
  drag-and-drop ordering (manual order = ticket number), sub-issue trees beyond epics, notifications, project/cycle
  history charts (progress is computed live), and per-viewer time zones for cycles (UTC calendar days).

## Guardrails

- `tests/` and `evals/` are read-only to agents (harness rejects writes), and so is `.polaris/wiki` (M10). Any `.git` path is
  never writable by agent tools, path checks are case-insensitive on a case-insensitive filesystem, and the worktree's `.git`
  file is mounted read-only in the sandbox.
- Host git never trusts the worktree: hooks and fsmonitor are off, and worktrees the harness created are addressed by the git
  dir it recorded at creation (`--git-dir`/`--work-tree`), not by their `.git` file. Harness writes into the worktree
  (`.polaris/outputs`, `.polaris/history`) refuse symlinks. The sandbox image setting must be a plain docker image reference.
- The harness never edits its running code; changes land through the review queue.
- Every run has a token budget; every passing run is a commit on its own branch.

## Conventions

- Node ≥ 26 runs `.ts` directly (type stripping): erasable syntax only, imports use `.ts` extensions.
- Tests: `node:test` in `test/`, in-memory DB (`npm test`). Each non-trivial piece leaves one test.
- Deps pinned via lockfile; install with `npm install --before <date ≥ 2 weeks ago>`.
