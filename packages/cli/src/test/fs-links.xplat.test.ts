/**
 * @file GitHub #208 phase 3 — the links specs make, on every OS.
 *
 * A handful of specs symlink a DIRECTORY to prove the product refuses to follow
 * it (a prune that would delete outside the install dir, a report path that
 * leaves the tree, a walk that would loop) or sees through it (the install dir
 * reached by another spelling). On Windows `fs.symlinkSync` needs admin or
 * Developer Mode and fails with EPERM, so every one of them died before
 * asserting anything. A directory JUNCTION needs neither, and it is what a
 * Windows user (or tool) actually makes: `linkDir` makes a symlink off Windows
 * and a junction on it, and what it makes must look like a link to the code
 * under test exactly as a symlink does.
 *
 * A FILE cannot be the target of a junction. `canSymlink()` says, once, whether
 * this process may make a real symlink, so the one spec that needs a file link
 * runs wherever that is allowed (Linux CI, Windows with Developer Mode) and is
 * skipped - with its reason - only where it cannot be built.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkDir, canSymlink } from './helpers/links';

let work = '';
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); work = ''; });
const tmp = () => (work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-links-')));

describe('linkDir()', () => {
  it('makes a link lstat calls a symbolic link, leading to the target', () => {
    const dir = tmp();
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside.txt'), 'x');
    const link = path.join(dir, 'link');

    linkDir(target, link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(link).isDirectory()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
    expect(fs.readdirSync(link)).toEqual(['inside.txt']);
    expect(path.resolve(dir, fs.readlinkSync(link))).toBe(path.resolve(target));
  });

  it('reads a relative target against the link\'s own directory, as a symlink does', () => {
    // `linkDir('.', tests/l0)` must make a loop back to tests/, not a link to
    // whatever the process cwd happens to be.
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'real.ts'), 'x');

    linkDir('.', path.join(dir, 'tests', 'l0'));

    expect(fs.realpathSync(path.join(dir, 'tests', 'l0'))).toBe(fs.realpathSync(path.join(dir, 'tests')));
    expect(fs.existsSync(path.join(dir, 'tests', 'l0', 'l0', 'real.ts'))).toBe(true);
  });

  it('removing the link leaves the target and its contents alone', () => {
    const dir = tmp();
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep');
    const link = path.join(dir, 'link');
    linkDir(target, link);

    fs.rmSync(link, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('keep');
  });
});

describe('canSymlink()', () => {
  it('reports truthfully whether this process may make a file symlink', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    let allowed: boolean;
    try {
      fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'), 'file');
      allowed = fs.lstatSync(path.join(dir, 'l')).isSymbolicLink();
    } catch {
      allowed = false;
    }
    expect(canSymlink()).toBe(allowed);
  });

  it('is always true off Windows, where a symlink needs no privilege', () => {
    if (process.platform !== 'win32') expect(canSymlink()).toBe(true);
  });

  it('answers the same twice without leaving its probe behind', () => {
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('agenfk-canSymlink-')).length;
    expect(canSymlink()).toBe(canSymlink());
    expect(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('agenfk-canSymlink-')).length).toBe(before);
  });
});
