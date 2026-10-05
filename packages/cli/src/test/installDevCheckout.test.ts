/**
 * 658ef023 (Codex review): scripts/install.mjs re-downloaded a release over
 * its root when the build output was missing - from a development checkout
 * too, which is the same overwrite `agenfk upgrade` was stopped from doing.
 * The checkout test is install-helpers' isDevCheckout, by filesystem identity.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';

/**
 * Fake identities for a few paths, served by statSync itself - the call the
 * helper really makes. A plain (non-BigInt) stat gets the inode as a NUMBER,
 * rounded the way the real one rounds a 64-bit value, so a helper that drops
 * `{ bigint: true }` is caught.
 */
const ids: Record<string, { dev: bigint; ino: bigint }> = {};
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  const statSync = ((p: any, o?: any) => {
    const id = ids[String(p)];
    if (!id) return real.statSync(p, o);
    return o?.bigint ? { dev: id.dev, ino: id.ino } : { dev: Number(id.dev), ino: Number(id.ino) };
  }) as typeof real.statSync;
  return { ...real, statSync, default: { ...real, statSync } };
});
import * as os from 'os';
import * as path from 'path';
import { isDevCheckout, sameDirectory } from '../../../../scripts/install-helpers.mjs';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `agenfk-${name}-`));

describe('isDevCheckout', () => {
  it('is a tree holding .git - a directory, or the file a worktree has', () => {
    const dir = tmp('checkout');
    fs.mkdirSync(path.join(dir, '.git'));
    expect(isDevCheckout(dir)).toBe(true);
    const worktree = tmp('worktree');
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isDevCheckout(worktree)).toBe(true);
  });

  it('is not an installed copy, which ships no .git', () => {
    expect(isDevCheckout(tmp('install'))).toBe(false);
  });

  it('is not ~/.agenfk-system, a clone in real installs - however it is reached', () => {
    const home = tmp('home');
    const installDir = path.join(home, '.agenfk-system');
    fs.mkdirSync(path.join(installDir, '.git'), { recursive: true });
    expect(isDevCheckout(installDir, home)).toBe(false);
    // Reached through a symlink: the same directory, so still the install.
    const link = path.join(tmp('link'), 'agenfk');
    fs.symlinkSync(installDir, link);
    expect(sameDirectory(link, installDir)).toBe(true);
    expect(isDevCheckout(link, home)).toBe(false);
  });
});

describe('sameDirectory, when identities are not to be trusted', () => {
  it('keeps 64-bit inodes apart that plain numbers would round together', () => {
    ids['/fake/a'] = { dev: 1n, ino: 9007199254740992n };
    ids['/fake/b'] = { dev: 1n, ino: 9007199254740993n };
    expect(Number(ids['/fake/a'].ino) === Number(ids['/fake/b'].ino)).toBe(true); // the trap
    expect(sameDirectory('/fake/a', '/fake/b')).toBe(false);
  });

  it('never calls two paths the same on an inode of 0, which is no identity', () => {
    ids['/fake/z1'] = { dev: 1n, ino: 0n };
    ids['/fake/z2'] = { dev: 1n, ino: 0n };
    expect(sameDirectory('/fake/z1', '/fake/z2')).toBe(false);
  });

  it('still calls one directory the same as itself', () => {
    ids['/fake/same'] = { dev: 7n, ino: 42n };
    expect(sameDirectory('/fake/same', '/fake/same')).toBe(true);
  });
});

describe('install.mjs', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/install.mjs'), 'utf8');

  it('stops on missing build output in a checkout, before any auto-heal download', () => {
    const stop = src.indexOf('missingDists.length > 0 && isDevCheckout(rootDir)');
    const heal = src.indexOf("debugLog('trigger: missing dists → attempting auto-heal re-download')");
    expect(stop).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(stop);
  });

  it('refuses inside autoHealRedownload too, before it fetches anything', () => {
    const body = src.slice(src.indexOf('async function autoHealRedownload()'));
    expect(body.indexOf('isDevCheckout(rootDir)')).toBeGreaterThan(-1);
    expect(body.indexOf('isDevCheckout(rootDir)')).toBeLessThan(body.indexOf("spawnSync('curl'"));
  });
});
