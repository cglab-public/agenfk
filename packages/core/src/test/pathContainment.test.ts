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
import { isInsideRoot, containedPath } from '../pathContainment';

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

/**
 * The checked value IS the used value (CodeQL js/path-injection).
 *
 * `isInsideRoot` answers a question and hands back a boolean, so the caller
 * writes `if (!isInsideRoot(root, target)) return 403;` and then passes
 * `target` - the UNCHECKED variable - to `fs`. That is correct today and it is
 * the shape that goes wrong later: the check and the use are two separate
 * mentions of the same name, and nothing stops an edit between them, or a
 * second sink added below that forgets the guard.
 *
 * `containedPath` returns the path instead of a verdict, so the value reaching
 * the filesystem is the one that passed. There is no second variable to get
 * wrong. That it also makes the guard legible to CodeQL is a consequence, not
 * the reason - a `// codeql[js/path-injection]` comment would satisfy the tool
 * and leave the defect shape exactly where it was.
 */
describe('containedPath', () => {
  const root = '/home/u/.agenfk-worktrees/agenfk/feat-x-abc';

  it('gives back the path when it is inside', () => {
    expect(containedPath(root, `${root}/src/a.ts`)).toBe(`${root}/src/a.ts`);
  });

  it('gives back the root itself, which is inside', () => {
    // Listing the worktree root is the ordinary case for the files route.
    expect(containedPath(root, root)).toBe(root);
  });

  it('returns null for an escape, rather than a path that looks usable', () => {
    /*
     * THE test. Null is not a path, so a caller who forgets to check it gets a
     * TypeError from `fs` on the very first call - loud, immediate, and in
     * development. A sanitised-but-wrong string would be used silently.
     */
    expect(containedPath(root, `${root}/../../../../etc/passwd`)).toBeNull();
    expect(containedPath(root, '/etc/passwd')).toBeNull();
  });

  it('refuses a sibling that merely starts with the root, which is the classic bypass', () => {
    // `feat-x-abc-evil` has `feat-x-abc` as a string prefix. A containment
    // check written with startsWith and no separator lets it through.
    expect(containedPath(root, `${root}-evil/x`)).toBeNull();
  });

  it('agrees with isInsideRoot on every case, so the two cannot drift', () => {
    /*
     * They are two doors onto one rule. If a later edit tightened one, the
     * boolean and the value form would disagree and half the call sites would
     * keep the old behaviour - which is the defect this codebase keeps finding,
     * committed inside its own fix.
     */
    const cases = [
      `${root}/src/a.ts`, root, `${root}/../x`, `${root}-evil/x`,
      '/etc/passwd', '', '   ', `${root}/./deep/../ok.ts`,
    ];
    for (const c of cases) {
      expect(
        containedPath(root, c) !== null,
        `containedPath and isInsideRoot disagree about ${JSON.stringify(c)}`,
      ).toBe(isInsideRoot(root, c));
    }
  });

  it('refuses empty and whitespace input without throwing', () => {
    // These arrive from a request. Throwing here would turn a bad query string
    // into a 500 instead of a 403.
    for (const bad of ['', '   ', null, undefined]) {
      expect(containedPath(root, bad as never)).toBeNull();
    }
    expect(containedPath('', `${root}/a`)).toBeNull();
  });
});
