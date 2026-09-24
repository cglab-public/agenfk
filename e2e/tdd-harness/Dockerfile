# The TDD harness (npm run e2e:tdd): this build's server and CLI, in Linux,
# driving a throwaway sample project through the flow. Built from the repo
# root; better-sqlite3 is native, so dependencies install here, not on the host.
# The full (not -slim) image ships git, python3, make and g++: nothing to
# apt-get, so a slow Debian mirror cannot stall the build.
FROM node:22-bookworm
RUN git config --global user.email harness@agenfk.test \
 && git config --global user.name "AgEnFK harness" \
 && git config --global init.defaultBranch main
WORKDIR /agenfk
# Manifests first, so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/ui/package.json packages/ui/
COPY packages/flow-editor/package.json packages/flow-editor/
COPY packages/create/package.json packages/create/
COPY packages/hub/package.json packages/hub/
COPY packages/hub-ui/package.json packages/hub-ui/
COPY packages/desktop/package.json packages/desktop/
# Only what the harness runs: no UI, hub or Electron.
RUN npm ci --no-audit --no-fund --include-workspace-root \
      -w packages/core -w packages/storage-sqlite -w packages/telemetry -w packages/server -w packages/cli
COPY packages/core packages/core
COPY packages/storage-sqlite packages/storage-sqlite
COPY packages/telemetry packages/telemetry
COPY packages/server packages/server
COPY packages/cli packages/cli
COPY bin bin
RUN npm run build -w packages/core -w packages/storage-sqlite -w packages/telemetry \
 && npm run build -w packages/server -w packages/cli
COPY e2e e2e
ENTRYPOINT ["/agenfk/e2e/tdd-harness/entrypoint.sh"]
