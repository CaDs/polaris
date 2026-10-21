# Polaris — Spec

Polaris is a self-hosted coding-agent harness with a web dashboard. You file tickets; agents work them in
sandboxed git worktrees; tests gate the result; you approve merges. From M3 on, the harness
builds its own remaining milestones (`tasks.md`).

## Architecture

- **One TypeScript process**: Hono API + N concurrent agent loops. Split workers out only when one process can't keep up.
- **SQLite** via `node:sqlite`. Raw SQL, no ORM. Our migrations: `server/migrations/NNN_*.sql`, run once in order (`PRAGMA user_version`).
  M15 squashed migrations 001–022 into one `001_init.sql` (there was no data to keep: delete an older `polaris.db`); "migration
  NNN" below names where a feature's schema first landed.
- **Auth**: Better Auth (email/password) + organization plugin. **Workspace = organization.** The UI creates one workspace
  per account and has no invite or workspace switcher yet; members (the assignee and lead pickers) come from the plugin's
  tables.
- **Dashboard**: React + Vite in `web/`, live updates over SSE.
- **Sandbox**: one Docker container per run, worktree mounted at `/work`; every shell tool call is a `docker exec`. The repo's git dir is
  mounted read-only at its host path, so `git status`/`diff`/`log` work inside but commits and ref changes do not (the harness
  commits on the host).

## Core abstractions (do not bypass)

1. **Workspace scoping.** Every resource has `workspace_id` (directly, or via its ticket). Every `/api/*` route except auth goes through the session + membership middleware in `server/app.ts` and filters by `c.get("workspaceId")`.
   Inside a workspace, a **project** is one git repository: its tickets, cycles, wiki and chats belong to it (see Projects (M15)).
2. **Transcript events and usage measurements are persisted.** The append-only `usage_ledger` is the accounting source of truth; run counters and usage events are compatible projections and never charge the same request twice. A run appends `events(run_id, seq, type, payload)`; dashboard views, token totals, replays and evals are projections. Never store state only in memory.
3. **Ticket → Run → Event.** A ticket has many runs (retries, other models). A run records role, model, worktree, attempt, status, token totals.
4. **Secrets** (provider keys, OAuth tokens) are encrypted at rest with a key from env and never enter agent context or events.

## Agent loop

```
messages = [system, task]
loop: resp = provider.stream(messages, tools) → append → no tool calls? done
      else run each tool, append result (errors returned as text, classified)
      stop on turn/token/time budget
```

Worker budget: workspace settings `max_turns` (10..500, default 120), `max_minutes` (5..600, default 60) and `max_tokens`
(100k..20M, default 2M: uncached input + cache writes + output). `max_minutes`
is one wall-clock deadline for the whole attempt (counted from the run's start; the first run, gate fix rounds and review
fix rounds share it); `max_turns` is also per attempt: a fix round gets what is left, but at least `FIX_ROUND_MIN_TURNS` (10),
so a short fix is still possible. `max_tokens` is per attempt the same way: a fix round gets what the attempt has left,
but at least `FIX_ROUND_MIN_TOKENS` (200k). The loop
checks `budget.deadline` (epoch ms) at the top of each turn and ends with `time budget exhausted (<n> min)`. The
`finishHint` fires once, when 2 turns are left or less than max(2 min, 10% of the call's window) remains, whichever
comes first. Planner (50 turns), reviewer, wiki and CLI runs keep their own budgets. Eval case runs use the frozen
defaults (120/60), not the workspace's values, so scores stay comparable when Settings change.

- Tools: `read_file` (every line numbered `N<tab>`), `edit_file` (str_replace; OpenAI providers get `apply_patch`
  instead), `shell` (timeout in seconds, default 120, max 600; 0 = default), `search` (rg). The wiki maintainer also has
  `delete_file` and no shell.
- Fresh context per run: environment, skills, lessons, wiki index, epic handoff request, reviewer note, last failure, ticket
  (see Context management).
- A reply that stops on `max_tokens` without a tool call is not an answer: a "continue" user message is appended (≤ 2 in a row, then the run fails).
- A reply with `stop_reason: refusal` fails the run (`ProviderError`), it does not count as passed.
- A tool call whose JSON arguments were cut off is answered with an `InvalidArguments` tool_result; the tool does not run.
- Error classes: `InvalidArguments`, `UnexpectedEnvironment`, `ProviderError`, `Timeout`, `UserAborted`, `SpendingCap` (see Spending caps); anything else is a harness bug.

## Stuck monitor and run metrics (M12)

A benchmark worker once spent all 120 turns repeating one cheap call (no errors, no diff, 12k input tokens); only the turn
budget ended it. The loop now watches for that, without a decision model. Constants: `STUCK` in `loop.ts`.

- **Signals**, checked after each turn's tool calls:
  `repeat_call`: the same call (name + canonical JSON input) with the same result in ≥ 3 of the last 6 turns (a
  `read_file` dedupe stub counts as the output it points at; a test command whose output changed after an edit does not repeat);
  `repeat_error`: the same tool error ≥ 3 times in a row;
  `no_progress`: ≥ 8 turns in a row of only reads, searches and failed calls (a successful `shell` may have written, so it
  counts as progress), after a successful `edit_file`/`apply_patch`/`delete_file`, or after turn 12 if there was none; only for
  tool sets with a write tool (not the planner or reviewer).
  `no_tool` is reserved: a reply without tool calls already ends the run (passed, refused, or "continue" ≤ 2 times on `max_tokens`).
- **First detection** → `stuck {turn, signal, detail, action: "nudge"}` and a `[harness]` note with that turn's tool results:
  what it repeated, that the result will not change, take a different step or finish with what it has. Counters restart.
- **Next detection** (any signal; `no_progress` after its own nudge already after 4 more idle turns) → `stuck {…, action:
  "stop"}` and the run fails `stuck: <signal> (<detail>)`. Each `runAgent` call has its own monitor (a fix round starts fresh).
- **Worker**: a `stuck:` failure is retried fresh while attempts remain, fed back as "Previous attempt was stopped because
  it repeated … / made no progress: …". Never split on it (like provider/environment errors). A turn, time or token
  budget failure is retried the same way (fed back as "Previous attempt failed: …"); the last attempt's is split.
- **`run_metrics`**, one per run right before `run_finished`: `{turns, tool_calls, tool_errors, repeated_calls (same name +
  input as an earlier call of the run), repeated_reads (dedupe stubs), compactions, first_edit_turn (1-based), files_changed
  (worker: paths changed against base incl. untracked, minus `.polaris` scratch; else null), turns_pct, minutes, minutes_pct
  (null without a deadline), input, output, cache_read, stuck: null | {turn, signal, action}}`. Percentages are 0–100 of the
  budget; `minutes` is elapsed wall time (1 decimal). The loop logs it for direct runs (CLI); the pipeline logs one for the
  whole run instead: fix rounds add up (their turns offset), worker turns/minutes are of the attempt's budget, tokens are
  the run's (`run_finished` usage, reviewer included).
- **API**: `GET /api/runs/:id/metrics` (the payload, 404 before there is one); `metrics` on each run of `GET
  /api/tickets/:id`; `GET /api/metrics?days=14` (1..90): `{days, rows: [{day, model, runs, passed, failed, cancelled, measured,
  mean_turns_pct, sum_turns_pct, stuck, tool_calls, tool_errors, tool_error_rate (0–1), mean_files_changed}]}` per UTC day of
  run start and model, newest first; `measured` = runs with `run_metrics` (the averages and sums are over those).

## Spending caps (M12)

- **Caps.** Workspace settings `monthly_cap_usd` and `monthly_cap_tokens` (default `null` = no cap; non-negative, tokens
  whole; `""` from the form clears) over the current UTC calendar month by request start, every model call of the workspace (eval
  cases and wiki runs included). Per ticket `cap_usd` / `cap_tokens` (ticket POST/PATCH, edited in an epic's header)
  over the ticket's own runs and every descendant's, any month: an epic's covers its planner rounds and the whole tree.
  Children inherit nothing; a ticket is checked against its own cap and every capped epic above it.
- **Measure.** Tokens = uncached input + output + cache reads + cache writes, measured once per actual request attempt in `usage_ledger`, as `/api/usage` counts them. USD comes from the ledger’s provider/model/billing snapshots and verified price estimates, including mixed-model reviews. Local/subscription inference has no provider API bill, while unknown API prices are identified as unknown. All tokens count.
- **Enforcement**: one function, `capCheck` (`server/runs.ts`), called by `pipeline()` before a run's work (no worktree,
  sandbox or call yet) and before every later model call of a run: a gate or review fix round, each reviewer, a wiki fix
  round (a planner round is its own run). A call in flight always finishes. Reached (used ≥ cap): an `error` event `{kind:
  "SpendingCap", message, cap: {which, used, cap}}` and the run fails `SpendingCap: spending cap reached: <which>
  <used>/<cap>` (which: `workspace <YYYY-MM> cost|tokens` or `<KEY> cost|tokens`). Never retried, never split, no
  reflection (another call); a child hands off the reason and its planner's next round is refused too, which fails the
  epic at once (no fresh-round retry). At 80% of any cap: one `error` event `SpendingCapWarning` per run.
- **Visibility.** `GET /api/usage` has `cap: {usd, tokens, used_usd, used_tokens, month}` (the Usage page shows a bar per
  set cap); an epic's `GET /api/tickets/:id` has `spent: {usd, tokens}` (its header: "spent $x of $y").
- Background requests (reflection, proposal, mining, triage, connection tests) check the same caps before each call. CLI runs (`npm run agent`, no pipeline) remain uncapped but measured.

## Failure mining (M12)

The workspace's own model turns repeated failures into draft tickets, so nobody has to read transcripts to find them.
Code: `server/failures.ts`; migration 017.

- **Failure class**, mechanical (no model), on `runs.failure_class` for worker ticket runs (not eval case runs), set when
  the pipeline finishes a run and when a person rejects a passed one; runs that ended elsewhere (cancelled while queued, a
  restart) or before migration 017 are classified on the next `GET /api/failures`. From the `run_finished` reason:
  `stuck` (`stuck:`), `budget_turns` (turn or token budget), `budget_time`, `gate_tests` (`` `cmd` exited with code N `` /
  timed out), `gate_protected` (`modified protected path`), `review_rejected` (`model review…`), `provider_error`
  (`ProviderError:`, a reply cut off), `environment` (`UnexpectedEnvironment:`/`Timeout:`: setup command, sandbox, a
  restart), `cancelled`; `human_rejected` = a passed run with a `review` rejection; anything else
  `unknown`. A fix round's ending (`<why>; the fix round ended: <how>`) wins only when it is stuck, provider, environment
  or cancel; a budget running out in a fix round leaves the gate or review that started it as the class. With no
  recognizable reason the last `stuck` stop, then a failed `test_result` decide.
- **`GET /api/failures?days=30`** (1..90; UTC days by run end, today included): `{days, classes: [{class, description,
  runs, tickets, examples: [{run_id, ticket_id, ticket_key, title, reason, model}] (≤ 3, different tickets first, newest
  first), mined: {id, key, status} | null}], rows: [{day, class, runs}]}`, classes by runs, then name. Runs of tickets
  labelled `mined` never count (mining its own drafts would feed on itself).
- **`POST /api/failures/mine`** (Learning page, "Mine failures"; manual only): for each class with ≥ 2 runs in the
  last 30 days, no open mined ticket (`mined_class` = the class, status not done/failed) and not `cancelled` (a person's
  choice), one call with the workspace default model (as Propose improvement): system prompt `MINE_SYSTEM`, a dossier
  (class + description, counts, the examples' run digests as reflection sees them: outcome, tool errors, setup/gate output
  tails, plus the review note for `human_rejected`; the current lessons), and one declared tool `submit_mined_ticket
  {verdict: repo|harness, title, spec, lesson, confidence 0–1}` that is read, never run. `repo` → a `todo` ticket with
  `mined_class`, the label `mined` (created when missing), and the model's spec followed by `## Mined from failures`
  (class, counts, confidence, the example reasons); at most 5 per mining. `harness` → the lesson is appended to the
  lessons as a new version (source reflection on the newest example run) unless it is there already or would overflow
  them. A broken answer skips its class. The result `{id, created: [{class, ticket_id, key, title, confidence}], lessons:
  [{class, version, lesson, confidence}], skipped: [{class, why}]}` is stored in `minings` and returned.
- Mined tickets never run on their own: a person reads them and presses Run. The ticket page shows "mined from <class>".

## Context management (M5)

**Conversations are append-only.** Current Claude models bind thinking blocks to the exact conversation that produced them:
editing, reordering or deleting earlier messages invalidates them (newer accounts get a 400 on edited history), and it
busts the prompt cache. So within a conversation the loop only ever appends. The tool list and the system prompt are
never changed mid-conversation either (cache prefix, model behaviour).

- **Request layout** (stable prefix first): tools (static per provider kind, keys serialized in sorted order) → system
  prompt (the workspace's active prompt version, v1 = `prompts/worker.md`; static, no per-run or per-repo text) → messages.
  The *first user message* carries everything that differs per run, ahead of the ticket: `# Environment` (sandbox OS/node,
  repo, base branch, test command, read-only paths, git read-only, turn and minute budget), the skills list, `# Lessons
  from earlier runs` (M6), the wiki index (M10), the epic's handoff request (M7), the latest reviewer note, the previous
  attempt's failure, then `# Task`. The environment block is the one place for those facts; `worker.md` only points at it.
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
  (a) the whole conversation is written as markdown to `.polaris/history/<n>.md` (the next free n; every message, tool call with input,
  tool result as the model saw it); (b) a user message asks for a progress summary with fixed headings (Goal, Done, Decisions, Key facts as file:line → fact, Left, Next step), appended at the end with the same tools and system, "no tool calls" instructed, calls made anyway are ignored;
  (c) a fresh `messages` array starts with original task (+ the fix-round message when the call resumed a conversation) + `Context was compacted. Summary: …` + the harness's own `git status --short` / `git diff` (cut at 12,000 chars; omitted outside a git repo) + the paths the old conversation read + `Full history:
  .polaris/history/1.md, … (search it with rg/read_file if a detail is missing)`. Event
  `compaction {n, tokens_before, summary_chars, history_path}`; the transcript renders a divider. Turn and token budgets
  span compactions (the summary turn counts).
- **read_file dedupe.** A `read_file` whose output is byte-identical to an earlier one (same path and range) in the *current* conversation returns a one-line stub naming that turn; any edit changes the bytes, so the content comes back. The memory is dropped on compaction and is empty on `resume`.
- **Skills = our lazy loading.** Skills are `.polaris/skills/*.md` with `name`/`description` frontmatter (plus optional
  scripts beside them). Only `name — description — path` goes into the first user message; the model reads the file with
  `read_file` when relevant. Tool definitions are *not* loaded on demand: changing the tool list mid-conversation busts the
  cache prefix, so tools stay static per run and only the (cheap, append-only) text of skills is lazy. Same idea as
  Cursor's lazy loading, without touching the prefix.
  M14: an optional `phases:` frontmatter line (`worker`, `planner`, `reviewer`, `chat`; comma-separated or `[a, b]`)
  offers the skill only to those agents; without it the worker and the planner see it, as before. The reviewer gets its
  list at the top of its task, the chat in its first turn's message. The wiki maintainer gets none.
  M17 (migration 004, `server/skills.ts`): **workspace skills** (`skills {name (unique per workspace, case-insensitive),
  description, body, phases}`) are made in Polaris (Settings → Skills, or **Create skill** in the chat composer;
  `GET/POST /api/skills`, `PATCH/DELETE /api/skills/:id`). Every worker, reviewer, planner and chat turn writes them to
  `.polaris/workspace-skills/<name>-<id8>.md` in its checkout (git-excluded like the other `.polaris` scratch dirs; a read-only
  path for the worker when there are any), and `listSkills` reads that directory after `.polaris/skills/`, so agents see both
  kinds the same way. Frozen eval case runs get none (a score must not move when someone edits a skill). In chat a member
  can **attach** up to 5 skills to a message (`skills: ["repo:<file>.md" | "ws:<id>"]`, from
  `GET /api/projects/:id/skills`: the repo's skills on its base branch, read with git, and the workspace's): their full text
  goes ahead of the message under `# Skills the user attached`, and the message shows them as chips. Unknown ids, and repo
  ids that are not a plain `.md` file name, are left out.
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
| OpenAI subscription | Public Responses API (`store:false`, `stream:true`) | Sign in with ChatGPT dynamic registration |
| OpenRouter (M16) | Chat Completions (`agent/providers/chat.ts`), always `https://openrouter.ai/api/v1` (no base URL) | API key |
| LiteLLM proxy (M16) | Chat Completions at `<base_url>/v1/chat/completions` (a trailing `/v1` is not doubled) | master/virtual key, or none; `base_url` required |

Internal message format is Anthropic-style content blocks. Reasoning is an opaque block passed back verbatim (Chat
Completions: dropped; streamed `reasoning`/`reasoning_content` deltas still show live).

**Watching a run.** `GET /api/runs/:id/events` replays the stored events, then live ones (de-duped by seq), plus transient
`{type: "live", parts}` messages with no id: the running model call's text, reasoning and tool calls as they stream
(`liveStream` in `agent/events.ts`), coalesced to one message per 100 ms, sent only while someone watches, and never
stored. Any stored event of the run sends what is pending first, so a turn's live output never arrives after its
`assistant_message`. The run view shows the live output at the end of the transcript, and a status line pinned to the
bottom of the viewport says what the run is doing now ("Thinking…", "Writing…", "Running `<command>` · 1:12 of 10:00",
"Checking the change…"), with "Jump to latest · N new" when the reader has scrolled away. It follows new output only once
the reader has scrolled to the end, so opening a ticket doesn't scroll away from it. Reasoning with text is kept in the
transcript as a collapsed "Thinking" block: Anthropic and Ollama `thinking`, an OpenAI reasoning `summary`. The ChatGPT
plan asks for `reasoning: {summary: "auto"}`; an API key doesn't, since OpenAI can require a verified organization for
summaries. Encrypted-only reasoning shows nothing.

- **OpenRouter.** Models: the public catalog (`/models`, cached an hour), only those whose `supported_parameters` include
  `tools`, with their names. Every request asks for `usage: {include: true}`: the cost OpenRouter bills comes back with the
  usage and is what the ledger records (`RequestUsage.cost_usd`; spending caps count it). `options.data_collection`
  (migration 003, `providers.options` JSON): `deny` (default) sends `provider: {data_collection: "deny"}`, so only providers
  that neither retain nor train on prompts serve the request; `allow` lifts it. Attribution headers `HTTP-Referer` and
  `X-Title: Polaris`. Context window left at the default (128000): each model's `context_length` from the catalog.
- **LiteLLM.** Models: the proxy's `/v1/models` (its `model_list` aliases the key may use). Cost: unknown (priced from the
  table when the model is in it).
- **Provider egress** (`server/egress.ts`, every provider call including model lists and Ollama's window detection):
  `providerFetch` checks the URL first: http(s) only, no `user:pass@`; never link-local, unspecified or multicast addresses
  (cloud metadata: 169.254.0.0/16, fe80::/10, `fd00:ec2::254`, also as IPv4-mapped IPv6); plain http only when every address
  the host resolves to is loopback or private (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), checked again at request
  time (cached a minute per origin) because a name can point anywhere; `POLARIS_ALLOW_HTTP_PROVIDERS=1` lifts the http rule,
  never the metadata one. A saved base URL gets the same checks without DNS (a single-label, `.local`, `.internal`, `.lan`
  name counts as local). Redirects are refused (a key never follows one), no response headers within 120 s (model lists
  10–15 s) fails the call, and error bodies are read up to 64 KiB. Policy failures are not retried.
- **Secrets.** Keys must be printable without spaces (a key is a header value: no header injection), at most 500 chars.
  `secret_last4` only for keys of 16+ chars. Provider error messages pass `scrub()`: the provider's own key and common key
  and bearer-token shapes become `[redacted]` before they reach events, transcripts, the ledger or the UI. The server refuses
  to start with `NODE_TLS_REJECT_UNAUTHORIZED=0` unless `POLARIS_ALLOW_INSECURE_TLS=1` (a private CA goes in
  `NODE_EXTRA_CA_CERTS`).
- **Migrations** run with foreign keys off and `PRAGMA foreign_key_check` before each commit, so one can rebuild a table
  (003 widens the `kind` CHECK) without the drop cascading.

## Self-improvement (M6)

The harness gets better at the user's repo in three loops of increasing risk. Everything they produce lives in the DB
(`lessons`, `prompts`, `eval_cases`, `eval_runs`, `eval_results`; migration 006), never in the worktree, so no agent tool
can read or write it, and every change is a new version you can see in full on the **Learning** page (route `/improvement`).

1. **Reflection → lessons** (lowest risk, applies at once). When a run series ends (it passed → review, it failed for
   good after its retries, or a reviewer rejected it with a note) the harness makes one extra call, except when it failed
   with a provider or environment error (`failureClass`): a lesson about a timeout or a restart misleads every later run,
   so the event is `reflection {skipped: <class>}`. The call: a fresh one-message
   conversation, no tools, the run's own provider and model, system prompt = the reflection instructions. Input: the current
   lessons + the run's real tool names (`<tools>`; the instructions say to name tools exactly as listed, never invent one) + a compact digest of the series (ticket key/title, final status, per attempt: status/reason, turns, tokens,
   model, tool errors with their class and first line, setup/gate failures with a 1,000-char output tail, the reviewer
   note); never the transcript. Output: the full updated document (short imperative bullets about this repo and harness,
   deduped), capped at 8,000 chars (≈ 2,000 tokens; asked for in the prompt, then cut at a line break), common secret
   shapes redacted. Same text → no new version. Each version records its source (reflection on run X / human edit /
   restore of vN). The latest version goes into the first user message of every new run as `# Lessons from earlier runs`
   (never the system prompt: that would bust the cache prefix); runs record `lessons_version`. Because lessons apply
   immediately, the Learning page shows them in full with a diff per version and one-click **Restore** (a new version).
   The run gets a `reflection` event (lessons version, chars, usage) just before `run_finished`, so it shows in the
   transcript; reflection tokens are booked as background usage in the ledger, separately from execution counters on the run. Reflections of one workspace are serialized.
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
   on the *current* case set (same case ids) beats the active version's latest finished eval on that same set with the
   same model: strictly more cases passed, or as many with ≥ 10% fewer mean tokens. An eval with a cancelled case never
   counts. Otherwise Promote is disabled and the reason is shown (no eval yet, active version has no eval on this set
   with that model, not better). Changing the case set invalidates earlier evals for
   promotion. **There is deliberately no auto-promotion:** eval sets are small and agent runs noisy, so a human reads the
   prompt and the scores before it affects every run. One exception, for the built-in text: when `prompts/worker.md`
   changes, a workspace without a seed version of the new text gets one as its next version (`source = 'seed'`, once per
   text, on its next `activePrompt`). It becomes active only when the active version is itself a seed (versions are never
   edited, so that is unmodified built-in text); a workspace on a human or proposed version keeps it, and the new seed
   waits as a candidate whose rationale says so. Evals of the old version don't count for the new one.

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
  same FIFO queue; no test gate, commit, review or reflection (a failed round is retried once, see Ending); the checkout is always removed. *Workers* are normal
  ticket runs; a child's first user message names its epic and asks for a final `## Handoff` section (results, concerns,
  findings).
- **Rounds = the feedback loop.** Round 1 plans, creates children, `finish_round`. The epic stays `running` ("waiting for
  children"). When a child **settles** (done = merged, failed after its retries, or rejected, which counts as failed
  and appends the note to its handoff) and the planner has something to act on, i.e. a child failed or no child is open
  any more (or a child was deleted), and no round is queued or running, the next round starts as a **new run** (fresh
  conversation; conversations stay append-only). A child that is done while siblings are still open starts no round:
  the harness queues its dependents and the next round reads its handoff, so rounds grow with failures, not children. Its first message: environment (checkout commit, test gate, limits),
  skills, lessons, a reviewer's note if the epic was sent back, the epic, the notes of every earlier round, and every child
  with status, latest run, dependencies and handoff, those settled since the previous round started marked new. Rounds
  never overlap: children settling while a round is queued are seen by it; children settling while it runs start the next
  round as soon as it ends, so one round handles all of them (`tickets.settled_at` vs the round's start).
  `finish_round`/`complete_epic` end the run at once (loop `finished` check, no extra turn).
- **Ending.** `complete_epic` is refused (tool error listing them) while a child is open: queued, running, in review,
  waiting on dependencies, or stopped by a cancel. A child whose dependency failed, was deleted or is blocked is *blocked*, not open:
  it never starts on its own; the planner replaces it or leaves it out. Completed → epic `review` with the summary
  (`tickets.handoff`) → **Approve** marks it `done` (nothing to merge: children were merged one by one); **Reject** sends it
  back to `todo`, and the note goes to the next round (Run planner). An epic `failed`s with its reason in `handoff` when a
  round fails twice in a row (provider error, budget, crash: a failed round is retried once by a fresh round, after an
  `error` event saying so), the round limit is reached, or a round ends without `complete_epic` while nothing
  is open (nothing would ever wake it). `finish_round` with nothing open is refused for the same reason.
- **Scheduling.** A child is queued when created, unless a `depends_on` ticket is not `done`; it is queued when its last
  dependency becomes done. Children branch from the base branch when they start, so they see merged dependencies.
  Dependents of a failed child are not started. A child that cannot be queued fails with the reason (the planner hears of
  it). Children inherit the epic's provider/model choice and its own `test_command`. While the epic is running, a todo
  child without runs whose dependencies are done is always queued (a task moved in by hand at once, else when a round starts). `create_ticket` after `finish_round`/`complete_epic` in the same turn is refused.
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
  deleting an epic deletes its children (refused while any of their runs is active or one is an eval case); deleting a
  child wakes its planner (its dependents are blocked: "dependency deleted"); `auto_approve_children` in
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
  directory; tool paths are relative to it (absolute `/work/...` is accepted). It names the gate's test command (the
  ticket's, else the workspace's; an eval case's frozen one), the read-only paths, that git is read-only (status, diff and
  log work; the harness commits), and the budget (max turns and max minutes for the attempt).
- **Tool input errors.** `InvalidArguments` about a tool's input shape (missing or mistyped field) ends with
  `Expected input: {command: string, timeout?: number}`, derived from the tool's schema. Path errors do not.
- **Per-ticket test command.** The ticket view and New ticket dialog edit `tickets.test_command` (empty = workspace default).

## Model review (M8)

Workspace setting `model_review` (migration 009, default on). After a worker run passes the test gate, the run's own
provider and model review the change before a human sees it (not for eval case runs or planner rounds), unless the
workspace names a reviewer: `review_provider_id` / `review_model` (migration 019, `PUT /api/settings/review-provider
{provider_id, model}`, both null = the run's own; Settings → Models → Reviewer model). The reviewer's choice resolves like a
run's (a deleted provider leaves the model on the environment provider). `model_review_started.model` names it; its
tokens count in the run's totals and caps, priced at the reviewer model's rates (`recordCost` splits the usage).

M14: the planner, chat and wiki phases have the same kind of setting: `{planner,chat,wiki}_provider_id` / `_model`
(migration 022, `PUT /api/settings/<phase>-provider`, Settings → Models → Models per phase). Null falls back: the planner
and chat to the workspace default, the wiki to the model of the run it documents (as before). An epic's round 1 resolves
explicit choice → ticket → planner setting → workspace default; later rounds keep round 1's model. Worker runs and the
reviewer are unchanged (ticket/default, `review_*`). Triage keeps `triage_model`; reflection uses the run's model.

- **Reviewer.** A fresh conversation in the same worktree and sandbox, system prompt `prompts/reviewer.md` (a file, not
  versioned), tools `read_file`, `search`, `shell` and `submit_review {verdict: approve | request_changes, findings:
  [{file, line?, problem, fix}]}` (request_changes needs a finding; `InvalidArguments` otherwise), which ends its loop.
  Budget: `clamp(6 + ceil(lines / 8), 8, 25)` turns for `lines` changed lines (git numstat against base plus new
  files, minus `.polaris/` scratch), same token cap as a worker. It runs *before* the commit and inspects `git status --short` and
  `git diff` (new files are untracked: it reads them). The harness snapshots the worktree before and after the reviewer
  with `write-tree` on a throwaway index (`GIT_INDEX_FILE`), never the real one, so the reviewer's `git diff` shows the
  change; a difference is restored and logged. Its first message: ticket, base sha, the test command that passed.
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
- **Events and cost.** `model_review_started {round, budget, lines, model}` before each reviewer, `model_review {round, verdict: approve |
  request_changes | error, findings, message?}` after; reviewer tool calls and usage go to the same run's log, so the run's
  tokens and cost include review. The transcript shows both.

## Automatic splitting (M9)

Local models (27–35B) finish small tickets and fail large ones, so the harness turns work that is too large into an epic
whose planner splits it into tickets of a size the worker model can finish. Migration 010.

- **Per-child test command.** `create_ticket` takes an optional `test_command` (validated like the API: a string of ≤ 2,000
  chars, `""` = none) stored as the child's `tickets.test_command` (default: the epic's own, if it has one), which replaces the workspace command in its gate. The
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
  failed), and failures that a smaller ticket would hit too (`ProviderError`, `UnexpectedEnvironment`, `Unknown`, `SpendingCap`). The
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

- **Storage.** A git repository per project at `<dataDir>/wikis/<project_id>/`, created with an initial commit on first use,
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
  task (.polaris/wiki/<path>) before exploring the code; trust code over the wiki when they disagree.") and the index (links rewritten to `.polaris/wiki/<path>`, so a page is not
  mistaken for a code file), with a
  ` ⚠ may be stale: <files>` flag on each page whose `sources` changed in the project repo between its `verified` sha and the run's
  base sha (`git diff --name-only <verified> <base> -- <sources>`; a verified sha the repo does not have, or a source missing at it, = stale; no sources =
  fresh). Absent when the wiki has no pages. Per-run text only in the first user message (the cache prefix rule). A wiki that
  cannot be read does not stop the run (an `error` event, no section).
- **Writing: one serialized maintainer, only from approved work.** Approve (button or auto-approve of children; not an epic's)
  queues a **wiki ingest**: a run with `role = 'wiki'`, `wiki_op = 'ingest'`, `base_sha` = the merge commit, on the ticket
  (listed in its run list as "wiki", never the default transcript, not counted in its status or totals), with the approved
  run's provider and model (else the workspace default). It goes through the normal FIFO queue and concurrency slots (but stays queued
  while another wiki run of its project runs, so it never holds a slot just to wait), and `wikiSerial` makes runs of one
  project (ingest, bootstrap, lint, human edit) go strictly one at a time, so each sees the previous commit. Environment: a temp dir with `code/` (detached, read-only checkout of the merge commit) and `wiki/` (a clone of
  the wiki repo). Tools: `read_file`, `search`, `edit_file`, `delete_file` only; `code/` and `wiki/.git` (its config could run commands on the host) are protected paths, so `edit_file` and `delete_file` there fail. **No
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
  symlinks). On commit (maintainer and human edit) also: each page's `verified` is a commit of the project repo and each of its
  `sources` exists at that commit.
- **Bootstrap** (**Build wiki**, `POST …/wiki/bootstrap`): the same flow on the base branch head, task: overview, a page per main
  part, howto pages (from README/AGENTS.md/CLAUDE.md and the code), gotchas. Commit `bootstrap: <repo> at <branch> <sha8>`.
  **Refresh stale pages** (`POST …/wiki/lint`, 409 when nothing is stale): the task lists the pages stale against the base head;
  the maintainer re-verifies each against the code and fixes or deletes it. Commit `lint: re-verify N stale pages at <sha8>`. A
  lint run that finds nothing stale when it starts (an earlier run or an edit fixed it) passes with `wiki {unchanged}`.
  Bootstrap and lint runs have no ticket: they hang off one hidden ticket per project (`tickets.hidden`, number -1).
- **UI.** The **Wiki** nav entry (`web/Wiki.tsx`): the index with stale flags, a page viewer (small markdown subset, internal links)
  and editor (`PUT` with the page as opened as `base`, refused if the page changed since → mechanical lint → commit
  `edit <path> by <email>` + log entry), history with a per-commit diff, the maintainer
  runs with their transcripts, the buttons above. Transcripts show a "First message" disclosure for each conversation.
- **API** (under `/api/projects/:id/wiki`, a project of the caller's workspace, else 404; page paths are checked against the
  allowed layout and resolved with `resolveIn`): `GET …/wiki` (index, pages with stale flags, log, lint problems of HEAD,
  recent maintainer runs), `GET|PUT …/wiki/page`, `GET …/wiki/history`, `GET …/wiki/diff?sha=`, `POST …/wiki/bootstrap`,
  `POST …/wiki/lint`. Humans can edit existing
  pages only (new pages come from the maintainer; `log.md` is the harness's).
- **Demo provider.** The maintainer is recognized by its system prompt. Ingest writes `modules/demo.md` (sources = the files the
  merged diff touched, verified = the merge sha) and lists it in the index; bootstrap writes `overview.md`; lint re-verifies the first
  stale page; an existing page is updated line by line. `WIKI-NOTES` in a ticket adds a `## Wiki notes` section to the worker's reply,
  `WIKI-WRITE` makes the worker write `.polaris/wiki/x` with the shell (the gate must fail it), `WIKI-BAD` / `WIKI-FIXME` make the
  maintainer of its ingest produce an invalid wiki that it never fixes / fixes in the first fix round.
- **Not built, on purpose:** embeddings or search over the wiki (the index plus `read_file`/`rg` is enough at this size); the
  worker writing the wiki directly (only approved, linted, serialized changes land); LLM lint on a schedule (a button);
  multi-file human edits (a new page has to be linked from the index in the same commit, so humans edit existing pages).

## Chat (M13)

A side panel (Cmd/Ctrl+J, or **Ask Polaris** in the top bar) where a member talks with the project, modeled on Notion's
AI chat. The agent reads the code and the wiki, asks what is unclear and **proposes** tickets; nothing becomes a ticket
until the member files it. Migration 021, server in `server/chat.ts`, prompt `server/agent/prompts/chat.md`.

- **Data.** `chats(id, workspace_id, project_id, user_id, title, messages, …)`: private to their member, about one project; `title` is the first line of
  the first message; `messages` is the provider conversation, resumed by the next message. `chat_events(chat_id, seq,
  type, payload)`: what the panel shows, append-only (`user_message {text, context}`, the loop's `assistant_message`,
  `tool_call`, `tool_result`, `error`, `compaction`, `stuck`, `proposal {proposal_id, number}`, `turn_finished {status,
  reason}`). `chat_proposals(id, chat_id, number, payload, status open|filed|dismissed|superseded, ticket_id)`.
- **A turn** (one per user message, one at a time per chat): `runAgent` with the chat prompt, `read_file`/`search` on a
  fresh detached checkout of its project's base branch head (removed afterwards; the wiki materialized into `.polaris/wiki`), and
  the tools `list_tickets`, `read_ticket`, `propose_ticket`. The workspace's default provider and model
  (`metaProvider`); usage is background, purpose `chat` (workspace caps apply). Budget: 40 turns and 10 minutes per
  message. The first message carries the environment and the wiki index; later ones resume the conversation unchanged
  (prompt cache). A turn that fails or is stopped appends the user's message and a `[harness]` note instead of the
  partial conversation, so a dangling tool call is never resumed; a failed first turn leaves the conversation empty.
  At startup, a chat whose last event is not `turn_finished` gets one (`interrupted: the server restarted`).
- **Context.** The panel sends the page the member is on (`{ticket: key}`, `{project: id}` or `{cycle: id}`); the
  server resolves it in the caller's workspace (unknown ids are dropped) and puts a `# Context` block ahead of the message:
  a ticket's status, kind, test command, latest run and its finish reason, tracker fields, an epic's children and the
  spec (4000 chars); a project's or cycle's open tickets. `@KEY` mentions in the text (up to 5) are expanded the same way.
  The member can leave the page out with the chip's ×.
- **Proposals.** `propose_ticket {title, spec, kind?, test_command?, priority?, estimate?, replaces?}` validates like
  the planner's `create_ticket` and stores P1, P2, … per chat; `replaces: "P1"` marks an open P1 `superseded`. The panel
  renders each as a card: **File**, **File and run**, **Edit** (title, spec, test command), **Dismiss**.
  `POST /api/chats/proposals/:id/file` takes the (possibly edited) ticket fields and validates them like
  `POST /api/tickets` (shared `insertTicket`); the spec gets a last line `From chat: <title>`; `run: true` also queues
  the first run (a refused run returns the ticket with `run_error`). A proposal is filed once (409 after that, also for
  dismiss).
- **Routes** (`/api/chats`, the caller's own chats in the active workspace; others 404): `GET /[?project_id=]` (newest first, 500; one project's),
  `POST / {message, context?}` (creates the chat and starts its turn, 201), `GET /:id` (`busy`, `events`, `proposals`),
  `POST /:id/messages {message, context?}` (202; 409 while a turn runs), `POST /:id/cancel`, `DELETE /:id`,
  `POST /proposals/:id/dismiss`, and `GET /:id/stream`: SSE that replays the stored events, then live ones (de-duped by
  seq), plus `event: delta {text}` with the reply's text as it streams (never stored); stays open across turns.
- **Panel** (`web/Chat.tsx`): a third grid column (full screen under 720 px); a conversation picker; user messages,
  replies (behind the mark, accent while streaming), a "Looked at …" line for each run of read-only calls, proposal cards, errors;
  the streamed reply while a turn runs, Stop. The composer sends on Enter (Shift+Enter: new line); `@` opens a ticket
  picker (the palette's matching); **Skills** attaches skills (M17). The open state and the current chat are remembered
  in localStorage.
- **Agent page** (`/agent`, sidebar **Agent**): the same chats at full width: the conversation in a 780 px column, the
  composer at the bottom, and on a new chat three starting points (Plan a feature, Explain the code, Groom the backlog)
  that fill the composer. It has no page context; the panel stays closed there. The open chat is in the URL (`/agent/<id>`; a new one pushes its URL once created) and becomes the panel's too;
  the topbar shows its title and **New chat**.
- **One project's chats**: a new chat starts in the current project (see Projects (M15)); the sidebar, the Chats page
  and the panel's picker show only the current project's chats, and opening a chat (its URL) makes its project current.
  The panel remembers its open chat per project (localStorage).
- **History**: the sidebar lists the five most recent chats under **Agent**, then **All chats** (`/chats`): every chat,
  newest first, filtered by title, each with its last activity and Delete (its proposals go with it; filed tickets
  stay).
- **Markdown** (replies, streamed text, wiki pages; `Markdown` in `web/Wiki.tsx`): `react-markdown` + GFM (tables, task
  lists, strikethrough) with no raw HTML, after `normalizeMarkdown` (`web/markdown.ts`) evens out model dialects: `•`/`–`
  bullets, `1)` numbering, `##Heading`, a list, table or quote glued to a paragraph, CRLF, runs of blank lines, and an
  unclosed code fence (while streaming) is closed. Code blocks are left as written. Links: an href only for a parsed
  http(s) URL (new tab); internal `.md` links open the wiki page; images show their alt text (no remote fetches).
- **Demo** (`POLARIS_PROVIDER=fake`): a chat turn reads README.md, proposes a ticket titled after the message's last
  paragraph, then replies; `NO-PROPOSAL` only replies, `REPLACE-P<n>` replaces P<n>.

## Comments, notifications and the live board (M12)

Migration 019: `comments(id, ticket_id, author_id, body, created_at)` and `notifications(id, workspace_id, ticket_id,
kind, text, actor_id, created_at, read_at)`, both cascading with the ticket.

- **Comments** are notes between people; the agent does not read them (a reject note is how to steer it).
  `GET/POST /api/tickets/:id/comments` (body 1–5000 chars, 400 otherwise; 404 outside the workspace), listed oldest
  first with the author's email. The ticket page shows them under the spec.
- **Notifications** are workspace-wide rows with `kind` `review` (a worker run passed: "KEY is ready for review"),
  `failed` ("KEY failed: <reason>"; auto-approved children and tickets that got split do not notify) or `comment`
  ("<author> on KEY: <first line>"). `actor_id` is the member who caused it; `GET /api/notifications` returns the caller's
  unread ones (newest first, max 50, their own actions excluded) with the ticket's key and number;
  `POST /api/notifications/read {ids?}` marks those (or all) read. The bell in the top bar shows the count; a click opens
  the ticket and reads that one.
- **Workspace event stream.** `GET /api/events` (SSE, same session auth) sends `event: ticket {id}` whenever a ticket
  in the workspace changes (created, patched, deleted, status set, a run queued/started/finished, a planner's or
  split's or mining's new ticket) and `event: notification {id}` when one is added or read. Nothing is replayed: the
  client fetches on (re)connect, a `: keepalive` comment every 25 s keeps idle streams open. In-process fan-out
  (`subscribeWorkspace`/`touch` in `agent/events.ts`), not persisted. The SPA shares one `EventSource`
  (`useWorkspaceEvents`) between the board, the ticket page, the comments and the bell, so the 2 s polling is gone; a
  focus reload stays as the fallback.

## Tracker (M11)

The board is a Linear-style issue tracker whose workers are agents. Migration 012, server in `server/tracker.ts` (routes
under `/api`, all workspace-scoped: every id a body or a filter names is looked up in the caller's workspace, a foreign id
is a 400 in a body and matches nothing in a filter).

- **Data model.** `labels {name 1–40 chars, unique per workspace case-insensitively (Unicode, plus a NOCASE index), color
  from a fixed palette}` ↔ tickets via `ticket_labels`. On tickets: `priority` (Linear's numbers: 0 none, 1 urgent, 2 high,
  3 medium, 4 low), `assignee_id` (a workspace member: the human who owns the outcome and the review; agents run either
  way), `estimate` (1, 2, 3, 5, 8 points), `due_date`, `project_id` (required, fixed: see Projects (M15)), `milestone_id`
  and `cycle_id` (of the ticket's project) and `cycle_added_at`. `projects {key, name, description, status
  planned|started|paused|completed|canceled, lead (member), target_date, repository}` with ordered `milestones {name, target_date,
  position}`. `cycles {project, number (per project), name?, starts_at, ends_at}`: calendar days (UTC), both ends included, never
  overlapping within a project; current / upcoming / past come from the dates. `views {name, filters (the query params),
  sort, layout board|list, shared}`: a personal view is seen only by its owner, a shared one by the workspace; only the
  owner changes or deletes it. Deleting a label/milestone/cycle unsets it on its tickets. Dates are `YYYY-MM-DD`.
- **Ticket JSON** adds `priority, estimate, due_date, labels [{id, name, color}], project {id, name, key}, milestone {id, name},
  cycle {id, number, name}, assignee {id, name, email}`; `POST/PATCH /api/tickets` take `priority, estimate, due_date,
  assignee_id, project_id, milestone_id, cycle_id, label_ids` (null clears) with 400s naming the field.
- **Parent epic by hand** (`parent_id`): only a todo task without runs moves (the planner owns everything else), into an
  epic of the same project that is todo or running and has fewer than `MAX_CHILDREN` children; never out of an epic when a sibling depends on
  it, or when it is the last open child of a running epic (its planner would wait forever). Moving clears `depends_on`
  (sibling ids); a task moved into a running epic is queued at once (into a todo epic: when its next round starts).
- **Filters** on `GET /api/tickets` (AND across fields, OR within one, comma-separated): `status`, `label` + `label_mode`
  any|all, `priority`, `assignee` (ids, `me`, `none`), `project`, `milestone`, `cycle` (ids, `current` = each project's
  current cycle, `none`), `kind`,
  `parent` (id, `none`), `due_before` / `due_after` (inclusive). Unknown params are ignored (the UI keeps `layout` and
  `group` in the same query); bad values are a 400. **Sort**: `manual` (number; the default), `priority` (urgent → low, none
  last), `updated`, `created`, `due` (undated last).
- **Search** `q`: SQLite FTS5 (`tickets_fts`, external content kept by triggers, `unicode61 remove_diacritics`) over title
  + spec, every word prefix-matched and quoted (no FTS syntax gets through), ranked by bm25 with title weighted 10:1;
  `ABC-12` (a project's key) or a bare number (in any project) also matches that ticket and ranks it first. An explicit sort
  replaces relevance.
- **Projects / cycles API.** `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (with lead, milestones,
  repository and progress = total, done, points, by status), `POST /api/projects/:id/milestones`, `PUT …/milestones/order {ids}`,
  `PATCH/DELETE /api/milestones/:id`; `GET /api/cycles[?project=]`, `POST /api/cycles {project_id, …}`,
  `GET/PATCH/DELETE /api/cycles/:id` (`current?project=<id>` works as an id), each with state, progress and
  `added_after_start` (scope change: tickets that entered after it started); `POST /api/cycles/:id/move-unfinished` moves
  every ticket that is not done to the project's next cycle (the first starting after this one ends; none → 400). `GET /api/tracker` returns what the pickers need in one request (me, members, labels,
  projects with milestones, cycles); `GET /api/members`; `GET/POST/PATCH/DELETE /api/labels`, `/api/views`.
- **UI.** Board and **List** layouts share a filter bar: search (`/` focuses it; Enter on a key opens the ticket), a chip
  per active filter (click to edit, × to remove, labels toggle any/all), **+ Filter** menu, Clear, sort, layout, group
  (list: status, priority, project, assignee, cycle, label), **Save view**. All of it lives in the URL query, so a view is
  a bookmarkable link, and back/forward step through filter changes (typing in search replaces the entry instead).
  Cards and dense list rows show priority, labels, due date, assignee (initials); rows also key, status, parent epic,
  project, cycle. The ticket page has a **properties sidebar** (status, priority, assignee, labels with "create label",
  project, milestone, cycle, estimate, due date, parent epic) with shortcuts `s` `p` `a` `l`; run controls and transcript
  are unchanged. **Command palette** (Cmd/Ctrl+K): tickets by key prefix or title, Create ticket, Go to pages (each
  project's board, cycles, current cycle, wiki). Pages: see Projects (M15) for the sidebar; a project's Cycles
  (current/upcoming/past + cycle page with progress, scope change, Move unfinished) and Overview (progress, milestones,
  repository); Views; labels are managed in Settings. New ticket dialog takes every field (prefilled with the project or
  cycle whose page is open; the project is required). Native selects and date inputs
  only: keyboard-friendly, both themes, phone width.
- **Agents.** The first user message of a worker (`# Task`) and of a planner round (`# Epic`) has a header line under the
  title: `Priority: Urgent · Labels: bug, ui · Milestone: v1 · Due: 2026-11-30` (only what is set; the project is the repo
  the agent is in, so it is not repeated; eval case runs keep
  their frozen text). The run queue starts ticket work (worker and planner runs; not eval cases or wiki runs) by the
  ticket's priority, urgent first, then FIFO; no priority comes after low. Planner `create_ticket` takes optional `labels`
  (names, matched case-insensitively, unknown ones created), `priority` (default: the epic's) and `estimate`; children
  inherit the epic's project, milestone and cycle.
- **Not built, on purpose:** comments (separate work), custom workflow states (statuses are the harness's run states),
  drag-and-drop ordering (manual order = ticket number), sub-issue trees beyond epics, notifications, project/cycle
  history charts (progress is computed live), and per-viewer time zones for cycles (UTC calendar days).

## Projects (M15)

A workspace holds projects; a **project is one git repository** with its own board, cycles, wiki and ticket keys
(Linear's team). Code: `server/tracker.ts` (routes), `projectSettings()` in `server/runs.ts`.

- **Data.** `projects {key, name, …, repo_path, base_branch, setup_command, test_command, protected_paths, image}`. The key
  (2-5 capitals or digits, a capital first, unique in the workspace) prefixes ticket keys: `tickets.number` counts per
  project (`KEY-12`); `ticketKey()` reads the project's key, so renaming a key renames its tickets. Repository fields are
  validated like the old settings (`inspectRepo`: the root of a repo with commits, the base branch exists, empty = its
  current branch; image reference; protected paths relative) on create and whenever given; `null` resets a command to
  `PROJECT_DEFAULTS`.
- **What stays workspace-wide** (`workspace_settings`, `GET/PUT /api/settings`): models (default, reviewer, per phase),
  model review, auto-approve, auto-split + triage, child size hint, the wiki toggle, budgets, compaction, spending caps;
  providers, labels, views, lessons, prompts, evals, failure mining, usage, notifications. A run's settings are
  `projectSettings(project)`: the workspace's plus its project's repository.
- **Tickets** name their project on create (`project_id` required) and stay there: their branches live in that repo, so
  `PATCH` refuses another project. Milestone, cycle and parent epic must be of the same project; planner children, Split
  epics and chat proposals land in the epic's, ticket's or chat's project; mined tickets in the project of the newest
  example run.
- **Cycles** belong to a project (numbered and non-overlapping per project). **Wiki**: one per project at
  `<dataDir>/wikis/<project_id>/`, under `/api/projects/:id/wiki`; maintainer runs are serialized per project.
  **Chats** belong to a project (`POST /api/chats {…, project_id}`): its checkout, wiki and tickets (`list_tickets`); a
  bare `@12` means the chat's project, `@KEY-12` any project.
- **Delete** only an empty project (no tickets, no run in flight); its milestones, cycles, chats and wiki go with it, the
  repository is never touched.
- **Current project.** Each member works in one project per workspace (`current_projects`, migration 005; `current` in
  `GET /api/tracker`, `PUT /api/me/project {project_id}`). Creating a project makes it its maker's current one; opening
  any of a project's pages or tickets does too. It is the default for `/` and New ticket, scopes the chats (a new chat
  starts in it; the chat lists show its chats), and its sidebar group is the open one. The sidebar's header is the **project switcher**: the current project over the workspace's
  name; its menu lists the projects (their boards) and New project (`/projects?new`).
- **UI.** Sidebar: the project switcher, My issues, Reviews (count), then Workspace (Projects, All issues, Views, More → Usage, Learning), then
  Your projects, each a collapsible group (Board, Cycles + Current cycle, Wiki, Overview), Settings at the bottom. Routes:
  `/my-issues`, `/reviews`, `/issues`, `/projects`, `/p/KEY` (board), `/p/KEY/cycles[/id|current]`, `/p/KEY/wiki`,
  `/p/KEY/overview` (fields, milestones, repository, delete), `/t/KEY-12`; `/` opens the current project's board (none:
  Projects, to create one). A board's filter bar keeps its project as a fixed scope (a view saved from it includes it).
  Settings tabs: Models, Automation, Limits, Labels, Appearance (the caller's own: palette and mode, `user_preferences`,
  `GET/PUT /api/me/preferences {palette?, mode?}` merging like settings; palettes and tokens: DESIGN.md).
- **CLI.** `npm run seed-tasks -- --workspace <slug> --project <KEY>`; `npm run agent -- --task` files into a `CLI`
  project of the `cli` workspace. The MCP `create_ticket` takes `project` (a key; optional when the workspace has one).

## Guardrails

- `tests/` and `evals/` are read-only to agents (harness rejects writes), and so is `.polaris/wiki` (M10). Any `.git` path is
  never writable by agent tools, path checks are case-insensitive on a case-insensitive filesystem, and the worktree's `.git`
  file is mounted read-only in the sandbox.
- Sandbox containers run as a non-root user (`--user`: the host user's uid:gid on Linux, so worktree files stay theirs;
  the image's `polaris` 1000:1000 under Docker Desktop, which maps bind-mount ownership), with `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--pids-limit 512`, and the project's `sandbox_cpus` / `sandbox_memory_gb` (default 4 and
  4 GB, 1–32 and 1–64; `node --test` runs one test file per CPU, so two CPUs ran a large suite serially). The built-in image is built with that uid:gid,
  labelled `polaris.image.version`, and rebuilt when the label is missing or older than `IMAGE_VERSION` (bump it with the
  Dockerfile); the shared npm cache volume is chowned to the sandbox user once per harness start if it isn't theirs.
- Host git never trusts the worktree: hooks and fsmonitor are off, and worktrees the harness created are addressed by the git
  dir it recorded at creation (`--git-dir`/`--work-tree`), not by their `.git` file. Submodules are ignored, and a nested
  repository the agent made (a directory with its own `.git`) fails the gate and is never committed: host git would read its
  config, filters included. Harness writes into the worktree
  (`.polaris/outputs`, `.polaris/history`) refuse symlinks. The sandbox image setting must be a plain docker image reference.
- Server surface (single trusted user by default): the API binds `HOST` (default `127.0.0.1`), the ChatGPT OAuth callback
  binds `127.0.0.1`; sign-up closes once the first account exists unless `POLARIS_OPEN_SIGNUP=1`; a cookie-authenticated
  non-GET `/api/*` request needs a trusted `Origin` (Better Auth's trusted origins or the request's own host) or
  `Sec-Fetch-Site: same-origin`, else 403 `forbidden_origin` (no Origin and no cookie passes: CLI, curl). Changing a
  provider's `base_url` clears its stored key or OAuth tokens unless a new key comes with it. Provider calls follow the
  egress policy (Providers): https off-network, no metadata addresses, no redirects, scrubbed errors, TLS checks on.
- The harness never edits its running code; changes land through the review queue.
- Every run has a token budget; every passing run is a commit on its own branch.

## Conventions

- Node ≥ 26 runs `.ts` directly (type stripping): erasable syntax only, imports use `.ts` extensions.
- Tests: `node:test` in `test/`, in-memory DB (`npm test`). Each non-trivial piece leaves one test. Shared helpers
  (sign-up, workspace, temp repo, mock provider, waits) live in `test/helpers.ts`, e2e ones in `e2e/helpers.ts`.
- One definition per shared rule: statuses, kinds, budgets, the command timeout and `OWN_RUNS` are exported once; the
  ticket key is `ticketKey()` (SQL); output is cut with `truncate()`; settings defaults are `SETTINGS_DEFAULTS`
  (`server/runs.ts`); worker, eval, planner and wiki runs share `pipeline()`.
- `PUT /api/settings` merges: an omitted field keeps its value, `null` resets it to the default, toggles accept
  `true`/`1`/`"on"` (what GET returns round-trips).
- API errors are `{error}` JSON: route checks return their own status; thrown `Invalid`/`AgentError` are 400, `MergeError`
  409, anything else 500 (logged) via `app.onError`.
- Hot lookups are indexed (migration 015): child and split subqueries, project/milestone/cycle progress, the queue and
  restart recovery, eval runs.
- Deps pinned via lockfile; install with `npm install --before <date ≥ 2 weeks ago>`.


## Provider-independent accounting and ChatGPT plan access

Migration 020 adds append-only `usage_ledger`: a unique request-attempt ID, workspace, optional ticket/run,
provider/model/billing snapshots, purpose, execution/background category, timestamps, outcome, completeness,
uncached input/output/cache read/cache write, and optional estimated USD. Normalized counts are non-negative
provider-reported integers; reasoning is already part of output. The session token-budget formula is unchanged.
Transport retries each emit one measurement. Failed/cancelled streams retain known partial counts; absence of
usage is `unavailable`, not measured zero. Run projections are updated atomically only for new execution records.
Reflections stay linked to their source run but never inflate its turns or execution totals. Proposals/mining/tests
have workspace background usage. Triage records unavailable usage when its endpoint reports none.

The ledger drives Usage and cap checks. `/api/usage` retains the legacy fields and adds uncached input,
cache-write and total tokens, execution/background summaries, provider/model/billing and purpose breakdowns,
request completeness and a historical coverage boundary. `tokens_in` still includes cache writes for compatibility.
Run and ticket responses include usage summaries. Workspace `usage` events refresh the dashboard. Historical
usage/reflection events and surviving run summaries are imported idempotently with source-derived IDs; missing
old background data is never invented. Eval scoring remains execution-only with its established tie-break.

Subscription providers use the public SIWC dynamic client flow, never Codex's client ID or private backend. The
installation host ID persists in `POLARIS_DATA_DIR/openai-host-id` (owner-only creation). A version-2 encrypted
credential envelope retains issued client ID, validated identity, host ID, scopes, ID token and rotating credentials.
Sign-in uses PKCE, state and nonce with a `127.0.0.1` callback; signature/issuer/audience/expiry/nonce are checked
using JWKS. Returning authorization verifies the same account. Refreshes serialize per registration and use a
conditional write so logout/reconnection wins over in-flight renewal. Signout retains registration and attempts
revocation. Legacy credentials require reconnect. Multiple accounts use separate providers.

ChatGPT catalog discovery reads account-visible model slugs/display names; there is no static catalog fallback.
Subscription requests use `instructions`, a full input history, `store:false`, `stream:true`, and Polaris function
tools under the `polaris` namespace. Namespace metadata and encrypted reasoning survive history replay. Unsupported
subscription fields/hosted tools are omitted; only `response.completed` permits results/tool execution. Errors
never trigger billing/provider fallback. A plan usage-limit error pauses that registration until an explicit Test
or reconnect. Test completes a tool/result round trip. Provider responses include safe account/permission state;
Continue with ChatGPT, a first-use confirmation, Disconnect, and Manage usage expose the lifecycle in Settings.
Local inference has no provider bill; subscription inference is labelled ChatGPT plan; unknown API prices stay unknown.

Sources: https://developers.openai.com/siwc/token-sharing-open-source (registration, sessions, models, limitations).
