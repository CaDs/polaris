# Complexity ladder

Seven tickets of increasing size, each run by Polaris end to end (real model, real Docker sandbox, test gate, model review)
against the same small target repo, then graded independently. It answers "did this build of Polaris get better or worse
at finishing work with this model?".

The target (`target/`) is a frozen snapshot of Polaris's predecessor (`agent-harness`, ~80 files: Hono + node:sqlite API,
React board, node:test suite). Each level adds a locked acceptance test the agent must make pass without breaking the rest.

| level | ticket | answer key |
|---|---|---|
| L1 | Filter the ticket list by status (`GET /api/tickets?status=`) | 1 file, 6 lines |
| L2 | Per-ticket test command overriding the workspace's (migration + gate) | 3 files, 26 lines |
| L3 | Configurable turn budget `max_turns` as a workspace setting | 4 files, 27 lines |
| L4 | Webhooks on ticket status changes | 5 files, 66 lines |
| L5 | Ticket labels, end to end (API, planner, board) | 6 files, 89 lines |
| L6 | Personal API tokens (scopes, expiry, bearer auth) | 7 files, 173 lines |
| L7 | Ticket comments, activity feed and live SSE updates | 11 files, 305 lines |

## Layout

- `tickets.json`: the seven tickets (title, spec, locked test files, answer-key size).
- `target/`: the target repo template. `levels/L<n>.patch` turns it into level n's starting point (adds the locked
  test; for L2, whose test is already in the template, removes the code it asks for).
- `keys/L<n>.patch`: the reference solution. Used only by `--check` and the grader's unit test; never in a target repo.
- `run.ts`: the runner and grader. `report.ts`: side-by-side table of results files. `results/`: where results go (none committed yet).

## Run

```sh
npm run bench -- --model qwen3.8:27b-mlx --levels L1,L2,L3,L4,L5,L6,L7 --runs 1 --out bench/results/$(git rev-parse --short HEAD).jsonl
npm run bench -- --check                  # no model: every level's base fails the grader, base + key passes (~15 min)
node bench/report.ts bench/results/a.jsonl bench/results/b.jsonl
```

Flags: `--model` (required), `--provider` (`ollama` by default; `anthropic`, `openai`, `openrouter` or `litellm`, with the
key in `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `LITELLM_API_KEY` or the variable `--api-key-env`
names; `--base-url` for LiteLLM or a non-default endpoint), `--levels` (default all), `--runs N` (repeat each level), `--split 0|1`
(auto-split into an epic, default 0), `--wiki 0|1` (default 0), `--max-turns` / `--max-minutes` (per attempt, default
120 / 60), `--max-hours` (wall clock per level, default 3; a slow local model on L7 needs more), `--out`, `--tag` (default: the server checkout's short sha), `--server-dir <checkout>` (run another build's
server, e.g. a `git worktree` of an older commit), `--ollama <url>`.

The ChatGPT plan can't be benchmarked here: its sign-in lives in an instance's database and its refresh tokens rotate, so
the bench server can't hold a copy without logging that instance out.

Needs Docker, and Ollama for the default provider. A level takes 5 to 60 minutes; one model call at a time (`POLARIS_CONCURRENCY=1`).

## What happens per run

1. `run.ts` starts `node <server-dir>/server/index.ts` once, on a free port, with a temp `DB_PATH` / `POLARIS_DATA_DIR`
   and `POLARIS_OPEN_SIGNUP=1`.
2. Per level and run: a fresh target repo (template + level patch, one commit on `main`), a new user and workspace,
   project for the repo (setup `npm ci`, test `npm test`, `test/,e2e/` read-only), settings (model review on, children auto-approved), an Ollama
   provider as the default with `--model`, then the ticket is created and run.
3. It polls until the ticket, or the Split epic it escalated to and that epic's children, has nothing todo or running.
4. Grading, only when Polaris passed it (`review` or `done`): the result (a task's review branch; an epic's merged `main`)
   is exported to a temp dir, the locked tests are restored from a fresh copy of the level, and `npm ci && npm test` runs
   in a throwaway `polaris-sandbox:1` container. `pass` = exit 0. The target suite has a few timing-sensitive tests, so a
   failure gets one rerun; a pass on the rerun is recorded as `flaky`.
5. One JSON line is appended to `--out`; a table is printed at the end. The temp dir (DB, repos, server log) is kept.

## Reading results

Each line: `pass` (grader), `harness_pass` (Polaris's own verdict), `status`, `chain` (ticket keys incl. a split),
`runs` / `worker_runs` / `planner_runs`, `turns`, `tool_calls`, `tool_errors`, `compactions`, `input` / `output` /
`cache_read` tokens, `secs` (summed run time) and `wall_secs`, `review_rounds` / `review` (verdicts), `diff_lines` vs
`key_lines`, `budget`, `home` (temp dir with the DB for digging into events), and `grade` (test output tail when the
grader failed a result Polaris passed: that is a gate bug, or a flaky test).

`harness_pass` without `pass` points at the harness; neither points at the model, the budget, or the harness: look at the
run's events in `<home>/polaris.db` (`SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq`).

## Fairness

- Fresh repo, user and workspace per run: no wiki, lessons or merged work carries over between levels or runs.
- Locked tests can't be edited: `test/` and `e2e/` are protected paths (read-only in the sandbox, edits fail the run),
  and the grader restores them anyway before it runs.
- Answer keys never reach the target repo or the agent; the spec text is the only description of the task.
- Same budget (turns, minutes), settings and target for every model and build; only `--model` / `--server-dir` change.
