/**
 * @file #208 review — a project's git remote, read for hub events.
 *
 * A lookup that timed out used to be cached as "no remote" for the life of the
 * server, so one slow first `git remote get-url` (a loaded Windows box) shipped
 * every later event of that project without its remoteUrl. And on Windows the
 * timeout's plain kill ended git.exe - a wrapper - while the real git ran on in
 * the project's root, holding it open.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { oneInFlight, readRemoteUrl, readAirlockRemoteUrl, remoteCacheLifetimeMs } from '../projectRemote';
import { removeTempDir } from './helpers/tempDir';
import { linkDir } from '../../../cli/src/test/helpers/links';

describe('readRemoteUrl()', () => {
  it('answers the origin URL, to be remembered', async () => {
    const r = await readRemoteUrl('/repo', { run: async () => ({ out: 'git@github.com:o/r.git\n', timedOut: false }) });
    expect(r).toEqual({ url: 'git@github.com:o/r.git', cacheable: true });
  });

  it('answers no remote, to be remembered, when git says there is none', async () => {
    expect(await readRemoteUrl('/repo', { run: async () => ({ out: '', timedOut: false }) })).toEqual({ url: '', cacheable: true });
  });

  it('answers no remote but NOT to be remembered when the lookup timed out: the next event asks again', async () => {
    expect(await readRemoteUrl('/repo', { run: async () => ({ out: '', timedOut: true }) })).toEqual({ url: '', cacheable: false });
  });

  // Remembered forever, one slow lookup lost the remote for the server's life; asked again
  // on every event, each event of a slow project waited the full 1.5 s (a test under load
  // missed its hub event). A timeout is remembered briefly, then asked again.
  it('keeps a real answer for good, and a timed-out one for a minute', () => {
    expect(remoteCacheLifetimeMs({ url: 'x', cacheable: true })).toBeUndefined();
    expect(remoteCacheLifetimeMs({ url: '', cacheable: true })).toBeUndefined();
    expect(remoteCacheLifetimeMs({ url: '', cacheable: false })).toBe(60_000);
  });

  // A verify that closes a card emits two events back to back: each started its own lookup,
  // and a late timeout overwrote the good URL the other had just cached (review of f94e1694).
  it('runs one lookup per project at a time: concurrent callers share it, and a later one starts afresh', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const warm = oneInFlight(async (id: string) => { started.push(id); await gate; });
    const a = warm('p1'); const b = warm('p1'); const c = warm('p2');
    expect(started).toEqual(['p1', 'p2']);
    release();
    await Promise.all([a, b, c]);
    await warm('p1');
    expect(started).toEqual(['p1', 'p2', 'p1']);
  });

  it('a failed lookup does not stick: the next caller starts afresh', async () => {
    let calls = 0;
    const warm = oneInFlight(async () => { calls++; throw new Error('boom'); });
    await expect(warm('p')).rejects.toThrow('boom');
    await expect(warm('p')).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('reads a real repository with its own git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/o/r.git'], { cwd: dir, windowsHide: true });
      expect(await readRemoteUrl(dir)).toEqual({ url: 'https://example.com/o/r.git', cacheable: true });
    } finally {
      removeTempDir(dir);
    }
  });

  // PO-1 review 2: Airlock fails closed on an answer that is not git's own.
  it('git saying there is no origin, or no repository, is an answer; anything else is a failed lookup, not remembered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      expect(await readRemoteUrl(dir)).toEqual({ url: '', cacheable: true });
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      expect(await readRemoteUrl(dir)).toEqual({ url: '', cacheable: true });
      expect(await readRemoteUrl(path.join(dir, 'gone'))).toEqual({ url: '', cacheable: false });
      // git runs and fails (a broken config): not an answer about the remote
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[core\n  this is not config\n');
      expect(await readRemoteUrl(dir)).toEqual({ url: '', cacheable: false });
      expect(await readRemoteUrl('/repo', { run: async () => ({ out: '', timedOut: false, failed: true }) })).toEqual({ url: '', cacheable: false });
    } finally {
      removeTempDir(dir);
    }
  });

  // PO-1 review 4: Airlock reads the origin as .git/config records it, which a sandbox cannot write.
  it('for Airlock: the origin from .git/config, without url rewrites or worktree config a sandbox could write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: '', cacheable: true });
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: '', cacheable: true });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['config', '--worktree', 'url.https://github.com/acme/loose.git.insteadOf', 'https://github.com/acme/api.git'], { cwd: dir, windowsHide: true });
      // what git remote get-url says, rewritten
      expect((await readRemoteUrl(dir)).url).toBe('https://github.com/acme/loose.git');
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: 'https://github.com/acme/api.git', cacheable: true });
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[core\n  this is not config\n');
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: '', cacheable: false });
    } finally {
      removeTempDir(dir);
    }
  });

  it('for Airlock: only <root>/.git/config, read as a file: no commondir, and a .git that is not a directory fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['init', '-q', '--bare'], { cwd: other, windowsHide: true });
      execFileSync('git', ['config', 'remote.origin.url', 'https://github.com/acme/loose.git'], { cwd: other, windowsHide: true });
      fs.writeFileSync(path.join(dir, '.git', 'commondir'), other + '\n');
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: 'https://github.com/acme/api.git', cacheable: true });
      fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git2'));
      fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${other}\n`);
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: '', cacheable: false });
      fs.rmSync(path.join(dir, '.git'));
      linkDir(other, path.join(dir, '.git')); // a junction on Windows, where a symlink needs admin: lstat calls it a link too
      expect(await readAirlockRemoteUrl(dir)).toEqual({ url: '', cacheable: false });
    } finally {
      removeTempDir(dir);
      removeTempDir(other);
    }
  });

  it('for Airlock: a project rooted below its checkout reads the checkout\'s .git, as git would', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-remote-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/mono.git'], { cwd: dir, windowsHide: true });
      const sub = path.join(dir, 'packages', 'service');
      fs.mkdirSync(sub, { recursive: true });
      expect(await readAirlockRemoteUrl(sub)).toEqual({ url: 'https://github.com/acme/mono.git', cacheable: true });
    } finally {
      removeTempDir(dir);
    }
  });
});
