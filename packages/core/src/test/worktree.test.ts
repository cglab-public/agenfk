/**
 * CGLAB-166: every item gets its own git worktree, so several agents can work
 * at once without fighting over one working tree.
 *
 * This file covers the pure path/name derivation in core. The git plumbing
 * (worktree add/list/remove) and the auto-create-on-transition behaviour live
 * in the server and are tested there — here we pin down the naming contract
 * those layers depend on, because a collision in this function means two
 * agents silently sharing a directory.
 */
import { describe, it, expect } from 'vitest';
import { ItemType } from '../types.js';
import { buildWorktreePath, buildBranchName } from '../utils.js';

const ROOT = '/home/dev/.agenfk/worktrees';

describe('buildWorktreePath', () => {
  it('places a worktree under <root>/<repo>/<readable-slug>-<digest>', () => {
    // The slug keeps the directory recognisable when you `cd` into it; the
    // digest of the FULL branch name is what actually guarantees uniqueness,
    // since slugifying is lossy (see the "differ only past the slash" and
    // "long branches sharing a prefix" cases below).
    const p = buildWorktreePath(ROOT, 'agenfk', 'feature/electron-shell');
    expect(p.startsWith('/home/dev/.agenfk/worktrees/agenfk/')).toBe(true);
    const leaf = p.slice('/home/dev/.agenfk/worktrees/agenfk/'.length);
    expect(leaf).toMatch(/^feature-electron-shell-[0-9a-f]{8}$/);
  });

  it('keeps two different branches of the same repo apart', () => {
    const a = buildWorktreePath(ROOT, 'agenfk', 'feature/serve-ui');
    const b = buildWorktreePath(ROOT, 'agenfk', 'feature/auto-worktree');
    expect(a).not.toBe(b);
  });

  it('keeps the same branch name in two repos apart', () => {
    const a = buildWorktreePath(ROOT, 'agenfk', 'feature/login');
    const b = buildWorktreePath(ROOT, 'horizon-lab', 'feature/login');
    expect(a).not.toBe(b);
  });

  it('is deterministic — asking twice yields the same directory', () => {
    expect(buildWorktreePath(ROOT, 'agenfk', 'fix/CGLAB-1_bug')).toBe(
      buildWorktreePath(ROOT, 'agenfk', 'fix/CGLAB-1_bug'),
    );
  });

  it('never lets a branch name escape the root directory', () => {
    // A branch called ../../etc must not resolve outside <root>/<repo>.
    // git allows surprising refnames; the filesystem must not inherit them.
    const p = buildWorktreePath(ROOT, 'agenfk', '../../../etc/passwd');
    expect(p.startsWith('/home/dev/.agenfk/worktrees/agenfk/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('never lets a repo name escape the root directory', () => {
    const p = buildWorktreePath(ROOT, '../../evil', 'feature/x');
    expect(p.startsWith('/home/dev/.agenfk/worktrees/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('produces no path separators inside the leaf directory name', () => {
    const p = buildWorktreePath(ROOT, 'agenfk', 'feature/a/b/c');
    const leaf = p.slice('/home/dev/.agenfk/worktrees/agenfk/'.length);
    expect(leaf).not.toContain('/');
    expect(leaf.length).toBeGreaterThan(0);
  });

  it('distinguishes branches that differ only past the slash', () => {
    // "feature/a-b" and "feature/a/b" must not both flatten to "feature-a-b".
    const a = buildWorktreePath(ROOT, 'agenfk', 'feature/a-b');
    const b = buildWorktreePath(ROOT, 'agenfk', 'feature/a/b');
    expect(a).not.toBe(b);
  });

  it('still yields a usable directory for a branch of only unsafe characters', () => {
    const p = buildWorktreePath(ROOT, 'agenfk', '///');
    const leaf = p.slice('/home/dev/.agenfk/worktrees/agenfk/'.length);
    expect(leaf.length).toBeGreaterThan(0);
  });

  it('accepts the names buildBranchName actually produces', () => {
    const branch = buildBranchName(ItemType.BUG, 'Login breaks on Safari 17');
    const p = buildWorktreePath(ROOT, 'agenfk', branch);
    expect(p.startsWith('/home/dev/.agenfk/worktrees/agenfk/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('keeps the leaf short enough for filesystems with path limits', () => {
    const long = 'feature/' + 'x'.repeat(400);
    const leaf = buildWorktreePath(ROOT, 'agenfk', long)
      .slice('/home/dev/.agenfk/worktrees/agenfk/'.length);
    expect(leaf.length).toBeLessThanOrEqual(100);
  });

  it('does not collide for two long branches sharing a prefix', () => {
    // Truncation alone would map both to the same directory.
    const a = buildWorktreePath(ROOT, 'agenfk', 'feature/' + 'x'.repeat(200) + 'alpha');
    const b = buildWorktreePath(ROOT, 'agenfk', 'feature/' + 'x'.repeat(200) + 'beta');
    expect(a).not.toBe(b);
  });
});

/**
 * A path cannot hold the server still (CodeQL, PR #182).
 *
 * CodeQL flagged two trailing trims as polynomial regular expressions on
 * uncontrolled data. They read linear, and my instinct was to dismiss them -
 * which is why the card said MEASURE rather than reason. Measured:
 *
 *   `'/'.repeat(100_000) + 'x'` through the root trim → 4,763 ms
 *   the same shape through the slug trim               → 0.1 ms
 *
 * So ONE alert was real and one was not, and the difference is instructive.
 * `[-.]+$` has no start anchor, so with a character after the run the `$` never
 * matches and the engine retries from every position - O(n) starts times O(n)
 * length. The slug escapes it only because two earlier replaces collapse `--`
 * and `..` before the trim ever sees a run. That is accidental safety: it
 * depends on replaces that exist for an unrelated reason, and it would vanish
 * silently the day somebody decided `--` was acceptable in a directory name.
 *
 * Both are loops now. The bounds below are deliberately loose - this is not a
 * performance measurement, which would be flaky. The broken version took
 * SECONDS and a linear one takes under a millisecond; nothing lands between
 * them by accident.
 */
describe('a pathological path (CodeQL, PR #182)', () => {
  it('trims a hostile root without stalling', () => {
    // The alert that was real. Nothing collapses `root` first.
    const started = Date.now();
    buildWorktreePath('/'.repeat(100_000) + 'x', 'repo', 'feat/x');
    expect(Date.now() - started, 'the root trim is backtracking again').toBeLessThan(1000);
  });

  it('trims a hostile branch name without stalling', () => {
    const started = Date.now();
    buildWorktreePath('/root', 'repo', 'x' + '-'.repeat(200_000) + 'x');
    expect(Date.now() - started, 'the slug trim is backtracking again').toBeLessThan(1000);
  });

  it('still trims what it always trimmed', () => {
    /*
     * Fast AND correct. A guard that only watched the clock would pass on an
     * implementation that returned early with nothing, which is the obvious
     * way to make a slow function fast.
     */
    expect(buildWorktreePath('/root///', 'repo', 'feat/x')).toMatch(/^\/root\/repo\//);
    expect(buildWorktreePath('/root', 'repo', '--feat/x--')).toMatch(/\/feat-x/);
    expect(buildWorktreePath('/root', 'repo', '...dotted...')).toMatch(/\/dotted/);
  });

  it('leaves no trailing separator or dot on the segment', () => {
    const out = buildWorktreePath('/root', 'repo', 'x' + '-'.repeat(200_000) + 'x');
    expect(out.endsWith('-')).toBe(false);
    expect(out.endsWith('.')).toBe(false);
  });
});

/**
 * A branch name cannot reach outside the worktree root (1cc59c16 / CodeQL #182).
 *
 * CodeQL raised three "uncontrolled data used in path expression" alerts in
 * worktrees.ts - the existence checks and the mkdir, all on a path built from a
 * branch name that arrives over the API. A branch called `../../.ssh` is the
 * case it is pointing at.
 *
 * They are false positives, and this file is what makes that claim checkable
 * rather than merely argued. The containment is real: `toPathSegment` strips
 * every separator and leading dot, so a hostile name cannot express `..` or an
 * absolute path by the time a path is built from it. Verified against nine
 * shapes below.
 *
 * WRITTEN BECAUSE THE SAFETY WAS ACCIDENTAL UNTIL NOW. Nothing asserted it. The
 * dismissal rests on a sanitiser that exists for a different reason - tidy
 * directory names - and would evaporate silently the day somebody decided a
 * slash in a directory name was acceptable. That is the same shape as the ReDoS
 * fix in this file: a guard nobody wrote down, holding by luck.
 */
describe('containment of a hostile branch name (CodeQL, PR #182)', () => {
  const ROOT = '/wt-root';

  const hostile = [
    '../../../etc/passwd',
    'a/../../../../root/.ssh/authorized_keys',
    '/absolute/path',
    'C:\\Windows\\System32',
    '....//....//etc',
    '.ssh',
    '..',
    '.',
    '../',
  ];

  for (const branch of hostile) {
    it(`keeps ${JSON.stringify(branch)} inside the root`, () => {
      const out = buildWorktreePath(ROOT, 'repo', branch);
      expect(out.startsWith(`${ROOT}/repo/`), `${branch} produced ${out}`).toBe(true);
      // Belt and braces: no `..` segment anywhere, so no later resolve can walk
      // out of it either.
      expect(out.split('/').includes('..'), `${branch} produced a .. segment`).toBe(false);
    });
  }

  it('contains a hostile repository name too', () => {
    // repoName comes from path.basename of the project root, so it is already
    // one segment - but it goes through the same sanitiser and the test says so
    // rather than trusting the caller to keep doing that.
    expect(buildWorktreePath(ROOT, '../../etc', 'feat/x')).toMatch(/^\/wt-root\/etc\//);
    expect(buildWorktreePath(ROOT, 'a/b', 'feat/x')).toMatch(/^\/wt-root\/a-b\//);
  });

  it('does NOT sanitise the root, which is why the root must stay a constant', () => {
    /*
     * The honest limit of the containment, recorded rather than hidden. `root`
     * passes through untouched: only its trailing separators are trimmed. It is
     * safe today because every server call site passes defaultWorktreeRoot(),
     * which is `~/.agenfk-worktrees` and takes no input.
     *
     * This test exists to fail the day somebody lets a caller choose it. That
     * would be the alert CodeQL raised, actually reachable.
     */
    expect(buildWorktreePath('/wt/../../etc', 'repo', 'feat/x')).toContain('/wt/../../etc/');
  });
});
