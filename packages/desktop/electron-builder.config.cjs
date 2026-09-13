/**
 * Packaging for macOS, Windows and Linux (CGLAB-171).
 *
 * The shape that matters is `extraResources`: the app does not bundle the
 * AgEnFK server into the renderer, it forks `packages/server/dist/server.js`
 * as a child process and points a window at it. So the packaged app needs the
 * same `packages/*` layout a source checkout has, and `resolveDesktopPaths`
 * (src/main/paths.ts) resolves exactly that under `process.resourcesPath`.
 * If these two drift, the build installs and then dies with "server bundle not
 * found" — which is why src/test/buildConfig.test.ts asserts they agree.
 *
 * No native modules today: storage uses Node's built-in `node:sqlite` and
 * Electron 40 ships Node 24.15, so all three platforms build from one source
 * tree with no `electron-rebuild`. That changes the day `node-pty` lands
 * (CGLAB-169) — it is native, and each platform and Electron ABI needs its own
 * compile.
 *
 * A JS config rather than YAML so the comments above can exist and so the
 * tests can read it directly.
 */

/**
 * The server ships as ONE self-contained file, not as a package tree.
 *
 * In the monorepo the server's dependencies (express, socket.io, axios) are
 * hoisted into the root node_modules, so `packages/server/dist/server.js` runs
 * fine on a dev machine and dies with `Cannot find module 'express'` the
 * moment it is copied into a .app. Shipping the dependency closure would mean
 * pruning a hoisted workspace tree at build time; bundling decides the
 * contents at build time instead. scripts/bundle-server.mjs produces it, and
 * src/test/serverBundle.test.ts runs it from a directory with no node_modules
 * above it — the only place this failure is visible.
 *
 * core / storage-sqlite / telemetry are inlined into that bundle, so they need
 * no entry of their own. The paths below still name them, because
 * resolveDesktopPaths and the packaging tests both key off this layout.
 */
const serverResources = [
  { from: 'build/server-bundle', to: 'packages/server/dist' },
  { from: '../server/package.json', to: 'packages/server/package.json' },
  { from: '../core/package.json', to: 'packages/core/package.json' },
  { from: '../storage-sqlite/package.json', to: 'packages/storage-sqlite/package.json' },
  { from: '../telemetry/package.json', to: 'packages/telemetry/package.json' },
];

module.exports = {
  appId: 'com.cglab.agenfk.desktop',
  productName: 'AgEnFK',
  // Stable across builds: macOS keys permissions, the keychain entry and the
  // saved window position off it, so changing it silently resets all three.
  copyright: 'CG/lab',

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  // The app's own code. Everything else it needs arrives via extraResources,
  // because it is loaded by a child process, not by the renderer.
  files: [
    'dist/**/*',
    'package.json',
    '!**/*.ts',
    '!**/*.map',
    '!**/test/**',
    '!**/*.test.*',
  ],

  extraResources: [
    ...serverResources,
    // The UI is served by the forked server, so only the build output ships.
    { from: '../ui/dist', to: 'packages/ui/dist' },
  ],

  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // zip is what electron-updater consumes; dmg is what a person downloads.
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Required for notarization. It also blocks the JIT the renderer needs,
    // which is why the entitlements file below is not optional.
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    gatekeeperAssess: false,
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
      // Portable for people who cannot run an installer on a work machine.
      { target: 'portable', arch: ['x64'] },
    ],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },

  linux: {
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
    ],
    // Without a category the app appears in no application menu at all.
    category: 'Development',
    maintainer: 'CG/lab <engineering@cglab.com>',
  },

  publish: [{ provider: 'github', owner: 'cglab-public', repo: 'agenfk' }],
};
