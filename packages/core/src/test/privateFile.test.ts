/**
 * BUG cc26b206: ~/.agenfk/config.json (JIRA clientSecret) and jira-token.json
 * (access + refresh token) were written with no mode, so under umask 022 they
 * came out 0644 and any local user could read them. writePrivateFileSync is
 * the one writer for files that can hold a secret.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writePrivateFileSync, tightenPrivateFile } from '../privateFile';

const posix = process.platform !== 'win32';
const mode = (p: string) => fs.statSync(p).mode & 0o777;
let dir: string;
let oldUmask: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-private-'));
  // The default most machines run with; it is what turned no-mode into 0644.
  oldUmask = process.umask(0o022);
});
afterEach(() => {
  process.umask(oldUmask);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(posix)('writePrivateFileSync', () => {
  it('creates a new file readable by its owner only', () => {
    const f = path.join(dir, 'config.json');
    writePrivateFileSync(f, '{"jira":{"clientSecret":"s"}}');
    expect(fs.readFileSync(f, 'utf8')).toBe('{"jira":{"clientSecret":"s"}}');
    expect(mode(f)).toBe(0o600);
  });

  it('tightens a file that already exists 0644, since a mode only applies on create', () => {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{}', { mode: 0o644 });
    expect(mode(f)).toBe(0o644);
    writePrivateFileSync(f, '{"a":1}');
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}');
  });

  it('replaces the file rather than rewriting it, so a descriptor opened while it was 0644 cannot read the new secret', () => {
    // Review finding: an in-place rewrite keeps the inode, and chmod does not
    // revoke a descriptor another local user already holds.
    const f = path.join(dir, 'jira-token.json');
    fs.writeFileSync(f, 'old', { mode: 0o644 });
    const held = fs.openSync(f, 'r');
    try {
      writePrivateFileSync(f, 'NEW-REFRESH-TOKEN');
      const buf = Buffer.alloc(64);
      const n = fs.readSync(held, buf, 0, 64, 0);
      expect(buf.subarray(0, n).toString()).toBe('old');
    } finally { fs.closeSync(held); }
    expect(fs.readFileSync(f, 'utf8')).toBe('NEW-REFRESH-TOKEN');
    expect(mode(f)).toBe(0o600);
  });

  it('leaves no temp file behind, on success or when the write fails', () => {
    const f = path.join(dir, 'config.json');
    writePrivateFileSync(f, '{}');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
    fs.mkdirSync(path.join(dir, 'blocked.json')); // a directory where the file should go: rename fails
    expect(() => writePrivateFileSync(path.join(dir, 'blocked.json'), '{}')).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(['blocked.json', 'config.json']);
  });

  it('keeps a symlinked file a symlink and writes where it points', () => {
    // Re-review finding: a config.json kept in a dotfiles repo.
    const real = path.join(dir, 'dotfiles-config.json');
    fs.writeFileSync(real, '{}', { mode: 0o644 });
    const link = path.join(dir, 'config.json');
    fs.symlinkSync(real, link);
    writePrivateFileSync(link, '{"a":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a":1}');
    expect(mode(real)).toBe(0o600);
  });

  it('creates the missing directory', () => {
    const f = path.join(dir, 'fresh', '.agenfk', 'jira-token.json');
    writePrivateFileSync(f, 'x');
    expect(mode(f)).toBe(0o600);
  });
});

describe.runIf(posix)('tightenPrivateFile', () => {
  it('takes an existing 0644 file to 0600 and leaves its content alone', () => {
    const f = path.join(dir, 'jira-token.json');
    fs.writeFileSync(f, 'tok', { mode: 0o644 });
    tightenPrivateFile(f);
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe('tok');
  });

  it('does nothing, and does not throw, when the file is not there', () => {
    const f = path.join(dir, 'missing.json');
    expect(() => tightenPrivateFile(f)).not.toThrow();
    expect(fs.existsSync(f)).toBe(false);
  });
});
