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
    const [conflict] = findClaimConflicts(['packages/ui/src/App.tsx'], held);
    expect(conflict.heldBy).toBe('card-a');
    expect(conflict.held).toBe('packages/ui/');
  });

  it('reports EVERY conflict, not the first', () => {
    /*
     * A lead planning a fan-out needs the whole picture to re-cut the split.
     * One collision at a time turns a single decision into a sequence of them,
     * each invalidating the last.
     */
    const conflicts = findClaimConflicts(
      ['packages/ui/src/App.tsx', 'packages/server/src/server.ts'],
      held,
    );
    expect(conflicts.map(c => c.heldBy).sort()).toEqual(['card-a', 'card-b']);
  });

  it('lets a card keep what it already holds', () => {
    // Re-declaring on a second dispatch, or a card widening its own claim.
    // Colliding with yourself is not a collision.
    expect(findClaimConflicts(['packages/ui/'], held, 'card-a')).toEqual([]);
  });

  it('finds nothing when the work is genuinely apart', () => {
    expect(findClaimConflicts(['packages/cli/'], held)).toEqual([]);
  });

  it('ignores a malformed claim rather than matching it loosely', () => {
    // A glob cannot be checked, so it cannot be cleared either. It is dropped
    // here and refused at the door by isWellFormedClaim, which is where a
    // caller learns about it.
    expect(findClaimConflicts(['packages/**'], held)).toEqual([]);
  });
});
