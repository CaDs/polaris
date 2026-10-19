# Per-run sandbox: built automatically as agent-harness-sandbox:1 on first use (server/sandbox.ts).
FROM node:26-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
