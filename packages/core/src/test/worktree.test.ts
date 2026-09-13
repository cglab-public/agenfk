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
