# syntax=docker/dockerfile:1.7
#
# AgEnFK Airlock base image (CGLAB-696): what an Airlock session's smolvm
# machine is made from, unless the org's policy or the repository names
# another. Published per release, multi-arch, to
# ghcr.io/cglab-public/agenfk-airlock-base:<version> (airlock-image.yml).
#
# Build context is the AGENFK MONOREPO ROOT: the agenfk CLI in the image is
# built from this checkout, so it is the version the tag names.
#
#     docker build -f airlock-image/Dockerfile -t agenfk-airlock-base:dev .
#
# Behind a TLS-inspecting proxy, hand its root CA to the steps that download,
# as a build secret (never written into a layer):
#
#     docker build --secret id=extra-ca,src=$NODE_EXTRA_CA_CERTS ...
#
# The session runs as the host user's uid, which has no passwd entry here:
# everything it runs is on PATH and readable by any user.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── the agenfk CLI, packed from source ──────────────────────────────────────
FROM ${NODE_IMAGE} AS cli
WORKDIR /repo
# The whole checkout (.dockerignore drops node_modules and dist): npm ci needs
# every workspace's manifest, and a list of them would miss the next package.
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts
RUN npm run build -w packages/core -w packages/telemetry -w packages/cli \
 && mkdir /packs \
 && npm pack -w packages/core -w packages/telemetry -w packages/cli --pack-destination /packs \
 && cd /packs && mv agenfk-core-*.tgz core.tgz && mv agenfk-telemetry-*.tgz telemetry.tgz && mv agenfk-cli-*.tgz cli.tgz

# ── the image ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ARG PI_VERSION=1.4.0
ARG MONGOSH_VERSION=2.5.8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client \
      postgresql-client default-mysql-client redis-tools \
      python3 python3-venv python3-pip \
      procps util-linux mount \
 && rm -rf /var/lib/apt/lists/*

# pnpm and yarn through corepack, fetched now into a shared home: the session's
# user has no home of its own to fetch them into. pnpm 10: from 11 on, pnpm
# fetches a native binary into the user's own cache on its first run. The home
# is writable by everyone: a project whose packageManager pins another version
# has corepack fetch it there, as the session's user (the machine's only one).
ENV COREPACK_HOME=/usr/local/share/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra-ca > /tmp/build-ca.pem; export CURL_CA_BUNDLE=/tmp/build-ca.pem NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
 && corepack enable \
 && corepack prepare pnpm@10 --activate \
 && corepack prepare yarn@1 --activate \
 && chmod -R a+rwX "$COREPACK_HOME" && rm -f /tmp/build-ca.pem

RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra-ca > /tmp/build-ca.pem; export CURL_CA_BUNDLE=/tmp/build-ca.pem NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
 && npm install -g --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force && rm -f /tmp/build-ca.pem

# mongosh from MongoDB's own build: the npm package compiles native modules.
ARG TARGETARCH
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra-ca > /tmp/build-ca.pem; export CURL_CA_BUNDLE=/tmp/build-ca.pem NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
 && case "$TARGETARCH" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "no mongosh for $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://downloads.mongodb.com/compass/mongosh-${MONGOSH_VERSION}-linux-${a}.tgz" | tar -xz -C /tmp \
 && install -m 755 /tmp/mongosh-${MONGOSH_VERSION}-linux-${a}/bin/mongosh /usr/local/bin/mongosh \
 && rm -rf /tmp/mongosh-* /tmp/build-ca.pem

# The CLI and its workspace siblings, from their packs: @agenfk/* are not on npm.
COPY --from=cli /packs /tmp/packs
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra-ca > /tmp/build-ca.pem; export CURL_CA_BUNDLE=/tmp/build-ca.pem NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
 && mkdir -p /opt/agenfk && cd /opt/agenfk \
 && printf '%s' '{"private":true,"dependencies":{"@agenfk/cli":"file:/tmp/packs/cli.tgz","@agenfk/core":"file:/tmp/packs/core.tgz","@agenfk/telemetry":"file:/tmp/packs/telemetry.tgz"},"overrides":{"@agenfk/core":"file:/tmp/packs/core.tgz","@agenfk/telemetry":"file:/tmp/packs/telemetry.tgz"}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
 && ln -s /opt/agenfk/node_modules/@agenfk/cli/bin/agenfk.js /usr/local/bin/agenfk \
 && rm -rf /tmp/packs /tmp/build-ca.pem && npm cache clean --force

LABEL org.opencontainers.image.source="https://github.com/cglab-public/agenfk" \
      org.opencontainers.image.description="AgEnFK Airlock base image: the smolvm machine an Airlock session runs in"
