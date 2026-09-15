/**
 * Two agents must not both own a file (819e7192).
 *
 * With several agents in one worktree, git stops helping: two of them editing
 * one file is a race, not a merge conflict, and the loser's edit is gone with
 * nobody told. A claim is the only mechanism left, which means an overlap this
 * module fails to notice is an edit somebody loses in silence.
 *
 * SO THE FAILURE THAT MATTERS IS FAILING OPEN - reporting "no conflict" when
 * there is one. Most of this file is about the ways a prefix comparison does
 * that: a directory name that is a prefix of another directory name, a
 * trailing slash, a claim that is not a claim at all.
 */
import { describe, it, expect } from 'vitest';
import { claimsCollide, findClaimConflicts, isWellFormedClaim } from '../claims';

describe('claims that collide', () => {
  it('sees a file inside a claimed directory', () => {
    expect(claimsCollide('packages/ui/', 'packages/ui/src/App.tsx')).toBe(true);
  });

  it('sees it the other way round too', () => {
    // Order is an accident of who asked first, not a property of the claims.
    expect(claimsCollide('packages/ui/src/App.tsx', 'packages/ui/')).toBe(true);
  });

  it('sees one directory inside another', () => {
    expect(claimsCollide('packages/', 'packages/ui/src/')).toBe(true);
  });

  it('sees the same file claimed twice', () => {
    expect(claimsCollide('a/b.ts', 'a/b.ts')).toBe(true);
  });

  it('is not fooled by a missing trailing slash', () => {
    // A caller that writes `packages/ui` meaning the directory must not get a
    // different answer from one who writes `packages/ui/`.
    expect(claimsCollide('packages/ui', 'packages/ui/src/App.tsx')).toBe(true);
  });
});

describe('claims that do not collide', () => {
  it('keeps sibling directories apart', () => {
    expect(claimsCollide('packages/ui/', 'packages/server/')).toBe(false);
  });

  it('does not treat a shared name prefix as containment', () => {
    /*
     * THE test, and the one a plain `startsWith` fails. `packages/ui` is a
     * prefix of the STRING `packages/ui-legacy/App.tsx` and has nothing to do
     * with that tree. Getting this wrong fails CLOSED - it refuses work that
     * was fine - which is the less dangerous direction, but it would make the
     * mechanism unusable and therefore turned off.
     */
    expect(claimsCollide('packages/ui/', 'packages/ui-legacy/App.tsx')).toBe(false);
    expect(claimsCollide('packages/ui', 'packages/ui-legacy/')).toBe(false);
  });

  it('keeps two files in one directory apart', () => {
    // The common case in a fan-out: two agents, one folder, different files.
    expect(claimsCollide('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('does not treat a file as containing anything', () => {
    // Only a DIRECTORY claim contains. A file whose name prefixes another's
    // contains nothing, however the string compares.
    expect(claimsCollide('src/App.tsx', 'src/App.tsx.map')).toBe(false);
  });
});

describe('what is not a claim at all', () => {
  it('refuses globs rather than treating them as literals', () => {
    /*
     * The decision this module rests on. Pattern-versus-pattern overlap has no
     * cheap answer, so a glob accepted here would be compared as a literal
     * string - a claim on a file named `**`, which protects nothing while
     * looking like it protects everything.
     */
    for (const glob of ['packages/**', 'src/*.ts', 'a/[bc]/d', 'x/{a,b}']) {
      expect(isWellFormedClaim(glob), `${glob} was accepted as a claim`).toBe(false);
    }
  });

  it('refuses anything that leaves the repository', () => {
    // A claim is also the list of paths a close commit will touch.
    for (const bad of ['../secrets', 'a/../../b', '/etc/passwd', 'C:/Windows']) {
      expect(isWellFormedClaim(bad), `${bad} was accepted as a claim`).toBe(false);
    }
  });

  it('refuses the empty and the untrimmed', () => {
    for (const bad of ['', '   ', ' src/a.ts', 'src/a.ts ']) {
      expect(isWellFormedClaim(bad)).toBe(false);
    }
  });

  it('refuses what is not a string', () => {
    for (const bad of [null, undefined, 42, {}, ['a']]) {
      expect(isWellFormedClaim(bad)).toBe(false);
    }
  });

  it('accepts the two shapes it does support', () => {
    expect(isWellFormedClaim('packages/ui/')).toBe(true);
    expect(isWellFormedClaim('packages/ui/src/App.tsx')).toBe(true);
  });
});

describe('asking for claims against what is already held', () => {
  const held = [
    { itemId: 'card-a', claims: ['packages/ui/'] },
    { itemId: 'card-b', claims: ['packages/server/src/server.ts'] },
  ];

  it('names who holds the file, so a refusal can say more than no', () => {
    const [conflict] = findClaimConflicts(['packages/ui/src/App.tsx'], held).conflicts;
    expect(conflict.heldBy).toBe('card-a');
    expect(conflict.held).toBe('packages/ui/');
  });

  it('reports EVERY conflict, not the first', () => {
    /*
     * A lead planning a fan-out needs the whole picture to re-cut the split.
     * One collision at a time turns a single decision into a sequence of them,
     * each invalidating the last.
     */
    const { conflicts } = findClaimConflicts(
      ['packages/ui/src/App.tsx', 'packages/server/src/server.ts'],
      held,
    );
    expect(conflicts.map(c => c.heldBy).sort()).toEqual(['card-a', 'card-b']);
  });

  it('lets a card keep what it already holds', () => {
    // Re-declaring on a second dispatch, or a card widening its own claim.
    // Colliding with yourself is not a collision.
    expect(findClaimConflicts(['packages/ui/'], held, 'card-a').conflicts).toEqual([]);
  });

  it('finds nothing when the work is genuinely apart', () => {
    expect(findClaimConflicts(['packages/cli/'], held).conflicts).toEqual([]);
  });

  /*
   * A test called 'ignores a malformed claim rather than matching it loosely'
   * stood here and asserted `toEqual([])` - which enshrined the fail-open as
   * intended behaviour. A claim this module cannot check is not one it has
   * cleared, and saying nothing about it was the defect. The replacement is in
   * the block at the end of this file.
   */
});

/**
 * The four ways this module failed open, found by review (774e121c).
 *
 * Its own docblock says failing open is the one outcome it must not have - and
 * it had four, each a pair that should collide and does not, or an input it
 * could not check and reported clear anyway. Every one measured before being
 * written down.
 *
 * Worth recording that the author predicted "there is probably another one"
 * after fixing the trailing-slash bug, and was right three times over.
 */
describe('separators it used to disagree with itself about', () => {
  it('treats a backslash as a separator', () => {
    /*
     * Two claims in the SAME convention, obviously overlapping, accepted
     * without complaint and reported clear. `contains` hardcoded `outer + '/'`,
     * so an agent writing native Windows separators - which nothing rejected
     * and nothing warned about - got a clean answer on a directory holding the
     * other's file.
     */
    expect(claimsCollide('packages\\ui', 'packages\\ui\\src\\App.tsx')).toBe(true);
  });

  it('sees through mixed conventions', () => {
    // Worse than the pure case: two agents, two habits, one directory.
    expect(claimsCollide('packages\\ui', 'packages/ui/src/App.tsx')).toBe(true);
  });

  it('is not defeated by a doubled slash', () => {
    /*
     * Same file, two spellings, no conflict reported. Reachable by accident
     * rather than malice: any `dir + '/' + name` where `dir` already ends in a
     * slash produces it.
     */
    expect(claimsCollide('src//a.ts', 'src/a.ts')).toBe(true);
    expect(claimsCollide('packages//ui//', 'packages/ui/src/App.tsx')).toBe(true);
  });

  it('still keeps unrelated trees apart after all that normalising', () => {
    // The normalisation must not become so eager that it starts colliding
    // things that do not overlap - failing closed is better, but unusable.
    expect(claimsCollide('packages\\ui', 'packages/ui-legacy/App.tsx')).toBe(false);
    expect(claimsCollide('src//a.ts', 'src/b.ts')).toBe(false);
  });
});

describe('a claim it cannot check is not a claim it has cleared', () => {
  it('reports what it rejected, instead of answering clear', () => {
    /*
     * THE fail-open. The return type was `ClaimConflict[]` and malformed input
     * was skipped, so a caller could not tell "checked, clear" from "could not
     * check, dropped". A glob asking for everything came back as no conflict.
     *
     * The original test asserted `toEqual([])` on exactly this, which enshrined
     * the behaviour as intended.
     */
    const result = findClaimConflicts(['packages/**'], [{ itemId: 'card-a', claims: ['packages/ui/'] }]);
    expect(result.rejected, 'a glob was silently dropped').toContain('packages/**');
  });

  it('reports a malformed claim held by somebody else', () => {
    /*
     * The worse half, and the one the review pointed at: a HELD claim that is
     * malformed protects nothing, and the card that made it is never told. Here
     * the trailing space is what makes it malformed.
     */
    const result = findClaimConflicts(
      ['packages/ui/src/a.ts'],
      [{ itemId: 'card-a', claims: ['packages/ui '] }],
    );
    expect(result.rejected, 'a held claim was silently dropped').toContain('packages/ui ');
  });

  it('separates a real clear answer from a dropped one', () => {
    const clear = findClaimConflicts(['packages/cli/'], [{ itemId: 'card-a', claims: ['packages/ui/'] }]);
    expect(clear.conflicts).toEqual([]);
    expect(clear.rejected).toEqual([]);
  });

  it('survives a holder with no claims rather than throwing', () => {
    // `holder.claims is not iterable` was a real TypeError, in a module whose
    // whole job is to be asked questions about half-formed input.
    const result = findClaimConflicts(['a.ts'], [{ itemId: 'card-a' } as never]);
    expect(result.conflicts).toEqual([]);
  });

  it('does not lose a holder whose id is missing', () => {
    // `undefined === undefined` is true, so an unnamed holder was skipped
    // whenever no asking id was given - its claims simply vanished.
    const result = findClaimConflicts(['packages/ui/src/a.ts'], [{ itemId: undefined as never, claims: ['packages/ui/'] }]);
    expect(result.conflicts).toHaveLength(1);
  });
});

describe('a hostile claim cannot hold the process', () => {
  it('normalises a long run of separators without stalling', () => {
    /*
     * The same quadratic trailing trim removed from utils.ts one commit later,
     * reintroduced here by the same hand: `claim.replace(/\/+$/, '')`. Measured
     * at 3,424 ms for 100,000 separators, and reachable through the validated
     * path - `isWellFormedClaim` accepts it, because empty segments are neither
     * `..` nor `.` and there are no glob characters.
     */
    const hostile = 'x' + '/'.repeat(100_000) + 'y';
    const started = Date.now();
    claimsCollide(hostile, 'a');
    expect(Date.now() - started, 'the normaliser is backtracking').toBeLessThan(1000);
  });
});

describe('what a claim must not smuggle', () => {
  it('refuses a backslash escape as firmly as a forward one', () => {
    // The validator split on '/' only, so these passed - against a docblock
    // saying `..` escapes the repository. It matters more now that a claim is
    // meant to become a commit pathspec.
    for (const bad of ['..\\..\\secrets', '\\etc\\passwd', '\\\\server\\share']) {
      expect(isWellFormedClaim(bad), `${bad} was accepted`).toBe(false);
    }
  });
});
