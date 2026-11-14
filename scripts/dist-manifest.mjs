// What agenfk-dist.tar.gz carries, read by scripts/package-dist.mjs. Its own
// module so tests can import the list instead of parsing it out of the
// packaging script, which runs a full build on import.
export const DIST_INCLUDE = [
    'package.json',
    'package-lock.json',
    // Apache-2.0 section 4(a): every copy we hand out carries the license text.
    'LICENSE',
    'SKILL.md',
    'bin/',
    'scripts/start-services.mjs',
    'scripts/install.mjs',
    // The installer/uninstaller and their helper modules must travel in the
    // tarball — `agenfk upgrade` only extracts the dist and never copies
    // source, so anything omitted here can never be updated post-install
    // (e.g. the #88 uninstaller fix). Keep this in sync with every local
    // ./*.mjs import of the shipped scripts (enforced by dist-ships-uninstaller.test).
    'scripts/install-helpers.mjs',
    'scripts/client-cli.mjs',
    'scripts/private-file.mjs',
    'scripts/uninstall.mjs',
    'scripts/uninstall-helpers.mjs',
    'commands/',
    'clauderules/',
    'codexrules/',
    'cursorrules/',
    'geminirules/',
    'skills/',
    'packages/core/package.json',
    'packages/core/dist/',
    'packages/cli/package.json',
    'packages/cli/dist/',
    'packages/cli/bin/',
    'packages/server/package.json',
    'packages/server/dist/',
    'packages/storage-sqlite/package.json',
    'packages/storage-sqlite/dist/',
    'packages/telemetry/package.json',
    'packages/telemetry/dist/',
    'packages/ui/package.json',
    // vite preview loads this at runtime. It contains the same-origin API
    // and WebSocket proxy used by installed dashboards.
    'packages/ui/vite.config.ts',
    'packages/ui/dist/',
    // flow-editor is a source-only TS package consumed by ui + hub-ui at
    // build time; its src/ must travel in the tarball so workspace resolution
    // doesn't fail (workspaces field references it).
    'packages/flow-editor/package.json',
    'packages/flow-editor/src/',
    'packages/hub/package.json',
    'packages/hub/dist/',
    'packages/hub-ui/package.json',
    'packages/hub-ui/dist/',
    // Every workspace the root package.json lists must ship its package.json,
    // even one whose code the dist does not carry (#232). npm ci reads each
    // workspace's manifest; one left behind by an earlier source install is
    // otherwise never refreshed, keeps pinning an old @agenfk/core, and npm
    // goes to the registry for it (E404). Enforced by
    // dist-ships-every-workspace.test.
    'packages/create/package.json',
    'packages/desktop/package.json',
];
