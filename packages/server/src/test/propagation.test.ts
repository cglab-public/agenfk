/**
 * Whether a sibling's green run still speaks for this card.
 *
 * With several agents in ONE tree - the design, not an accident - a sibling's
 * suite passed against a tree that other agents may have edited since. Same
 * directory, later content, propagated as proof. The old match was parentId
 * plus the command string and nothing else, and it closed 63 of 78 DONE items
 * in this repository without running anything (81%).
 *
 * A CLAIM NEEDS A SHA. The sibling's test records the commit it passed at, and
 * propagation stands only while the tree is still there. A record with no SHA
 * - every card that predates this - cannot establish it, so it does not
 * propagate: the honest direction is to run the command, not to claim it.
 */
import { describe, it, expect } from 'vitest';
import { mayPropagate, readHead, readCleanTreeSha, readTreeStatus } from '../propagation';

describe('the gate on a sibling green', () => {
  it('propagates while the tree is still at the verified commit', () => {
    expect(mayPropagate('abc123', { commit: 'abc123' }).allowed).toBe(true);
  });

  it('refuses once the tree has moved', () => {
    const v = mayPropagate('def456', { commit: 'abc123' });
    expect(v.allowed, 'a green from an earlier tree was spent as proof').toBe(false);
    expect(v.reason).toMatch(/moved/);
    expect(v.reason).toContain('abc123');
  });

  it('refuses a sibling record with no commit', () => {
    // A legacy record cannot be tied to this tree, and "could not check" is
    // not "checked, clear" - the whole point of the gate.
    const v = mayPropagate('abc123', {});
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no commit/);
  });

  it('refuses when this tree has no commit to compare', () => {
    expect(mayPropagate(null, { commit: 'abc123' }).allowed).toBe(false);
  });

  it('refuses when there is no matching test at all', () => {
    expect(mayPropagate('abc123', undefined).allowed).toBe(false);
  });
});

describe('reading the verified commit', () => {
  const clean = { run: (args: readonly string[]) => (args.includes('status') ? '' : 'abc123\n') };
  const dirty = { run: (args: readonly string[]) => (args.includes('status') ? ' M a.txt\n' : 'abc123\n') };

  it('returns the trimmed HEAD sha', () => {
    expect(readHead('/repo', { run: () => 'abc123\n' })).toBe('abc123');
  });

  it('names the commit only while the tree is CLEAN', () => {
    expect(readCleanTreeSha('/repo', clean)).toBe('abc123');
  });

  it('refuses to name a commit for a DIRTY tree', () => {
    // Uncommitted work is content the sibling's green never saw, and in the
    // one-tree model that is the NORMAL state - closer agents edit without
    // committing until close. "Cannot say" is the answer; the card runs its
    // own command instead.
    expect(readCleanTreeSha('/repo', dirty)).toBeNull();
  });

  it('sees a RESTAGE of the same path, which porcelain alone would miss', () => {
    // `M  a.txt` is byte-identical when the file is staged again with different
    // content, so the porcelain cannot tell the two trees apart. The staged
    // blob sha from `diff --cached --raw` can.
    const runner = (raw: string) => ({
      run: (args: readonly string[]) => {
        if (args.includes('--porcelain')) return 'M  a.txt\n';
        if (args.includes('--raw')) return raw;
        return '';
      },
    });
    expect(readTreeStatus('/repo', runner('blob-A'))).not.toBe(readTreeStatus('/repo', runner('blob-B')));
  });

  it('answers null when git cannot say, rather than throwing', () => {
    // Not a repo, no commits, git absent: all "cannot say" for a routine that
    // runs on the validate path.
    const boom = { run: () => { throw new Error('not a repo'); } };
    expect(readHead('/repo', boom)).toBeNull();
    expect(readHead('/repo', { run: () => '' })).toBeNull();
    expect(readCleanTreeSha('/repo', boom)).toBeNull();
  });
});
