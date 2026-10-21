# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue. I aim to reply within a week.

Polaris runs coding agents against your repositories; reports about sandbox escapes, authentication, and agents reaching
outside their worktree are the most valuable.

## Provider keys

- Stored encrypted (AES-256-GCM, `POLARIS_SECRET_KEY`), never returned by the API (only the last 4 characters of keys of
  16+ characters), never put in a URL, and scrubbed from provider error messages before they are stored or shown.
- Sent only over the egress policy in `server/egress.ts`: https unless the endpoint is on this machine or a private
  network, never to link-local/metadata addresses, never across a redirect, with TLS certificate checks on (the server
  refuses to start with `NODE_TLS_REJECT_UNAUTHORIZED=0`). OpenRouter keys only ever go to `openrouter.ai`.
- Changing a provider's base URL drops its stored key unless a new one comes with it.
- Known limit: the address checks run when a URL is saved and again (cached a minute) before requests; a DNS answer that
  changes in between is not caught. Keep `HOST` on loopback, or put Polaris behind an authenticating proxy.

## Repositories

- A project's `repo_path` is refused when it is inside the Polaris data dir (where agent-written worktrees live), when its
  owner is not the server's user, or, with `POLARIS_REPO_ROOTS` set (colon-separated), when it is outside those directories.
  Set it on a shared instance: any member can register a project.
- Known limit: host git runs in a registered repository, so its own `.git/config` and `.gitattributes` (smudge/clean filters,
  `core.sshCommand`, ...) run on the host. Only register repositories you trust; the system config is not read.
