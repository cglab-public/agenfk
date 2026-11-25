/**
 * Contract of bin/copy-tree.mjs (#349): the plain-JS recursive copy the npx
 * bootstrap and the hub use instead of fs.cpSync, which aborts the process
 * natively on Windows + Node 22 when a path holds a space and non-ASCII letters.
 *
 * Every copy runs in a CHILD node process and the spec asserts its exit status
 * and the resulting tree. A native abort then shows up as a failed assertion
 * (exit 3) instead of killing the vitest worker, and a missing module shows up
 * as the child's stderr. Source fixtures are built with plain fs, never
 * fs.cpSync; the one cpSync use is the ASCII-only parity check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const HELPER_URL = pathToFileURL(path.resolve(__dirname, '../../../../bin/copy-tree.mjs')).href;

const CHILD = `
const { copyTree } = await import(process.env.HELPER_URL);
const cfg = JSON.parse(process.env.CFG);
const calls = [];
const opts = {};
const base = (p) => p.split(/[\\\\/]/).pop();
if (cfg.filter) {
  opts.filter = (s, d) => {
    calls.push([s, d]);
    if (cfg.filter === 'mac') return !(base(s).startsWith('._') || base(s) === '.DS_Store');
    if (cfg.filter === 'rejectName') return base(s) !== cfg.name;
    if (cfg.filter === 'rejectRoot') return false;
    return true;
  };
}
if (cfg.preserveTimestamps !== undefined) opts.preserveTimestamps = cfg.preserveTimestamps;
let thrown = null;
try { await copyTree(cfg.src, cfg.dst, opts); } catch (e) { thrown = { code: e && e.code, message: String(e && e.message) }; }
process.stdout.write('\\nRESULT:' + JSON.stringify({ calls, thrown }) + '\\n');
`;

interface Cfg { src: string; dst: string; filter?: 'record' | 'mac' | 'rejectName' | 'rejectRoot'; name?: string; preserveTimestamps?: boolean }

function runCopy(cfg: Cfg) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HELPER_URL, CFG: JSON.stringify(cfg) },
  });
  const m = /RESULT:(.*)\n/.exec(r.stdout || '');
  const result = m ? (JSON.parse(m[1]) as { calls: [string, string][]; thrown: { code?: string; message: string } | null }) : { calls: [], thrown: null };
  return { status: r.status, stderr: r.stderr, ...result };
}

const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-symprobe-'));
  try { fs.writeFileSync(path.join(d, 't'), 'x'); fs.symlinkSync('t', path.join(d, 'l')); return true; }
  catch { return false; }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

let work: string;
let src: string;
let dst: string;

const write = (p: string, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, 'utf8'); };
const read = (p: string) => fs.readFileSync(p, 'utf8');
const norm = (p: string) => path.resolve(p);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk install hôme ção-'));
  src = path.join(work, 'sôurce trée');
  dst = path.join(work, 'dëst ção', 'install dir');
  write(path.join(src, 'top.txt'), 'top');
  write(path.join(src, 'commands', 'agenfk.md'), 'cmd');
  write(path.join(src, 'commands', 'nested', 'deep ção.txt'), 'deep');
});
afterEach(() => { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('bin/copy-tree.mjs copyTree', () => {
  it('copies a nested tree between accented, spaced paths (child exits 0)', () => {
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    expect(r.thrown).toBeNull();
    expect(read(path.join(dst, 'top.txt'))).toBe('top');
    expect(read(path.join(dst, 'commands', 'agenfk.md'))).toBe('cmd');
    expect(read(path.join(dst, 'commands', 'nested', 'deep ção.txt'))).toBe('deep');
  });

  it('copies empty directories', () => {
    fs.mkdirSync(path.join(src, 'empty', 'inner'), { recursive: true });
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.statSync(path.join(dst, 'empty', 'inner')).isDirectory()).toBe(true);
  });

  it('creates missing dest parents recursively', () => {
    const deep = path.join(work, 'a', 'b ç', 'c', 'target');
    const r = runCopy({ src, dst: deep });
    expect(r.status, r.stderr).toBe(0);
    expect(read(path.join(deep, 'top.txt'))).toBe('top');
  });

  it('overwrites an existing dest file', () => {
    write(path.join(dst, 'top.txt'), 'OLD');
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    expect(read(path.join(dst, 'top.txt'))).toBe('top');
  });

  it('merges into an existing dest dir and never deletes extra dest files', () => {
    write(path.join(dst, 'keep-me.txt'), 'mine');
    write(path.join(dst, 'commands', 'stale.md'), 'stale');
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    expect(read(path.join(dst, 'keep-me.txt'))).toBe('mine');
    expect(read(path.join(dst, 'commands', 'stale.md'))).toBe('stale');
    expect(read(path.join(dst, 'commands', 'agenfk.md'))).toBe('cmd');
  });

  it('calls filter(src, dest) on the root first and on every dir and file entry', () => {
    const r = runCopy({ src, dst, filter: 'record' });
    expect(r.status, r.stderr).toBe(0);
    expect(norm(r.calls[0][0])).toBe(norm(src));
    expect(norm(r.calls[0][1])).toBe(norm(dst));
    const seen = new Set(r.calls.map(([s, d]) => `${norm(s)}=>${norm(d)}`));
    for (const rel of ['top.txt', 'commands', path.join('commands', 'agenfk.md'), path.join('commands', 'nested'), path.join('commands', 'nested', 'deep ção.txt')]) {
      expect(seen.has(`${norm(path.join(src, rel))}=>${norm(path.join(dst, rel))}`), rel).toBe(true);
    }
  });

  it('does not descend into a directory the filter rejects', () => {
    const r = runCopy({ src, dst, filter: 'rejectName', name: 'nested' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dst, 'commands', 'agenfk.md'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'commands', 'nested'))).toBe(false);
    // Rejected dirs are not walked, so their children never reach the filter.
    expect(r.calls.some(([s]) => path.basename(s) === 'deep ção.txt')).toBe(false);
  });

  it('copies nothing when the filter rejects the root', () => {
    const r = runCopy({ src, dst, filter: 'rejectRoot' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dst, 'top.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'commands'))).toBe(false);
  });

  it('excludes ._x and .DS_Store with a copyFilter like bin/agenfk.js', () => {
    write(path.join(src, '._top.txt'), 'apple');
    write(path.join(src, '.DS_Store'), 'finder');
    write(path.join(src, 'commands', '._agenfk.md'), 'apple');
    write(path.join(src, 'commands', 'nested', '.DS_Store'), 'finder');
    const r = runCopy({ src, dst, filter: 'mac' });
    expect(r.status, r.stderr).toBe(0);
    expect(read(path.join(dst, 'top.txt'))).toBe('top');
    expect(read(path.join(dst, 'commands', 'agenfk.md'))).toBe('cmd');
    expect(fs.existsSync(path.join(dst, '._top.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dst, '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'commands', '._agenfk.md'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'commands', 'nested', '.DS_Store'))).toBe(false);
  });

  it.skipIf(!canSymlink)('recreates a symlink as a link, not as a copy of its target', () => {
    fs.symlinkSync('top.txt', path.join(src, 'link-to-top'));
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    const st = fs.lstatSync(path.join(dst, 'link-to-top'));
    expect(st.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dst, 'link-to-top'))).toBe('top.txt');
  });

  it.skipIf(!canSymlink)('refuses to replace an existing destination directory with a symlink and deletes nothing', () => {
    fs.symlinkSync('top.txt', path.join(src, 'link-to-top'));
    write(path.join(dst, 'link-to-top', 'precious.txt'), 'keep');
    const r = runCopy({ src, dst });
    expect(r.thrown).not.toBeNull();
    expect(r.thrown!.message).toContain(path.join(dst, 'link-to-top'));
    expect(fs.lstatSync(path.join(dst, 'link-to-top')).isDirectory()).toBe(true);
    expect(read(path.join(dst, 'link-to-top', 'precious.txt'))).toBe('keep');
  });

  it.skipIf(!canSymlink)('replaces an existing destination file or symlink with the source link', () => {
    fs.symlinkSync('top.txt', path.join(src, 'link-a'));
    fs.symlinkSync('top.txt', path.join(src, 'link-b'));
    write(path.join(dst, 'link-a'), 'regular file');
    fs.symlinkSync('elsewhere', path.join(dst, 'link-b'));
    const r = runCopy({ src, dst });
    expect(r.status, r.stderr).toBe(0);
    expect(r.thrown).toBeNull();
    for (const n of ['link-a', 'link-b']) {
      expect(fs.lstatSync(path.join(dst, n)).isSymbolicLink(), n).toBe(true);
      expect(fs.readlinkSync(path.join(dst, n)), n).toBe('top.txt');
    }
  });

  it('throws (child reports it) for a missing source', () => {
    const r = runCopy({ src: path.join(work, 'does not exist ção'), dst });
    expect(r.status, r.stderr).toBe(0);
    expect(r.thrown).not.toBeNull();
    expect(fs.existsSync(path.join(dst, 'top.txt'))).toBe(false);
  });

  it('calls the filter with the same (src, dest) pairs as fs.cpSync on an ASCII tree', () => {
    const asciiSrc = path.join(work, 'ascii-src');
    const asciiDst = path.join(work, 'ascii-dst');
    const cpDst = path.join(work, 'ascii-cp-dst');
    write(path.join(asciiSrc, 'a.txt'), 'a');
    write(path.join(asciiSrc, 'd1', 'b.txt'), 'b');
    write(path.join(asciiSrc, 'd1', 'd2', 'c.txt'), 'c');
    fs.mkdirSync(path.join(asciiSrc, 'empty'));

    const expected: [string, string][] = [];
    fs.cpSync(asciiSrc, cpDst, { recursive: true, filter: (s, d) => { expected.push([s, d]); return true; } });
    // cpSync was handed cpDst; the helper gets asciiDst, so compare relative to each root.
    const rel = (pairs: [string, string][], sRoot: string, dRoot: string) =>
      pairs.map(([s, d]) => `${path.relative(norm(sRoot), norm(s))}=>${path.relative(norm(dRoot), norm(d))}`);

    const r = runCopy({ src: asciiSrc, dst: asciiDst, filter: 'record' });
    expect(r.status, r.stderr).toBe(0);
    const got = rel(r.calls, asciiSrc, asciiDst);
    const want = rel(expected, asciiSrc, cpDst);
    expect(new Set(got)).toEqual(new Set(want));
    expect(got).toHaveLength(want.length);
    expect(got[0]).toBe(want[0]); // the root comes first (relative path '' => '')
  });
});
