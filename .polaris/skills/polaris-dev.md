---
name: polaris-dev
description: How to work on the Polaris repository itself — running one test file, import rules, where defaults live, what the sandbox lacks
phases: worker, planner, reviewer
---

# Working on Polaris

**Run one test file** (the full suite is slow; the harness runs it after you finish):

```sh
DB_PATH=:memory: POLARIS_OPEN_SIGNUP=1 POLARIS_SECRET_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
  BETTER_AUTH_URL=http://localhost:3000 BETTER_AUTH_SECRET=test-only-auth-secret-not-used-anywhere-else \
  node --test test/<file>.test.ts
```

Add `--test-name-pattern='<part of a test name>'` for one test. `npm run typecheck` checks the whole project.

**Code rules**
- Node runs TypeScript directly (type stripping): imports name the file with its `.ts` extension
  (`import { db } from "./db.ts"`), and only erasable syntax works (no enums, no parameter properties, no namespaces).
- Workspace settings and their defaults: `SETTINGS_DEFAULTS` in `server/runs.ts`, limits in `LIMITS` in `server/app.ts`.
  Project settings: `PROJECT_DEFAULTS` and `projectBody` in `server/tracker.ts`. Schema changes are a new numbered file in
  `server/migrations/`.
- `SPEC.md` is the design the code follows: when you change a rule, change its sentence there too.
- Every non-trivial change gets a `node:test` next to the existing file for that area in `test/`.

**The sandbox has no Docker, no browser and no Playwright.** Don't install them. `test/docker.test.ts` skips itself
without Docker; the e2e suite (`e2e/`, Playwright) can't run here. Say so in your reply when a ticket asks for them.
