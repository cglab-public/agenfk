/**
 * CGLAB-696 task 6: AgEnFK installs the smolvm Airlock runs on - exactly SMOLVM_VERSION, from
 * that release's tarball for the platform, checked against the sha256 recorded here, unpacked
 * into ~/.agenfk/smolvm/<version> (user decision 2026-10-30: the Homebrew tap cannot pin a
 * version). Airlock runs that copy, never the smolvm on PATH.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SMOLVM_VERSION } from '../airlock/smolvm';
import {
  SMOLVM_RELEASES,
  smolvmDir,
  smolvmBinary,
  installSmolvm,
  runAirlockInstall,
  INSTALL_SKIPPED_UNKNOWN,
  type SmolvmRelease,
} from '../airlock/smolvmInstall';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

let root: string;
let home: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-smolvm-install-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A release tarball as smolvm ships one: a top directory holding the `smolvm` wrapper and its parts. */
function tarball(version = SMOLVM_VERSION): { file: string; sha256: string } {
  const top = `smolvm-${version}-test`;
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, top, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, top, 'smolvm'), `#!/bin/sh\necho "smolvm ${version}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(src, top, 'lib', 'libkrun.dylib'), 'lib');
  const file = path.join(root, 'release.tar.gz');
  const r = spawnSync('tar', ['-czf', file, '-C', src, top]);
  expect(r.status).toBe(0);
  return { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function deps(release: SmolvmRelease, over: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const download = vi.fn(async (_url: string, dest: string) => { fs.copyFileSync(path.join(root, 'release.tar.gz'), dest); });
  return {
    home, platform: 'darwin' as NodeJS.Platform, arch: 'arm64', download,
    releases: { 'darwin-arm64': release } as Record<string, SmolvmRelease>,
    log: (m: string) => { logs.push(m); },
    logs,
    ...over,
  };
}

describe('the pinned releases', () => {
  it('are the tarballs of exactly SMOLVM_VERSION, one per platform smolvm runs on, each with its sha256', () => {
    expect(Object.keys(SMOLVM_RELEASES).sort()).toEqual(['darwin-arm64', 'linux-arm64', 'linux-x64']);
    for (const [key, r] of Object.entries(SMOLVM_RELEASES)) {
      expect(r.url, key).toMatch(new RegExp(`^https://github\\.com/smol-machines/smolvm/releases/download/v${SMOLVM_VERSION.replace(/\./g, '\\.')}/smolvm-${SMOLVM_VERSION.replace(/\./g, '\\.')}-`));
      expect(r.sha256, key).toMatch(/^[0-9a-f]{64}$/);
    }
    // Measured on the downloaded release (and the tap's formula records the same).
    expect(SMOLVM_RELEASES['darwin-arm64'].sha256).toBe('64bee03d87f6cbf3a1ab0e0926b99cec45fac62900b0a37da15a8271a5c6de59');
  });

  it('install into a folder of their own version under ~/.agenfk/smolvm', () => {
    expect(smolvmDir('/home/u')).toBe(path.join('/home/u', '.agenfk', 'smolvm', SMOLVM_VERSION));
    expect(smolvmBinary('/home/u')).toBe(path.join('/home/u', '.agenfk', 'smolvm', SMOLVM_VERSION, 'smolvm'));
  });
});

describePosix('installSmolvm', () => {
  it('downloads the platform\'s tarball, checks its sha256, and unpacks it so its smolvm runs', async () => {
    const t = tarball();
    const d = deps({ url: 'https://example.invalid/smolvm.tar.gz', sha256: t.sha256 });
    expect(await installSmolvm(d)).toEqual({ status: 'installed', path: smolvmBinary(home) });
    expect(d.download).toHaveBeenCalledWith('https://example.invalid/smolvm.tar.gz', expect.any(String));
    expect(spawnSync(smolvmBinary(home), ['--version'], { encoding: 'utf8' }).stdout).toBe(`smolvm ${SMOLVM_VERSION}\n`);
    expect(fs.existsSync(path.join(smolvmDir(home), 'lib', 'libkrun.dylib'))).toBe(true);
    // Nothing of the download is left beside it.
    expect(fs.readdirSync(path.dirname(smolvmDir(home)))).toEqual([SMOLVM_VERSION]);
  });

  it('refuses a tarball whose sha256 is not the recorded one, and installs nothing', async () => {
    tarball();
    const d = deps({ url: 'https://example.invalid/smolvm.tar.gz', sha256: 'f'.repeat(64) });
    await expect(installSmolvm(d)).rejects.toThrow(/sha256/);
    expect(fs.existsSync(smolvmDir(home))).toBe(false);
    expect(fs.existsSync(path.dirname(smolvmDir(home))) ? fs.readdirSync(path.dirname(smolvmDir(home))) : []).toEqual([]);
  });

  it('refuses a tarball that unpacks to a smolvm of another version', async () => {
    const t = tarball('9.9.9');
    const d = deps({ url: 'https://example.invalid/smolvm.tar.gz', sha256: t.sha256 });
    await expect(installSmolvm(d)).rejects.toThrow(new RegExp(`9\\.9\\.9.*${SMOLVM_VERSION.replace(/\./g, '\\.')}`));
    expect(fs.existsSync(smolvmDir(home))).toBe(false);
  });

  it('downloads nothing when that version is already installed', async () => {
    const t = tarball();
    await installSmolvm(deps({ url: 'u', sha256: t.sha256 }));
    const d = deps({ url: 'u', sha256: t.sha256 });
    expect(await installSmolvm(d)).toEqual({ status: 'present', path: smolvmBinary(home) });
    expect(d.download).not.toHaveBeenCalled();
  });

  it('installs again over a folder an interrupted install left without its smolvm', async () => {
    const t = tarball();
    fs.mkdirSync(smolvmDir(home), { recursive: true });
    fs.writeFileSync(path.join(smolvmDir(home), 'half'), '');
    const d = deps({ url: 'u', sha256: t.sha256 });
    expect((await installSmolvm(d)).status).toBe('installed');
    expect(fs.existsSync(path.join(smolvmDir(home), 'half'))).toBe(false);
  });

  it('refuses a platform smolvm does not run on, and says why, without downloading', async () => {
    for (const [platform, arch, why] of [['darwin', 'x64', /Apple Silicon/], ['win32', 'x64', /Windows/], ['linux', 'ia32', /linux-ia32/]] as const) {
      const d = deps({ url: 'u', sha256: 'f'.repeat(64) }, { platform, arch, releases: SMOLVM_RELEASES });
      await expect(installSmolvm(d), `${platform}-${arch}`).rejects.toThrow(why);
      expect(d.download).not.toHaveBeenCalled();
    }
  });

  it('two installs at once: one downloads and installs, the other waits and finds it there - nothing is removed under either (review 01a18d3a)', async () => {
    const t = tarball();
    const slow = (ms: number) => vi.fn(async (_u: string, dest: string) => { await new Promise((r) => setTimeout(r, ms)); fs.copyFileSync(path.join(root, 'release.tar.gz'), dest); });
    const a = deps({ url: 'u', sha256: t.sha256 }, { download: slow(300) });
    const b = deps({ url: 'u', sha256: t.sha256 }, { download: slow(10) });
    const results = await Promise.all([installSmolvm(a), installSmolvm(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(['installed', 'present']);
    expect(a.download.mock.calls.length + b.download.mock.calls.length).toBe(1);
    expect(spawnSync(smolvmBinary(home), ['--version'], { encoding: 'utf8' }).stdout).toBe(`smolvm ${SMOLVM_VERSION}\n`);
  });

  const lockPath = () => path.join(path.dirname(smolvmDir(home)), `.lock-${SMOLVM_VERSION}`);
  const writeLock = (owner: string) => { fs.mkdirSync(lockPath(), { recursive: true }); fs.writeFileSync(path.join(lockPath(), 'owner'), owner); };

  it('a lock an install left behind (its process gone) does not block the next one', async () => {
    const t = tarball();
    writeLock('999999 deadbeef');
    expect((await installSmolvm(deps({ url: 'u', sha256: t.sha256 }))).status).toBe('installed');
  });

  it('a lock with no owner in it (an install stopped while making it) does not block the next one (review 01a18d3a, pass 2)', async () => {
    const t = tarball();
    for (const owner of [null, '', 'garbage']) {
      fs.rmSync(path.join(home, '.agenfk'), { recursive: true, force: true });
      if (owner === null) fs.mkdirSync(lockPath(), { recursive: true }); else writeLock(owner);
      expect((await installSmolvm(deps({ url: 'u', sha256: t.sha256 }))).status, String(owner)).toBe('installed');
    }
  });

  it('a lock a live process holds is waited for, not taken', async () => {
    const t = tarball();
    writeLock(`${process.pid} somebody-else`);
    const d = deps({ url: 'u', sha256: t.sha256 });
    const run = installSmolvm(d);
    await new Promise((r) => setTimeout(r, 400));
    expect(d.download).not.toHaveBeenCalled();
    fs.rmSync(lockPath(), { recursive: true, force: true });
    expect((await run).status).toBe('installed');
  });

  it('an install releases only its own lock: one another install holds by then stays (review 01a18d3a, pass 2)', async () => {
    const t = tarball();
    const d = deps({ url: 'u', sha256: t.sha256 }, {
      // While this install holds the lock, another takes it over (as a takeover race would leave it).
      download: vi.fn(async (_u: string, dest: string) => { writeLock(`${process.pid} the-other-one`); fs.copyFileSync(path.join(root, 'release.tar.gz'), dest); }),
    });
    await installSmolvm(d);
    expect(fs.readFileSync(path.join(lockPath(), 'owner'), 'utf8')).toBe(`${process.pid} the-other-one`);
  });

  it('never replaces a valid install that appeared while it downloaded, lock or no lock (review 01a18d3a, pass 3)', async () => {
    const t = tarball();
    const d = deps({ url: 'u', sha256: t.sha256 }, {
      // Another install's result, published while this one downloads (the lock's rare race let it in).
      download: vi.fn(async (_u: string, dest: string) => {
        fs.mkdirSync(path.join(smolvmDir(home), 'lib'), { recursive: true });
        fs.writeFileSync(smolvmBinary(home), `#!/bin/sh\necho "smolvm ${SMOLVM_VERSION}"\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(smolvmDir(home), 'theirs'), '');
        fs.copyFileSync(path.join(root, 'release.tar.gz'), dest);
      }),
    });
    expect((await installSmolvm(d)).status).toBe('present');
    expect(fs.existsSync(path.join(smolvmDir(home), 'theirs'))).toBe(true);
  });

  it('a download that fails installs nothing, and says so', async () => {
    const d = deps({ url: 'u', sha256: 'f'.repeat(64) }, { download: vi.fn(async () => { throw new Error('HTTP 503'); }) });
    await expect(installSmolvm(d)).rejects.toThrow(/HTTP 503/);
    expect(fs.existsSync(smolvmDir(home))).toBe(false);
  });
});

describePosix('agenfk airlock install', () => {
  const policyOf = (mode: string) => vi.fn(async () => ({ effective: { mode } }));

  it('installs, and says where', async () => {
    const t = tarball();
    const d = { ...deps({ url: 'u', sha256: t.sha256 }), fetchPolicy: policyOf('off') };
    expect(await runAirlockInstall({ ifEnabled: false }, d)).toBe(0);
    expect(d.logs.join('\n')).toContain(smolvmBinary(home));
  });

  it('--if-enabled: skips when Airlock is off and no smolvm was ever installed, and says how to install it', async () => {
    tarball();
    const d = { ...deps({ url: 'u', sha256: 'f'.repeat(64) }), fetchPolicy: policyOf('off') };
    expect(await runAirlockInstall({ ifEnabled: true }, d)).toBe(0);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.logs.join('\n')).toMatch(/agenfk airlock install/);
  });

  it('--if-enabled: installs when the policy observes or enforces', async () => {
    for (const mode of ['observe', 'enforce']) {
      fs.rmSync(path.join(home, '.agenfk'), { recursive: true, force: true });
      const t = tarball();
      const d = { ...deps({ url: 'u', sha256: t.sha256 }), fetchPolicy: policyOf(mode) };
      expect(await runAirlockInstall({ ifEnabled: true }, d), mode).toBe(0);
      expect(fs.existsSync(smolvmBinary(home)), mode).toBe(true);
    }
  });

  it('--if-enabled: an upgrade installs the new pin where an earlier smolvm was installed, whatever the server says', async () => {
    const t = tarball();
    fs.mkdirSync(path.join(home, '.agenfk', 'smolvm', '1.0.0'), { recursive: true });
    const d = { ...deps({ url: 'u', sha256: t.sha256 }), fetchPolicy: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    expect(await runAirlockInstall({ ifEnabled: true }, d)).toBe(0);
    expect(fs.existsSync(smolvmBinary(home))).toBe(true);
  });

  it('--if-enabled: a server it cannot ask, and nothing installed before: skips, says so, and exits 3 so an installer can warn (review 01a18d3a)', async () => {
    tarball();
    const d = { ...deps({ url: 'u', sha256: 'f'.repeat(64) }), fetchPolicy: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    expect(await runAirlockInstall({ ifEnabled: true }, d)).toBe(INSTALL_SKIPPED_UNKNOWN);
    expect(INSTALL_SKIPPED_UNKNOWN).toBe(3);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.logs.join('\n')).toMatch(/could not tell whether Airlock is on.*agenfk airlock install/s);
  });

  it('a failed install exits 1 with the reason', async () => {
    tarball();
    const d = { ...deps({ url: 'u', sha256: 'f'.repeat(64) }), fetchPolicy: policyOf('enforce') };
    expect(await runAirlockInstall({ ifEnabled: false }, d)).toBe(1);
    expect(d.logs.join('\n')).toMatch(/sha256/);
  });
});
