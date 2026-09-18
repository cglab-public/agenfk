/**
 * The gate that turns a claim into a refusal (819e7192).
 *
 * claims.ts answers "do these two paths overlap". Nobody asks it. The module
 * has been complete and unreachable since it was written: the gatekeeper does
 * not consult it, dispatch does not consult it, and closeCommit accepts claims
 * through a parameter no caller passes. This is the layer that closes that,
 * and these tests are written before it exists.
 *
 * WHAT IT MUST NOT DO IS BLOCK EVERYTHING. Every card in the database today
 * has no claims at all. A gate that treats absence as a conflict stops the
 * project on the commit that introduces it, so "no claims declared" has to
 * stay authorized, and the test for that is as load-bearing as the refusals.
 *
 * WHAT IT MUST NOT DO IS FAIL OPEN. That is the failure claims.ts had four
 * times over, each one a pair that obviously overlaps reported as clear. Here
 * the same failure wears a different coat: a claim this cannot parse must not
 * come back as authorization, because the card that wrote it believes it holds
 * those files.
 *
 * Pure, like claims.ts, and for the same reason: the server, the CLI and the
 * MCP tool all have to reach the same verdict, and three copies of this logic
 * would drift the way the gatekeeper's status names drifted before it.
 */
import { describe, it, expect } from 'vitest';
import { gateOnClaims, type ClaimHolder } from '../claimGate';

/** A card holding files, in whatever step the test needs. */
const holder = (id: string, status: string, claims: string[]): ClaimHolder =>
  ({ id, status, claims });

describe('an edit that runs into somebody else', () => {
  it('refuses, and names who holds the file', () => {
    /*
     * The refusal has to be actionable. "Claim conflict" tells an agent to
     * give up; naming the card tells it who to ask, and a lead re-cutting a
     * fan-out needs the holder to know which piece to move.
     */
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].heldBy).toBe('theirs');
    expect(result.message).toContain('theirs');
  });

  it('reports every conflict, not the first one it hits', () => {
    // A lead re-cutting a split needs the whole picture. One collision at a
    // time turns a single decision into a sequence of them, each invalidating
    // the last.
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx', 'packages/server/src/server.ts'] },
      [
        holder('a', 'IN_PROGRESS', ['packages/ui/']),
        holder('b', 'REVIEW', ['packages/server/']),
      ],
    );
    expect(result.conflicts.map(c => c.heldBy).sort()).toEqual(['a', 'b']);
  });
});

describe('an edit that runs into nobody', () => {
  it('authorizes a card that declares nothing, which is every card today', () => {
    /*
     * THE test that keeps this from landing as an outage. Claims are new; the
     * database is full of cards that predate them. If absence read as conflict,
     * the first agent to edit anything after this ships would be refused.
     */
    const result = gateOnClaims({ id: 'mine' }, [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(result.authorized).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it('authorizes when the holder declares nothing', () => {
    // The mirror, and the common case while claims roll out: one card has
    // adopted them and the others have not.
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/'] },
      [holder('theirs', 'IN_PROGRESS', [])],
    );
    expect(result.authorized).toBe(true);
  });

  it('authorizes work that is genuinely apart', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/cli/'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(true);
  });

  it('does not let a card collide with itself', () => {
    // Re-declaring on a second dispatch, or widening its own claim. A card
    // blocked by its own claim could never make a second edit.
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/'] },
      [holder('mine', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(true);
  });
});

/**
 * Which cards still hold their files.
 *
 * "Active" is the wrong question here, and reusing the gatekeeper's answer
 * would be the easy mistake. A PAUSED card is not working, but its half-edited
 * files are still lying in the shared tree: handing them to somebody else is
 * exactly the race this mechanism exists to prevent, and the paused agent
 * discovers it on resume, which is the worst moment.
 *
 * A card that reached a terminal step is different. Its work is committed or
 * abandoned, and holding the files forever would make the first fan-out
 * permanent.
 */
describe('who still holds files', () => {
  it('keeps holding while paused, because the files are still half-edited', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'PAUSED', ['packages/ui/'])],
    );
    expect(result.authorized, 'a paused card lost its files to another agent').toBe(false);
  });

  it('keeps holding while blocked, for the same reason', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'BLOCKED', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(false);
  });

  it('releases on DONE, or the first fan-out owns those files forever', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'DONE', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(true);
  });

  it('releases on TRASHED and ARCHIVED too', () => {
    for (const status of ['TRASHED', 'ARCHIVED']) {
      const result = gateOnClaims(
        { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
        [holder('theirs', status, ['packages/ui/'])],
      );
      expect(result.authorized, `a ${status} card was still holding files`).toBe(true);
    }
  });
});

/**
 * A claim it could not read is not a claim it has cleared.
 *
 * claims.ts already separates these two facts and hands back `rejected`. The
 * whole value of that separation is lost if this layer collapses it back into
 * a boolean, which is the obvious way to write this function.
 */
describe('input it cannot reason about', () => {
  it('refuses to authorize on a claim it could not parse', () => {
    /*
     * The card wrote `packages/**` and believes it holds that subtree. It
     * holds nothing: globs are refused rather than approximated. Authorizing
     * here tells it the opposite of the truth.
     */
    const result = gateOnClaims({ id: 'mine', claims: ['packages/**'] }, []);
    expect(result.authorized, 'a glob was accepted as a cleared claim').toBe(false);
    expect(result.rejected).toContain('packages/**');
  });

  it('says so when the unreadable claim is somebody else\'s', () => {
    // The worse half. A malformed HELD claim protects nothing, and the card
    // that wrote it is never told. Authorizing over it is a silent overwrite
    // waiting for whoever edits next.
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui '])],
    );
    expect(result.rejected).toContain('packages/ui ');
    expect(result.authorized).toBe(false);
  });

  it('distinguishes a real clear answer from a dropped one', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/cli/'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.authorized).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('survives a holder with no claims field rather than throwing', () => {
    // This layer is asked questions about exactly this: every card in the
    // database predates the field.
    const result = gateOnClaims({ id: 'mine', claims: ['a.ts'] }, [
      { id: 'theirs', status: 'IN_PROGRESS' } as ClaimHolder,
    ]);
    expect(result.authorized).toBe(true);
  });
});

/**
 * The message is the product.
 *
 * An agent meets this once and has to know what to do without reading the
 * source. A refusal that says only "conflict" produces a retry, and a retry
 * produces the overwrite this exists to prevent.
 */
describe('what the refusal tells an agent', () => {
  it('names the file, not only the card', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.message).toContain('packages/ui');
  });

  it('does not suggest retrying, which is the one wrong move', () => {
    const result = gateOnClaims(
      { id: 'mine', claims: ['packages/ui/src/App.tsx'] },
      [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])],
    );
    expect(result.message.toLowerCase()).not.toMatch(/try again|retry/);
  });
});

describe('the sentence an agent reads once', () => {
  it('does not say a path is inside itself', () => {
    // An exact collision used to render as "SKILL.md is inside SKILL.md",
    // which is nonsense exactly when the reader most needs the sentence to be
    // clear. Seen for real the first time the mechanism refused anything.
    const r = gateOnClaims({ id: 'mine', claims: ['SKILL.md'] }, [holder('theirs', 'IN_PROGRESS', ['SKILL.md'])]);
    expect(r.message).not.toMatch(/SKILL\.md is inside SKILL\.md/);
    expect(r.message).toContain('already held by theirs');
  });

  it('still says where a path sits when it is genuinely inside another claim', () => {
    const r = gateOnClaims({ id: 'mine', claims: ['packages/ui/App.tsx'] }, [holder('theirs', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(r.message).toMatch(/is inside packages\/ui/);
  });
});
