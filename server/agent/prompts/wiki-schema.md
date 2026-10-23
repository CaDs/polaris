# Wiki schema

This wiki is the project's memory. Its core is `memory/`: the decisions, rules and gotchas people approved, so agents
make choices consistent with them. Around it, optional pages map the code; an LLM maintainer builds or refreshes them
on request, and humans can edit any page. Code is the source of truth for what the code does: when a page and the code
disagree, the page is wrong.

## Files

- `SCHEMA.md` (this file): the conventions.
- `index.md`: one line per content page, `- [Title](path.md) — one-line summary`. Every agent reads it first, so it
  stays under 6000 characters. Every content page is linked here, and every link points at an existing page.
- `log.md`: append-only history, written by the harness (`## [YYYY-MM-DD] ingest | KEY Title (merge sha8)`). Never edit it.
- `overview.md`: architecture map: what the project is, the main parts, how they fit, where to start reading.
- `modules/<name>.md`: one page per main part (a directory, a subsystem, a layer): what it does, key files with
  `file:line` pointers, invariants, how it talks to the other parts.
- `howto/<task>.md`: how to do a common change here (add an endpoint, add a migration, run one test, release).
- `gotchas.md`: non-obvious facts that cost time: traps, naming oddities, things that look wrong but are intended.
- `memory/NNNN-slug.md`: one approved decision, rule or gotcha each, written when a ticket is approved (from a proposal
  the approver confirmed) or added by a person. Not listed in `index.md`: agents get the active entries in their task.

Nothing else is allowed: root `.md` files, `modules/*.md`, `howto/*.md` and `memory/NNNN-slug.md` only.

## Memory entries

```
---
title: The decision, rule or gotcha as one sentence
kind: decision | rule | gotcha
status: active | superseded
superseded_by: memory/NNNN-slug.md   (only when superseded)
source: POL-12 (the approved ticket) or the email of the person who added it
date: YYYY-MM-DD
---
What was decided, why, and what was turned down.
```

An entry is never rewritten to say something else: a new entry supersedes it, and the old one stays for the record with
`status: superseded`. At most 3000 characters.

## Content pages

Every content page (all `.md` files except SCHEMA, index and log) starts with frontmatter:

```
---
title: Short page title
sources: [server/runs.ts, server/git.ts]
verified: <full commit sha of the project repo the page was checked against>
updated: YYYY-MM-DD
---
```

- `sources`: repo-relative files or directories the page describes; each must exist at `verified`. The harness flags the
  page as possibly stale when any of them changed since `verified`. List the files that matter, not the whole tree.
- `verified`: the project commit at which you checked the page against the code. Set it to the commit named in your
  task whenever you write or re-check a page.
- A page is at most 3500 characters. A longer page is split into several linked pages.

## Rules

- Summarize; do not copy code. Point at code with `path:line` and say what is there and why.
- Record what is not obvious from reading the code: intent, invariants, traps, where things live.
- One fact in one place. Link to other pages with relative links instead of repeating them.
- Do not record secrets, credentials or personal data.
- Delete or rewrite wrong or outdated statements; do not keep history in pages (the wiki's git log has it).
