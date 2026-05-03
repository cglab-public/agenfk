# syntax=docker/dockerfile:1.7

# ── builder ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

# Copy the entire monorepo manifest set so workspace resolution works.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/create/package.json packages/create/
COPY packages/hub/package.json packages/hub/
COPY packages/hub-ui/package.json packages/hub-ui/

RUN npm ci --no-audit --no-fund

COPY packages/core packages/core
COPY packages/hub packages/hub
COPY packages/hub-ui packages/hub-ui

RUN npm run build -w packages/core
RUN npm run build -w packages/hub
RUN npm run build -w packages/hub-ui

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Workspace symlinks resolve via the same node_modules layout the builder used.
COPY --from=builder /repo/node_modules /app/node_modules
COPY --from=builder /repo/packages /app/packages

# Bundle the built UI alongside the hub bundle so server.ts finds it via the
# `../public` candidate path.
RUN mkdir -p /app/packages/hub/public && cp -R /app/packages/hub-ui/dist/. /app/packages/hub/public/

ENV AGENFK_HUB_DB_PATH=/data/hub.sqlite
VOLUME ["/data"]

# Required env at runtime:
#   AGENFK_HUB_SECRET_KEY        32-byte hex/base64 (encrypts OAuth secrets)
#   AGENFK_HUB_SESSION_SECRET    JWT signing key
# Optional:
#   AGENFK_HUB_INITIAL_ADMIN_EMAIL / _PASSWORD   first-run bootstrap
#   AGENFK_HUB_PORT (default 4000)
#   AGENFK_HUB_ORG_ID (default 'default')

EXPOSE 4000
ENTRYPOINT ["node", "/app/packages/hub/dist/bin.js"]
