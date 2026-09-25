# The TDD harness (npm run e2e:tdd): this build's server and CLI, in Linux,
# driving a throwaway sample project through the flow. Built from the repo
# root; better-sqlite3 is native, so dependencies install here, not on the host.
# The full (not -slim) image ships git, python3, make and g++: nothing to
# apt-get, so a slow Debian mirror cannot stall the build.
FROM node:22-bookworm
# The other runners the sample project can use (driver/runners.mjs). The .NET
# SDK comes from Microsoft's own image rather than an apt repository; pytest
# from PyPI, since Debian's is years behind what projects run.
COPY --from=mcr.microsoft.com/dotnet/sdk:10.0 /usr/share/dotnet /usr/share/dotnet
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && apt-get update -q && apt-get install -y -q --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/py && /opt/py/bin/pip install -q --no-cache-dir 'pytest==9.1.1'
# NUGET_PACKAGES outside HOME: the run swaps HOME for a throwaway one, and the
# packages restored below must still be found there.
ENV PATH=/opt/py/bin:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 NUGET_PACKAGES=/opt/nuget
# git's identity is set by the entrypoint, in the throwaway HOME the run uses.
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
# Restore the .NET sample's packages once, here, so no scenario downloads.
COPY e2e/tdd-harness/driver/runners.mjs e2e/tdd-harness/driver/lib.mjs /tmp/warm-driver/
RUN node --input-type=module -e "import { kit } from '/tmp/warm-driver/runners.mjs'; import { mkdirSync, writeFileSync } from 'node:fs'; import { dirname } from 'node:path'; for (const [f, t] of Object.entries(kit('dotnet').sample())) { mkdirSync(dirname('/tmp/warm/' + f), { recursive: true }); writeFileSync('/tmp/warm/' + f, t); }" \
 && cd /tmp/warm && dotnet test >/dev/null && cd / && rm -rf /tmp/warm /tmp/warm-driver
COPY e2e e2e
ENTRYPOINT ["/agenfk/e2e/tdd-harness/entrypoint.sh"]
