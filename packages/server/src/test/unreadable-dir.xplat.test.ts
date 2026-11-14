/**
 * @file GitHub #208 phase 3 — a directory the specs can make unreadable, on every OS.
 *
 * sync-install-dir's prune must fail closed over a source subtree it cannot
 * list and stay lenient over a destination one. The specs made the directory
 * unreadable with `chmod 000`, which on Windows sets a read-only attribute that
 * directory listing ignores: the "unreadable" directory was read, and the
 * prune deleted what the spec exists to keep. An explicit deny ACE on listing
 * (icacls /deny ...:(RD)) is the Windows equivalent: readdir fails with EPERM
 * as it fails with EACCES under chmod 000. Either way it must always be undone,
 * or the spec's temp dir can never be removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canMakeUnreadable, makeUnreadable, readsThroughDenials } from './helpers/unreadableDir';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let work = '';
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); work = ''; });

describe('makeUnreadable()', () => {
  // root reads through chmod 000, and a Windows admin with the backup privilege
  // (GitHub's runner) reads through the deny ACE. Skipped on THAT - the
  // environment - never on canMakeUnreadable(), which calls the function under
  // test: a broken makeUnreadable() would then skip the spec that catches it.
  it.skipIf(readsThroughDenials())('makes listing the directory fail, and the returned restore undoes it', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-unreadable-'));
    const dir = path.join(work, 'locked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');

    const restore = makeUnreadable(dir);
    let code = '';
    try {
      fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    } finally {
      restore();
    }

    expect(['EACCES', 'EPERM']).toContain(code);
    expect(fs.readdirSync(dir)).toEqual(['x.md']);
  });

  it.skipIf(isRoot)('leaves a directory that can be removed once restored', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-unreadable-'));
    const dir = path.join(work, 'locked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.md'), 'x');

    makeUnreadable(dir)();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(fs.existsSync(work)).toBe(false);
    work = '';
  });
});

describe('canMakeUnreadable()', () => {
  // The specs that need an unreadable directory skip on this probe. Wherever
  // the environment does not read through a denial it must say yes, or those
  // specs would turn into skips without anything going red.
  it.skipIf(readsThroughDenials())('says yes wherever the environment does not read through a denial', () => {
    expect(canMakeUnreadable()).toBe(true);
  });
});
