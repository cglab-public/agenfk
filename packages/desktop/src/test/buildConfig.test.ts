/**
 * CGLAB-171: the packaging config, for macOS, Windows and Linux.
 *
 * The failure this file exists to prevent is the one you only meet after
 * downloading a build: the app installs, launches, and dies because something
 * it needs at runtime was never put in the bundle. `resolveDesktopPaths` looks
 * for `<resources>/packages/server/dist/server.js` and `<…>/ui/dist`; if
 * electron-builder's `extraResources` and that expectation ever drift, nothing
 * in the normal test run notices — the packaged layout is not exercised by any
 * other test, and the source-checkout layout keeps working on the dev machine.
 *
 * So these tests read the real config and assert the two sides agree.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';

const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs');

/** Published resource paths, as they will appear under `resources/`. */
const resourcePaths: string[] = (config.extraResources ?? []).map(
  (entry: string | { to?: string; from?: string }) =>
    typeof entry === 'string' ? entry : (entry.to ?? entry.from ?? ''),
);

const targetsFor = (platform: 'mac' | 'win' | 'linux'): string[] => {
  const raw = config[platform]?.target ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map(
    (t: string | { target: string }) => (typeof t === 'string' ? t : t.target),
  );
};

describe('identity', () => {
  it('has an appId and a product name', () => {
    // Without a stable appId, macOS treats each build as a different app:
    // permissions, the keychain entry and the saved window position all reset.
    expect(config.appId).toMatch(/^[a-z0-9.-]+$/i);
    expect(config.productName).toBeTruthy();
  });
});

describe('targets — all three platforms are requirements, not extras', () => {
  it('builds a macOS disk image and a zip', () => {
    // dmg is what a person downloads; zip is what auto-update consumes.
    expect(targetsFor('mac')).toEqual(expect.arrayContaining(['dmg', 'zip']));
  });

  it('builds macOS for both Apple silicon and Intel', () => {
    const arches = (config.mac?.target ?? [])
      .flatMap((t: { arch?: string[] }) => t.arch ?? []);
    expect(arches).toEqual(expect.arrayContaining(['arm64', 'x64']));
  });

  it('builds a Windows installer and a portable exe', () => {
    expect(targetsFor('win')).toEqual(expect.arrayContaining(['nsis', 'portable']));
  });

  it('builds Linux AppImage and deb', () => {
    expect(targetsFor('linux')).toEqual(expect.arrayContaining(['AppImage', 'deb']));
  });

  it('gives Linux a category, or it lands in no menu at all', () => {
    expect(config.linux?.category).toBeTruthy();
  });
});

describe('extraResources — everything the app needs at runtime', () => {
  const required = ['server', 'core', 'storage-sqlite', 'telemetry', 'ui'];

  for (const pkg of required) {
    it(`ships packages/${pkg}`, () => {
      expect(
        resourcePaths.some(p => p.includes(`packages/${pkg}`)),
        `packages/${pkg} is missing from extraResources, so the packaged app cannot start`,
      ).toBe(true);
    });
  }

  it('ships the server entry at the path the main process looks for', () => {
    // resolveDesktopPaths joins `<root>/server/dist/server.js` under
    // `<resourcesPath>/packages`. A mismatch here is a build that installs and
    // then fails with "server bundle not found".
    const serverEntry = path.join('packages', 'server', 'dist');
    expect(resourcePaths.some(p => p.replace(/\\/g, '/').includes(serverEntry.replace(/\\/g, '/')))).toBe(true);
  });

  it('ships the built UI, not the UI source', () => {
    const ui = resourcePaths.filter(p => p.includes('packages/ui'));
    expect(ui.length).toBeGreaterThan(0);
    expect(ui.every(p => p.includes('dist'))).toBe(true);
  });

  it('publishes resources under `packages/`, which is the sibling layout the app resolves', () => {
    // bin/ and packages/ are siblings in a source checkout, and
    // resolveDesktopPaths relies on the same shape when packaged.
    expect(resourcePaths.every(p => p.replace(/\\/g, '/').startsWith('packages/'))).toBe(true);
  });
});

describe('bundle hygiene', () => {
  it('does not ship tests or TypeScript sources', () => {
    const files: string[] = config.files ?? [];
    const text = JSON.stringify(files);
    expect(text).toMatch(/!.*\.ts/);
    expect(text).toMatch(/!.*test/);
  });

  it('declares where releases are published', () => {
    expect(config.publish).toBeTruthy();
  });

  it('asks for hardened runtime on macOS, which notarization requires', () => {
    expect(config.mac?.hardenedRuntime).toBe(true);
  });

  it('keeps an entitlements file for the hardened runtime', () => {
    // A hardened runtime without entitlements blocks the JIT the renderer
    // needs; the app launches to a blank window.
    expect(config.mac?.entitlements).toBeTruthy();
  });
});

describe('electron version', () => {
  it('is pinned exactly, not a range', () => {
    // electron-builder downloads platform-specific binaries for one release,
    // so it refuses a range outright: "Cannot compute electron version".
    // A caret here does not degrade the build — it stops it, and only on the
    // packaging path, long after every other check has passed.
    const pkg = require('../../package.json');
    const version = pkg.devDependencies?.electron;
    expect(version).toBeTruthy();
    expect(version, `electron must be pinned, got "${version}"`).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins a version whose bundled Node has node:sqlite', () => {
    // storage-sqlite requires Node >= 22.5 for DatabaseSync. Electron 33 was
    // the first with a new enough Node; dropping below that breaks storage in
    // the packaged app only.
    const pkg = require('../../package.json');
    expect(Number(String(pkg.devDependencies.electron).split('.')[0])).toBeGreaterThanOrEqual(33);
  });
});

describe('native module packaging (CGLAB-169)', () => {
  it('unpacks the node-pty prebuilds from the asar archive', () => {
    // The bug this exists to stop is invisible everywhere except an installed
    // .app. @lydell/node-pty ships TWO binaries per platform: pty.node and
    // spawn-helper. spawn-helper is a separate executable node-pty runs on
    // Unix, and a file inside an asar archive is not executable — it is not
    // even a real file on disk. The app then launches, the terminal opens, and
    // spawning dies with a permission or ENOENT error that names nothing
    // useful.
    //
    // Nothing in `npm run dev` reproduces it, because there is no asar there.
    const unpack: string[] = [config.asarUnpack ?? []].flat();
    expect(unpack.length, 'no asarUnpack — the node-pty prebuilds would be archived').toBeGreaterThan(0);
    expect(
      unpack.some(p => p.includes('node-pty')),
      `asarUnpack does not mention node-pty: ${JSON.stringify(unpack)}`,
    ).toBe(true);
  });

  it('unpacks the whole prebuilds directory, not just the .node file', () => {
    // Unpacking pty.node alone is the near-miss: it is the file people think
    // of, it makes the module load, and spawn-helper is still archived — so
    // the failure moves from "cannot load" to "loads, then cannot spawn",
    // which is harder to diagnose, not easier.
    const unpack: string[] = [config.asarUnpack ?? []].flat();
    const nodePtyRules = unpack.filter(p => p.includes('node-pty'));
    expect(
      nodePtyRules.some(p => !p.endsWith('.node')),
      `every node-pty rule targets a .node file, so spawn-helper stays archived: ${JSON.stringify(nodePtyRules)}`,
    ).toBe(true);
  });

  it('keeps node-pty a real dependency, not a devDependency', () => {
    // devDependencies are pruned out of the packaged app. A terminal that only
    // works in development is the exact failure this file exists to catch.
    const pkg = require('../../package.json');
    expect(pkg.dependencies?.['@lydell/node-pty']).toBeTruthy();
    expect(pkg.devDependencies?.['@lydell/node-pty']).toBeUndefined();
  });

  it('pins node-pty exactly — it is a beta', () => {
    // Same reasoning as the electron pin above, with an extra edge: a caret on
    // a 1.2.0-beta.x range will happily take beta.16, and pre-1.0 betas make
    // no compatibility promise between builds.
    const pkg = require('../../package.json');
    expect(pkg.dependencies['@lydell/node-pty']).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
