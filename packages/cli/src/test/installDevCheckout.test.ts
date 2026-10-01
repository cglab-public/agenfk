/**
 * 658ef023 (Codex review): scripts/install.mjs re-downloaded a release over
 * its root when the build output was missing - from a development checkout
 * too, which is the same overwrite `agenfk upgrade` was stopped from doing.
 * The checkout test is install-helpers' isDevCheckout, by filesystem identity.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
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
    const ids: Record<string, { dev: bigint; ino: bigint }> = {
      a: { dev: 1n, ino: 9007199254740992n },
      b: { dev: 1n, ino: 9007199254740993n },
    };
    expect(Number(ids.a.ino) === Number(ids.b.ino)).toBe(true); // the trap
    expect(sameDirectory('a', 'b', (p: string) => ids[p])).toBe(false);
  });

  it('never calls two paths the same on an inode of 0, which is no identity', () => {
    const zero = (_p: string) => ({ dev: 1n, ino: 0n });
    expect(sameDirectory('a', 'b', zero)).toBe(false);
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
