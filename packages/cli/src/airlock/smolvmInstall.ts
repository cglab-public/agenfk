/**
 * CGLAB-696 task 6: the smolvm Airlock runs on, installed by AgEnFK - exactly
 * SMOLVM_VERSION, from that release's tarball for the platform, checked against
 * the sha256 recorded here and unpacked into ~/.agenfk/smolvm/<version>. Airlock
 * runs that copy, never a smolvm on PATH: the Homebrew tap installs whatever it
 * has last, and the release ships no install script (user decision 2026-10-30).
 * A bump of SMOLVM_VERSION is a reviewed change, with the new release's sums.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { SMOLVM_VERSION } from './smolvm';

export interface SmolvmRelease { url: string; sha256: string }

const asset = (name: string) => `https://github.com/smol-machines/smolvm/releases/download/v${SMOLVM_VERSION}/smolvm-${SMOLVM_VERSION}-${name}.tar.gz`;

/** The release tarballs, by `${platform}-${arch}` as Node names them. */
export const SMOLVM_RELEASES: Record<string, SmolvmRelease> = {
  'darwin-arm64': { url: asset('darwin-arm64'), sha256: '64bee03d87f6cbf3a1ab0e0926b99cec45fac62900b0a37da15a8271a5c6de59' },
  'linux-arm64': { url: asset('linux-arm64'), sha256: '693b34530d9eac9d6d1b61e22b33bb34c87c511b1a8c9098fe35d9c4a77e07ce' },
  'linux-x64': { url: asset('linux-x86_64'), sha256: '7b0580c2ef98e183ac5c3a1567eca3a336d58aa0e2ca5904350f7d3a851205e8' },
};

export const smolvmDir = (home: string): string => path.join(home, '.agenfk', 'smolvm', SMOLVM_VERSION);
/** The release's wrapper: it sets the library path its binary needs, then runs it. */
export const smolvmBinary = (home: string): string => path.join(smolvmDir(home), 'smolvm');

export interface InstallDeps {
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Saves `url` to the file `dest`; rejects on any failure. */
  download: (url: string, dest: string) => Promise<void>;
  releases?: Record<string, SmolvmRelease>;
  log: (message: string) => void;
}

function releaseFor(d: InstallDeps): SmolvmRelease {
  const releases = d.releases ?? SMOLVM_RELEASES;
  const key = `${d.platform}-${d.arch}`;
  const r = releases[key];
  if (r) return r;
  if (d.platform === 'win32') throw new Error('smolvm does not run on Windows, so Airlock cannot either.');
  if (d.platform === 'darwin') throw new Error('smolvm on macOS needs Apple Silicon: there is no release for this Mac.');
  throw new Error(`smolvm ${SMOLVM_VERSION} has no release for ${key}.`);
}

const versionOf = (binary: string): string | null => {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim().replace(/^smolvm\s+/, '') : null;
};

const LOCK_WAIT_MS = 900_000;
const LOCK_POLL_MS = 100;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** The owner a lock names (`<pid> <token>`), or null when it names none. */
function ownerOf(lock: string): { pid: number; line: string } | null {
  let line: string;
  try { line = fs.readFileSync(path.join(lock, 'owner'), 'utf8'); } catch { return null; }
  const m = /^(\d+) \S+$/.exec(line);
  return m && Number(m[1]) > 0 ? { pid: Number(m[1]), line } : null;
}

/**
 * Holds `lock` while `fn` runs. The lock directory is made whole elsewhere, owner inside, and
 * renamed into place: a rename onto a directory that exists fails, so there is one owner and the
 * lock is never seen half-made. A lock whose owner is gone, or which names none, is moved aside
 * and taken over - put back when what was moved is not the one judged (another took it over first).
 * Released only while it still names this install.
 */
async function withInstallLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const me = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const mine = fs.mkdtempSync(`${lock}.new-`);
    fs.writeFileSync(path.join(mine, 'owner'), me);
    try {
      fs.renameSync(mine, lock);
      break;
    } catch (e) {
      fs.rmSync(mine, { recursive: true, force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw e;
    }
    const held = ownerOf(lock);
    if (!held || !pidAlive(held.pid)) {
      const aside = `${lock}.stale-${crypto.randomBytes(8).toString('hex')}`;
      try { fs.renameSync(lock, aside); } catch { continue; }
      const moved = ownerOf(aside);
      if (moved?.line !== held?.line) {
        // Another install's fresh lock, not the stale one: back where it was.
        try { fs.renameSync(aside, lock); } catch { /* it has a new owner already */ }
      } else {
        fs.rmSync(aside, { recursive: true, force: true });
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Another smolvm install has held ${lock} for ${LOCK_WAIT_MS / 1000}s; not installed.`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    if (ownerOf(lock)?.line === me) {
      const gone = `${lock}.done-${crypto.randomBytes(8).toString('hex')}`;
      try {
        fs.renameSync(lock, gone);
        if (ownerOf(gone)?.line === me) fs.rmSync(gone, { recursive: true, force: true });
        else fs.renameSync(gone, lock);
      } catch { /* not ours to release */ }
    }
  }
}

/**
 * Installs SMOLVM_VERSION unless it is there. One install at a time (a lock beside the target),
 * so a valid install is never removed under a launch using it. The download and the unpacking
 * happen in a folder of their own, which becomes the target only once the smolvm in it says its
 * version: an interrupted install leaves nothing a launch would take for an installed one.
 */
export async function installSmolvm(d: InstallDeps): Promise<{ status: 'installed' | 'present'; path: string }> {
  const release = releaseFor(d);
  const target = smolvmDir(d.home);
  const binary = smolvmBinary(d.home);
  if (fs.existsSync(binary) && versionOf(binary) === SMOLVM_VERSION) return { status: 'present', path: binary };
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return withInstallLock(path.join(parent, `.lock-${SMOLVM_VERSION}`), async () => {
    // Again under the lock: another install may have finished while this one waited.
    if (fs.existsSync(binary) && versionOf(binary) === SMOLVM_VERSION) return { status: 'present' as const, path: binary };
    const work = fs.mkdtempSync(path.join(parent, `.install-${SMOLVM_VERSION}-`));
    try {
      const archive = path.join(work, 'release.tar.gz');
      d.log(`Airlock: downloading smolvm ${SMOLVM_VERSION} (${release.url})...`);
      await d.download(release.url, archive);
      const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      if (sum !== release.sha256) {
        throw new Error(`The smolvm ${SMOLVM_VERSION} download's sha256 is ${sum}, not the ${release.sha256} AgEnFK records for it: not installed.`);
      }
      const unpacked = path.join(work, 'smolvm');
      fs.mkdirSync(unpacked);
      const tar = spawnSync('tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1'], { encoding: 'utf8', windowsHide: true });
      if (tar.status !== 0) throw new Error(`Could not unpack smolvm ${SMOLVM_VERSION}: ${(tar.stderr || tar.error?.message || `exit ${tar.status}`).trim()}`);
      const got = versionOf(path.join(unpacked, 'smolvm'));
      if (got !== SMOLVM_VERSION) throw new Error(`The smolvm unpacked says it is ${got ?? 'nothing it can run'}, not ${SMOLVM_VERSION}: not installed.`);
      // A working install is never replaced: one that appeared meanwhile (the lock's rare
      // three-way takeover race) is kept, and this copy goes with the work dir.
      if (fs.existsSync(binary) && versionOf(binary) === SMOLVM_VERSION) return { status: 'present' as const, path: binary };
      // What is there is not a working install: an interrupted one's leftovers.
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(unpacked, target);
      d.log(`Airlock: smolvm ${SMOLVM_VERSION} installed at ${binary}.`);
      return { status: 'installed' as const, path: binary };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}

/** `agenfk airlock install --if-enabled` skipped because it could not tell whether Airlock is on: an installer warns. */
export const INSTALL_SKIPPED_UNKNOWN = 3;

/**
 * `agenfk airlock install [--if-enabled]`. With --if-enabled (what install and upgrade run) it
 * installs only where Airlock is in use: the policy observes or enforces, or a smolvm was
 * installed before (an upgrade brings the new pin). Otherwise it says how to install it later,
 * and exits INSTALL_SKIPPED_UNKNOWN when it could not ask the server.
 */
export async function runAirlockInstall(
  opts: { ifEnabled: boolean },
  d: InstallDeps & { fetchPolicy: () => Promise<{ effective?: { mode?: string } }> },
): Promise<number> {
  if (opts.ifEnabled) {
    const root = path.join(d.home, '.agenfk', 'smolvm');
    const before = (() => { try { return fs.readdirSync(root).some((n) => !n.startsWith('.')); } catch { return false; } })();
    if (!before) {
      let mode: string | undefined;
      try {
        mode = (await d.fetchPolicy())?.effective?.mode;
      } catch (e) {
        d.log(`Airlock: could not tell whether Airlock is on (${(e as Error)?.message ?? e}), so smolvm was not installed. Install it with: agenfk airlock install`);
        return INSTALL_SKIPPED_UNKNOWN;
      }
      if (mode !== 'observe' && mode !== 'enforce') {
        d.log('Airlock is off, so smolvm was not installed. Once you turn it on, install it with: agenfk airlock install (a launch installs it too).');
        return 0;
      }
    }
  }
  try {
    const r = await installSmolvm(d);
    if (r.status === 'present') d.log(`Airlock: smolvm ${SMOLVM_VERSION} is installed at ${r.path}.`);
    return 0;
  } catch (e) {
    d.log(`Airlock: ${(e as Error)?.message ?? e}`);
    return 1;
  }
}
