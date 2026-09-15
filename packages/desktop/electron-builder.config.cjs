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

/**
 * The flag mark from the brand book (44fb546f), laid out to the book's own
 * app-icon spec: the mark centred at 68% of a rounded-square tile, white on
 * #0B0B0B, corner radius 0.21875 of the side. build/icon.svg is the vector
 * source the PNG was rendered from, kept beside it so the icon can be
 * regenerated at any size instead of being re-traced.
 *
 * One 1024px PNG for all three platforms: electron-builder derives the icns
 * and ico slots from it, which is one source of truth rather than three files
 * that drift. It would find build/icon.png on its own, but only while
 * buildResources stays 'build' - naming it on each platform makes moving that
 * directory fail loudly rather than silently reverting the app to the stock
 * Electron atom, which is a defect nobody sees until they look at the Dock.
 */
const APP_ICON = 'build/icon.png';

/**
 * Linux wants a directory, not that single file.
 *
 * Handed one PNG, electron-builder derives a one-entry icon "set" sized by the
 * source (iconConverter's `set` branch returns it as-is with size = max(w,h)),
 * and FpmTarget then installs the deb's icon at
 * /usr/share/icons/hicolor/<size>x<size>/apps. From a 1024px master that is a
 * 1024x1024 directory, which the stock hicolor index does not list, so desktops
 * that walk the standard sizes find no icon and the app lands in the menu
 * blank. A directory of NxN.png files is passed through verbatim instead, which
 * puts every size where the spec says to look. The 1024 entry stays in the set
 * because AppImage links .DirIcon to the largest one available.
 */
const APP_ICON_SET = 'build/icons';

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

  // node-pty ships TWO binaries per platform: pty.node and spawn-helper.
  // spawn-helper is a separate executable node-pty runs on Unix, and a file
  // inside an asar archive is not executable — it is not even a real file on
  // disk. Archived, the app launches, the terminal opens, and spawning dies
  // with an ENOENT or permission error that names nothing useful. Nothing in
  // `npm run dev` reproduces it, because there is no asar there.
  //
  // The whole prebuilds directory, not just **/*.node: unpacking the .node
  // alone is the near-miss that makes the module load and leaves spawn-helper
  // archived, moving the failure from "cannot load" to "loads, then cannot
  // spawn" — harder to diagnose, not easier. src/test/buildConfig.test.ts
  // asserts both halves.
  asarUnpack: [
    '**/node_modules/@lydell/node-pty*/**',
  ],

  extraResources: [
    ...serverResources,
    // The UI is served by the forked server, so only the build output ships.
    { from: '../ui/dist', to: 'packages/ui/dist' },
  ],

  mac: {
    icon: APP_ICON,
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
    icon: APP_ICON,
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
    icon: APP_ICON_SET,
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
