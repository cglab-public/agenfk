# syntax=docker/dockerfile:1.7
#
# AgEnFK Corporate Hub — production image.
#
# Build context must be the AGENFK MONOREPO ROOT (not packages/hub), because
# the build stage compiles @agenfk/core, @agenfk/hub, and @agenfk/hub-ui
# from source against the workspace lockfile:
#
#     docker build -t agenfk-hub:latest -f packages/hub/Dockerfile .
#
# Runtime requires:
#   AGENFK_HUB_SECRET_KEY       32 bytes (64 hex / 44 base64) — encrypts OAuth secrets
#   AGENFK_HUB_SESSION_SECRET   HMAC key for session JWTs
#
# Optional:
#   AGENFK_HUB_INITIAL_ADMIN_EMAIL / _PASSWORD   first-run bootstrap
#   AGENFK_HUB_PORT             default 4000
#   AGENFK_HUB_ORG_ID           default "default"
#   AGENFK_HUB_DB_PATH          default /data/hub.sqlite
#

# ── builder ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

# Manifests first so dependency-install layer caches across source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/flow-editor/package.json packages/flow-editor/
COPY packages/create/package.json packages/create/
COPY packages/hub/package.json packages/hub/
COPY packages/hub-ui/package.json packages/hub-ui/

RUN npm ci --no-audit --no-fund

COPY packages/core packages/core
COPY packages/flow-editor packages/flow-editor
COPY packages/hub packages/hub
COPY packages/hub-ui packages/hub-ui

RUN npm run build -w packages/core \
 && npm run build -w packages/hub \
 && npm run build -w packages/hub-ui

# Bundle the SPA next to the hub bundle so server.ts finds it via ../public.
RUN mkdir -p packages/hub/public \
 && cp -R packages/hub-ui/dist/. packages/hub/public/

# Trim devDependencies for the runtime layer.
RUN npm prune --omit=dev --workspaces --include-workspace-root \
 || npm prune --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini for proper signal handling (Ctrl-C, SIGTERM from orchestrators).
RUN apk add --no-cache tini wget

# Run as a non-root user.
RUN addgroup -S agenfk && adduser -S -G agenfk -h /app agenfk

WORKDIR /app
ENV NODE_ENV=production \
    AGENFK_HUB_DB_PATH=/data/hub.sqlite \
    AGENFK_HUB_PORT=4000

# Carry only what's needed at runtime: built packages + production node_modules.
COPY --from=builder --chown=agenfk:agenfk /repo/node_modules                /app/node_modules
COPY --from=builder --chown=agenfk:agenfk /repo/packages/core/dist          /app/packages/core/dist
COPY --from=builder --chown=agenfk:agenfk /repo/packages/core/package.json  /app/packages/core/package.json
COPY --from=builder --chown=agenfk:agenfk /repo/packages/hub/dist           /app/packages/hub/dist
COPY --from=builder --chown=agenfk:agenfk /repo/packages/hub/public         /app/packages/hub/public
COPY --from=builder --chown=agenfk:agenfk /repo/packages/hub/package.json   /app/packages/hub/package.json

# Persistent storage for SQLite + WAL.
RUN mkdir -p /data && chown -R agenfk:agenfk /data
VOLUME ["/data"]

USER agenfk
EXPOSE 4000

# Liveness — fails the container after 3 missed pings so orchestrators restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${AGENFK_HUB_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/packages/hub/dist/bin.js"]
