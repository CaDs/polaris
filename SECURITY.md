# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue. I aim to reply within a week.

Polaris runs coding agents against your repositories; reports about sandbox escapes, authentication, and agents reaching
outside their worktree are the most valuable.

## Provider keys

- Stored encrypted (AES-256-GCM, `POLARIS_SECRET_KEY`, bound to their database row), never returned by the API (only the last 4 characters of keys of
  16+ characters), never put in a URL, and scrubbed from provider error messages before they are stored or shown.
- Sent only over the egress policy in `server/egress.ts`: https unless the endpoint is on this machine or a private
  network, never to link-local/metadata addresses, never across a redirect, with TLS certificate checks on (the server
  refuses to start with `NODE_TLS_REJECT_UNAUTHORIZED=0`). OpenRouter keys only ever go to `openrouter.ai`.
- Changing a provider's base URL drops its stored key unless a new one comes with it.
- The address checks run on the address the socket actually dials (a custom `lookup` in `providerFetch`), so a DNS answer
  that changes between a check and the connection cannot reach a blocked address. Keep `HOST` on loopback, or put Polaris
  behind an authenticating proxy.
