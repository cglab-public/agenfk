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
import * as fs from 'fs';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs');

/**
 * Width, height and colour type straight out of a PNG's IHDR chunk.
 *
 * Reading 26 bytes by hand rather than adding an image library: the packaging
 * tests are the last thing that should pull a dependency in, and the header
 * layout is fixed by the PNG spec.
 */
const pngSize = (buf: Buffer) => ({
  width: buf.readUInt32BE(16),
  height: buf.readUInt32BE(20),
  colorType: buf.readUInt8(25),
});

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

describe('app icon (44fb546f)', () => {
  // electron-builder falls back to the stock Electron atom when it finds no
  // icon, and it does so without a warning that survives a noisy build log.
  // The ship is silent: a correctly signed, correctly notarized app wearing
  // someone else's logo in the Dock.
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');

  it('has an icon file where buildResources looks for it', () => {
    expect(fs.existsSync(iconPath), `no icon at ${iconPath}`).toBe(true);
  });

  it('names the icon on every platform rather than relying on the lookup', () => {
    // electron-builder would find build/icon.png on its own, but only for as
    // long as directories.buildResources stays 'build'. Naming it is what
    // makes moving that directory a loud failure instead of a silent one.
    expect(config.mac?.icon, 'mac has no icon').toBe('build/icon.png');
    expect(config.win?.icon, 'win has no icon').toBe('build/icon.png');
    expect(config.linux?.icon, 'linux has no icon').toBe('build/icons');
  });

  it('gives Linux a directory of sizes, not the single master', () => {
    // Handed one PNG, electron-builder makes a one-entry set sized by the
    // source and the deb installs its icon into hicolor/1024x1024 - a
    // directory the stock index does not list, so the app shows up in the
    // menu with no icon at all. Nothing about that failure is visible from
    // the build log.
    const dir = path.join(__dirname, '..', '..', config.linux.icon);
    expect(fs.existsSync(dir), `${dir} does not exist`).toBe(true);

    const sizes = fs
      .readdirSync(dir)
      // The name pattern electron-builder's collectIconsFromDir matches.
      .map((name) => /^(\d+)(?:x\d+)?\.png$/i.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));

    // The sizes a desktop environment actually goes looking for.
    for (const required of [16, 32, 48, 64, 128, 256, 512]) {
      expect(sizes, `no ${required}x${required} icon for Linux`).toContain(required);
    }
  });

  it('renders each Linux size at the size its filename claims', () => {
    // A directory of files all copied from the 1024 master would satisfy the
    // test above and still ship one oversized image under seven names.
    const dir = path.join(__dirname, '..', '..', config.linux.icon);
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d+)(?:x\d+)?\.png$/i.exec(name);
      if (!match) continue;
      const { width, height } = pngSize(fs.readFileSync(path.join(dir, name)));
      expect(width, `${name} is ${width}px wide`).toBe(Number(match[1]));
      expect(height, `${name} is ${height}px tall`).toBe(Number(match[1]));
    }
  });

  it('draws the brand flag, not some other artwork', () => {
    // Every other check here passes just as happily on a blank square. This is
    // the only one that looks at what the icon actually depicts: the vector
    // source must carry the same mark path the UI component renders, which is
    // itself pinned to the brand book in AgenfkFlag.test.tsx.
    const markSource = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'src', 'components', 'agenfkFlagPath.ts'),
      'utf8',
    );
    const markPath = /FLAG_MARK_PATH =\s*'([^']+)'/.exec(markSource)?.[1];
    expect(markPath, 'could not read FLAG_MARK_PATH from the UI package').toBeTruthy();

    const iconSvg = fs.readFileSync(
      path.join(__dirname, '..', '..', 'build', 'icon.svg'),
      'utf8',
    );
    expect(iconSvg).toContain(markPath!);
  });

  it('is square and at least 1024px, which is what the macOS icns needs', () => {
    // electron-builder derives every platform size from this one file and
    // refuses anything under 256px outright. 1024 is the largest slot in an
    // icns, so a smaller source means an upscaled, soft Dock icon on Retina.
    const { width, height } = pngSize(fs.readFileSync(iconPath));
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(1024);
  });

  it('is not swallowed by a .gitignore rule', () => {
    // The root .gitignore ignores `build/` for every package that puts
    // compiler output there, and packages/desktop/build is the exception: it
    // is electron-builder's buildResources, holding hand-authored packaging
    // inputs. While it was ignored, `git add` silently did nothing here and
    // every other check in this block still passed on the machine that made
    // the file.
    //
    // This asserts the path is committable, which is weaker than asserting it
    // is committed. Tracking cannot be asserted from here without the test
    // failing for everyone who has legitimately not staged a new icon yet.
    const result = spawnSync('git', ['check-ignore', '--quiet', iconPath], {
      cwd: __dirname,
    });
    expect(result.error, 'git is required to run this check').toBeUndefined();
    // check-ignore exits 0 when the path IS ignored, 1 when it is not.
    expect(result.status, `${iconPath} is gitignored and would never be committed`).toBe(1);
  });

  it('keeps transparency, so the rounded corners are not squares', () => {
    // The mark sits on a rounded tile. Flattened onto opaque white, the
    // corners come back as white triangles against the Dock.
    const { colorType } = pngSize(fs.readFileSync(iconPath));
    // 6 = RGBA, 4 = grayscale+alpha, 3 = palette (which may carry a tRNS chunk).
    expect([3, 4, 6]).toContain(colorType);
  });
});

/**
 * What must NEVER reach the repository (3d953bff).
 *
 * The block above asserts the icon is committable, and fixing that required
 * un-ignoring packages/desktop/build wholesale. That directory is
 * electron-builder's buildResources, and it is also where electron-builder's
 * own documentation tells people to put signing material - certificate.p12,
 * provisioning profiles. This project signs for real: hardenedRuntime is on
 * and notarization needs credentials. So the fix for a quiet packaging failure
 * opened the one directory where a private key is conventionally dropped.
 *
 * Hence an allowlist rather than a denylist inside it. The trade is deliberate
 * and worth writing down, because the next person will be tempted to reverse
 * it: an allowlist fails LOUDLY - somebody adds a resource, forgets the line,
 * and a fresh clone cannot package, which is exactly the failure that was just
 * fixed and is therefore the one most likely to be noticed. A denylist fails
 * SILENTLY, by publishing a signing key to a public repository. Between a
 * broken build and a leaked certificate, the broken build is the good outcome.
 *
 * These tests ask git itself rather than parsing .gitignore, because the rule
 * that decides a path is the product of three files - the root one, the
 * package one, and the negation order between them - and reimplementing that
 * precedence here would be testing this file's copy of git instead of git.
 */
describe('paths that must stay out of the repository (3d953bff)', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  /** True when git would ignore this path. The file need not exist. */
  const isIgnored = (relPath: string): boolean => {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relPath], {
      cwd: repoRoot,
    });
    expect(result.error, 'git is required to run this check').toBeUndefined();
    // 0 = ignored, 1 = not ignored. Anything else is git failing, not answering.
    expect([0, 1], `git check-ignore failed on ${relPath}`).toContain(result.status);
    return result.status === 0;
  };

  describe('signing material, wherever it lands', () => {
    /*
     * The highest-consequence entry on the list. A leaked .p12 plus its
     * password lets somebody sign software as this organisation, and revoking
     * a Developer ID invalidates everything already shipped under it.
     */
    const secrets = [
      'packages/desktop/build/certificate.p12',
      'packages/desktop/build/AgEnFK.provisionprofile',
      'certificate.p12',
      'signing.pem',
      'apple.cer',
      'release.keystore',
      'release.jks',
      'AgEnFK.mobileprovision',
    ];
    for (const secret of secrets) {
      it(`ignores ${secret}`, () => {
        expect(isIgnored(secret)).toBe(true);
      });
    }
  });

  describe('local environment files', () => {
    // The bare `.env` rule matches neither of these, and they are the two
    // filenames tooling actually writes credentials into.
    for (const env of ['.env.local', '.env.production.local', 'packages/hub/.env.local']) {
      it(`ignores ${env}`, () => {
        expect(isIgnored(env)).toBe(true);
      });
    }

    it('still tracks .env.example, which documents the variables', () => {
      // A rule broad enough to catch .env.local must not also hide the file
      // that tells a new contributor what to put in it.
      expect(isIgnored('packages/hub/.env.example')).toBe(false);
    });
  });

  describe('packaging artifacts, by extension and not only by directory', () => {
    /*
     * These land in release/ today, which is ignored. The rules below are for
     * when they do not: `electron-builder --dir`, a run from another cwd, or a
     * change to `directories.output`. An installer committed once stays in
     * every clone of the history forever, which is why this is guarded by
     * extension and not only by the directory of the day.
     */
    for (const artifact of [
      'AgEnFK-1.1.18-arm64.dmg',
      'AgEnFK-1.1.18-mac.zip',
      'AgEnFK-1.1.18.dmg.blockmap',
      'AgEnFK-Setup-1.1.18.exe',
      'AgEnFK-1.1.18.AppImage',
      'agenfk_1.1.18_amd64.deb',
      'AgEnFK-1.1.18.pkg',
    ]) {
      it(`ignores ${artifact}`, () => {
        expect(isIgnored(artifact)).toBe(true);
      });
    }
  });

  describe('the buildResources allowlist', () => {
    it('lets through every packaging input the config names', () => {
      /*
       * The other half of the allowlist, and the half that breaks the build if
       * it is wrong. Derived from the config rather than listed by hand, so
       * pointing electron-builder at a new resource without un-ignoring it
       * fails here instead of on somebody else's fresh clone.
       */
      const named = [
        config.mac.entitlements,
        config.mac.entitlementsInherit,
        config.mac.icon,
        config.win.icon,
        config.linux.icon,
      ].filter(Boolean);
      expect(named.length).toBeGreaterThan(0);
      for (const rel of new Set(named)) {
        const fromRepoRoot = path.posix.join('packages/desktop', rel as string);
        expect(isIgnored(fromRepoRoot), `${fromRepoRoot} is named by the config but gitignored`).toBe(false);
      }
    });

    it('keeps the generated server bundle out', () => {
      // The one genuinely generated thing under build/, and the reason the
      // directory cannot simply be un-ignored and left alone.
      expect(isIgnored('packages/desktop/build/server-bundle/server.js')).toBe(true);
    });

    it('keeps out anything else dropped in there', () => {
      /*
       * THE test for the allowlist. A denylist passes every other test in this
       * block and still fails this one, which is the whole difference between
       * the two designs.
       */
      expect(isIgnored('packages/desktop/build/notes.txt')).toBe(true);
      expect(isIgnored('packages/desktop/build/icon.iconset/icon_512x512.png')).toBe(true);
    });
  });

  describe('the logs directory', () => {
    it('ignores what is inside it, whatever the extension', () => {
      // Only *.log is ignored today, so the directory survives the first file
      // that does not carry that extension - a transcript, a json dump, a core.
      expect(isIgnored('logs/session/transcript.json')).toBe(true);
    });
  });
});
