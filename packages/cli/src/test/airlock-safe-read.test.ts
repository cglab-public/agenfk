/**
 * CGLAB-696 review: the launcher reads files the session can write (the workspace's lockfiles) on
 * the host. readRegularFile reads only a regular file, never through a link, never blocking on a
 * FIFO the session planted, never past a size cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { transformSync } from 'esbuild';
import { readRegularFile } from '../airlock/safeRead';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-safe-read-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readRegularFile', () => {
  it('reads a regular file', () => {
    fs.writeFileSync(path.join(dir, 'f'), 'hello');
    expect(readRegularFile(path.join(dir, 'f'), 100)?.toString()).toBe('hello');
  });

  it('is null for a missing file, a directory, and a file over the cap', () => {
    fs.writeFileSync(path.join(dir, 'big'), 'x'.repeat(101));
    expect(readRegularFile(path.join(dir, 'missing'), 100)).toBeNull();
    expect(readRegularFile(dir, 100)).toBeNull();
    expect(readRegularFile(path.join(dir, 'big'), 100)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('is null for a link, even to a regular file', () => {
    fs.writeFileSync(path.join(dir, 'f'), 'hello');
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'));
    expect(readRegularFile(path.join(dir, 'l'), 100)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('returns null for a FIFO at once, not blocking on it (run in a child: a blocked read cannot be interrupted)', () => {
    const fifo = path.join(dir, 'package-lock.json');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const src = fs.readFileSync(path.join(__dirname, '..', 'airlock', 'safeRead.ts'), 'utf8');
    const mod = path.join(dir, 'safeRead.cjs');
    fs.writeFileSync(mod, transformSync(src, { loader: 'ts', format: 'cjs' }).code);
    const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(mod)}).readRegularFile(${JSON.stringify(fifo)}, 100)))`], { timeout: 5000, encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe('null');
  });
});
