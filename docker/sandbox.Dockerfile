# Per-run sandbox: built automatically as polaris-sandbox:1 by server/sandbox.ts, which labels it polaris.image.version
# and rebuilds when that label is missing or older than its IMAGE_VERSION (bump it when this file changes).
FROM node:26-bookworm-slim
ARG UID=1000
ARG GID=1000
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
# Commands run as `polaris` (the harness passes --user UID:GID; on Linux the host user's, so /work files stay theirs).
# The base image's `node` user holds uid 1000: replace it.
RUN userdel -r node \
 && groupadd -o -g "$GID" polaris \
 && useradd -o -m -u "$UID" -g "$GID" -s /bin/sh polaris \
 && mkdir /home/polaris/.npm && chown "$UID:$GID" /home/polaris/.npm
ENV HOME=/home/polaris
# Docker Desktop shows bind-mounted files as the host user's (e.g. 501), not polaris: git would refuse /work as unsafe.
RUN git config --system safe.directory '*'
