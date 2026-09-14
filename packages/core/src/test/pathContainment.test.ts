/**
 * Keeping a directory listing inside the worktree it claims to list.
 *
 * This is the card's one non-optional constraint, and the reason is specific:
 * the server listens on loopback with no authentication and a CORS allowlist
 * that trusts any localhost origin. A listing endpoint that accepts an
 * arbitrary path is therefore filesystem read access for any page open in the
 * user's browser.
 *
 * The containment is by RESOLVED path, not by looking for `..` in the string.
 * A lexical check is defeated by a symlink — which is not exotic here, since
 * git worktrees and node_modules are full of them — and by an absolute path,
 * which contains no `..` at all.
 */
import { describe, it, expect } from 'vitest';
import { isInsideRoot } from '../pathContainment';

const ROOT = '/tmp/wt/repo';

describe('paths that are inside', () => {
  it('accepts the root itself', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true);
  });

  it('accepts a file in it', () => {
    expect(isInsideRoot(ROOT, '/tmp/wt/repo/src/index.ts')).toBe(true);
  });

  it('accepts a deep path', () => {
    expect(isInsideRoot(ROOT, '/tmp/wt/repo/a/b/c/d.txt')).toBe(true);
  });
});

describe('paths that are not', () => {
  it('refuses a sibling whose name merely starts with the root', () => {
    // The prefix bug, and it is the one a string comparison always has:
    // `/tmp/wt/repo-secrets` starts with `/tmp/wt/repo` and is a different
    // directory entirely.
    expect(isInsideRoot(ROOT, '/tmp/wt/repo-secrets/keys.txt')).toBe(false);
  });

  it('refuses a parent', () => {
    expect(isInsideRoot(ROOT, '/tmp/wt')).toBe(false);
  });

  it('refuses an unrelated absolute path, which contains no dot-dot at all', () => {
    // This is what makes a lexical `..` check worthless: the most direct
    // attack does not use one.
    expect(isInsideRoot(ROOT, '/etc/passwd')).toBe(false);
    expect(isInsideRoot(ROOT, '/Users/someone/.ssh/id_rsa')).toBe(false);
  });

  it('refuses a traversal even when it is spelled oddly', () => {
    for (const escape of [
      '/tmp/wt/repo/../../../etc/passwd',
      '/tmp/wt/repo/./../../etc/passwd',
      '/tmp/wt/repo/a/../../..',
    ]) {
      expect(isInsideRoot(ROOT, escape), escape).toBe(false);
    }
  });

  it('refuses an empty or missing candidate rather than defaulting to the root', () => {
    for (const bad of ['', '   ', undefined, null]) {
      expect(isInsideRoot(ROOT, bad as never)).toBe(false);
    }
  });

  it('refuses everything when the root itself is empty', () => {
    // A misconfigured caller must not turn the check into "allow anything".
    expect(isInsideRoot('', '/etc/passwd')).toBe(false);
  });
});
