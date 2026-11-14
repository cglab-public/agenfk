/**
 * GH #312: the pure parts of the per-verify git memo - which commands it may
 * answer from a first answer, and when it must forget - against a fake runner,
 * so no git is spawned. The end-to-end behaviour (spawn ceilings, fences) is
 * pinned by verify-git-spawns.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createGitMemo, fenceOf, gitStateMayHaveMoved, isReadOnlyGit, type GitRunner } from '../gitMemo';

describe('isReadOnlyGit', () => {
  it.each([
    [['status', '--porcelain']],
    [['-C', '/repo', 'rev-parse', 'HEAD']],
    [['-c', 'core.quotepath=off', 'ls-files', '-z']],
    [['remote']],
    [['remote', 'get-url', 'origin']],
    [['config', '--get', 'user.name']],
    [['config', 'branch.main.remote']],
    [['branch', '--show-current']],
  ])('reads: git %j', (args) => {
    expect(isReadOnlyGit(args)).toBe(true);
  });

  it.each([
    [['commit', '-m', 'x']],
    [['add', '-A']],
    [['fetch', 'origin']],
    [['remote', 'add', 'o', 'u']],
    [['config', 'user.name', 'someone']],
    [['config', '--unset', 'user.name']],
    [['branch', 'new-branch']],
    [['branch', '-D', 'old']],
    [['branch']],
    [['some-unknown-subcommand']],
    [[]],
  ])('writes (or is not known to only read): git %j', (args) => {
    expect(isReadOnlyGit(args)).toBe(false);
  });
});

/** A runner that answers from a table and counts what it was asked. */
function fakeRunner(answer: (args: readonly string[]) => string) {
  const calls: string[] = [];
  const raw: GitRunner = { run: (args) => { calls.push(args.join(' ')); return answer(args); } };
  return { raw, calls };
}

describe('createGitMemo', () => {
  it('answers a repeated read from its first answer, and runs every write', () => {
    const { raw, calls } = fakeRunner(() => 'out');
    const memo = createGitMemo(raw);
    expect(memo.run(['status', '--porcelain'])).toBe('out');
    expect(memo.run(['status', '--porcelain'])).toBe('out');
    memo.run(['add', 'x']);
    memo.run(['add', 'x']);
    expect(calls).toEqual(['status --porcelain', 'add x', 'add x']);
  });

  it('forgets what it read once the tree may have moved (a write, or any child elsewhere)', () => {
    const { raw, calls } = fakeRunner(() => 'out');
    const memo = createGitMemo(raw);
    memo.run(['rev-parse', 'HEAD']);
    gitStateMayHaveMoved();
    memo.run(['rev-parse', 'HEAD']);
    memo.run(['commit', '-m', 'x']);
    memo.run(['rev-parse', 'HEAD']);
    expect(calls.filter(c => c === 'rev-parse HEAD')).toHaveLength(3);
  });

  it('spells -C one way: the same tree asked with another separator is one query', () => {
    const { raw, calls } = fakeRunner(() => 'out');
    const memo = createGitMemo(raw);
    memo.run(['-C', ['C:', 'repo'].join(String.fromCharCode(92)), 'rev-parse', 'HEAD']); // C:<backslash>repo
    memo.run(['-C', 'C:/repo', 'rev-parse', 'HEAD']);
    expect(calls).toHaveLength(1);
  });

  it('keeps a settled failure (an absent ref answers the same twice), not a timeout', () => {
    const absent = Object.assign(new Error('exit 1'), { status: 1 });
    const timedOut = Object.assign(new Error('killed'), { status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' });
    const { raw, calls } = fakeRunner((args) => { throw args.includes('MERGE_HEAD') ? absent : timedOut; });
    const memo = createGitMemo(raw);
    for (let i = 0; i < 2; i++) expect(() => memo.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toThrow(absent);
    for (let i = 0; i < 2; i++) expect(() => memo.run(['log', '-1'])).toThrow(timedOut);
    expect(calls).toEqual(['rev-parse -q --verify MERGE_HEAD', 'log -1', 'log -1']);
  });

  it('asks git again when the kept answer is larger than this caller allows', () => {
    const { raw, calls } = fakeRunner(() => 'x'.repeat(100));
    const memo = createGitMemo(raw);
    memo.run(['ls-files']);
    memo.run(['ls-files'], { maxBuffer: 10 });
    expect(calls).toHaveLength(2);
  });

  it('its fence goes to git for a tree read, but may answer where the root sits', () => {
    const { raw, calls } = fakeRunner(() => 'out');
    const memo = createGitMemo(raw);
    memo.run(['status', '--porcelain']);
    memo.run(['rev-parse', '--show-prefix']);
    memo.fence.run(['status', '--porcelain']);
    memo.fence.run(['rev-parse', '--show-prefix']);
    expect(calls).toEqual(['status --porcelain', 'rev-parse --show-prefix', 'status --porcelain']);
    expect(fenceOf(memo)).toBe(memo.fence);
    expect(fenceOf(raw)).toBe(raw);
  });
});
