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
import { gateOnClaims, claimTreeOf, strayStaged, claimlessNeighbours, sameClaimTree, type ClaimHolder } from '../claimGate';

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

/**
 * Claims are per worktree (aaa01834).
 *
 * The mechanism exists because two cards editing one file IN ONE TREE is a
 * silent overwrite. Two cards in two worktrees never race: they meet, at
 * worst, as an ordinary merge conflict. Locking across trees refused this
 * repo's own work for a week (a card on feat/CGLAB-376 was told
 * packages/server/src/server.ts belonged to an epic in feat/CGLAB-412).
 *
 * What must not change: two cards in the SAME tree still collide, and a card
 * whose tree nobody can name stays strict - unknown is not "elsewhere".
 */
describe('claims are per worktree', () => {
  const inTree = (id: string, status: string, claims: string[], tree: string | null): ClaimHolder =>
    ({ id, status, claims, tree });

  it('two cards in different worktrees may claim the same file', () => {
    const r = gateOnClaims(
      { id: 'mine', claims: ['packages/server/src/server.ts'], tree: '/wt/feat-a' },
      [inTree('theirs', 'IN_PROGRESS', ['packages/server/'], '/wt/feat-b')],
    );
    expect(r.authorized, r.message).toBe(true);
  });

  it('two cards in the same worktree still collide', () => {
    const r = gateOnClaims(
      { id: 'mine', claims: ['packages/server/src/server.ts'], tree: '/wt/feat-a' },
      [inTree('theirs', 'IN_PROGRESS', ['packages/server/'], '/wt/feat-a')],
    );
    expect(r.authorized).toBe(false);
    expect(r.conflicts[0].heldBy).toBe('theirs');
  });

  it('the same tree spelled with a trailing separator is still the same tree', () => {
    const r = gateOnClaims(
      { id: 'mine', claims: ['a.ts'], tree: '/wt/feat-a/' },
      [inTree('theirs', 'IN_PROGRESS', ['a.ts'], '/wt/feat-a')],
    );
    expect(r.authorized).toBe(false);
  });

  it('a holder whose tree is unknown still collides: unknown is not elsewhere', () => {
    const r = gateOnClaims(
      { id: 'mine', claims: ['a.ts'], tree: '/wt/feat-a' },
      [inTree('theirs', 'IN_PROGRESS', ['a.ts'], null)],
    );
    expect(r.authorized).toBe(false);
  });

  it('an asking card whose tree is unknown stays strict against every holder', () => {
    const r = gateOnClaims(
      { id: 'mine', claims: ['a.ts'], tree: null },
      [inTree('theirs', 'IN_PROGRESS', ['a.ts'], '/wt/feat-b')],
    );
    expect(r.authorized).toBe(false);
  });

  it('a malformed claim in another tree is not this tree\'s problem', () => {
    // Rejected claims come from holders too; one in another worktree cannot
    // overwrite anything here, so it must not refuse this card.
    const r = gateOnClaims(
      { id: 'mine', claims: ['a.ts'], tree: '/wt/feat-a' },
      [inTree('theirs', 'IN_PROGRESS', ['packages/**'], '/wt/feat-b')],
    );
    expect(r.authorized, r.message).toBe(true);
  });
});

describe('claimTreeOf: which tree a card works in', () => {
  const byId = new Map<string, { id: string; parentId?: string | null; worktreePath?: string | null; worktreeChoice?: string | null }>([
    ['epic', { id: 'epic', worktreePath: '/wt/feat-a' }],
    ['atRoot', { id: 'atRoot', parentId: 'epic', worktreeChoice: 'root' }],
    ['underRoot', { id: 'underRoot', parentId: 'atRoot' }],
    ['epicAtRoot', { id: 'epicAtRoot', worktreePath: '/wt/made', worktreeChoice: 'root' }],
    ['chose', { id: 'chose', parentId: 'epic', worktreeChoice: '/wt/chosen' }],
    ['underChose', { id: 'underChose', parentId: 'chose' }],
    ['story', { id: 'story', parentId: 'epic' }],
    ['task', { id: 'task', parentId: 'story' }],
    ['loner', { id: 'loner' }],
    ['own', { id: 'own', parentId: 'epic', worktreePath: '/wt/own' }],
    ['loopA', { id: 'loopA', parentId: 'loopB' }],
    ['loopB', { id: 'loopB', parentId: 'loopA' }],
  ]);
  const lookup = (id: string) => byId.get(id);

  it("a child works in its top-level ancestor's worktree", () => {
    expect(claimTreeOf(byId.get('task')!, lookup, '/repo')).toBe('/wt/feat-a');
  });
  it('its own worktree wins over an ancestor\'s', () => {
    expect(claimTreeOf(byId.get('own')!, lookup, '/repo')).toBe('/wt/own');
  });
  // 686fdbf6: 'root' is the card's own choice, and it stops the walk.
  it("a card that chose the project root is there, whatever its parent's worktree", () => {
    expect(claimTreeOf(byId.get('atRoot')!, lookup, '/repo')).toBe('/repo');
    expect(claimTreeOf(byId.get('underRoot')!, lookup, '/repo')).toBe('/repo');
  });
  it('a card that chose a checkout is in it, and so are its children', () => {
    expect(claimTreeOf(byId.get('chose')!, lookup, '/repo')).toBe('/wt/chosen');
    expect(claimTreeOf(byId.get('underChose')!, lookup, '/repo')).toBe('/wt/chosen');
  });
  it('the choice wins over a worktree the card itself carries', () => {
    expect(claimTreeOf(byId.get('epicAtRoot')!, lookup, '/repo')).toBe('/repo');
  });
  it('a card with no worktree anywhere works in the project root', () => {
    expect(claimTreeOf(byId.get('loner')!, lookup, '/repo')).toBe('/repo');
  });
  it('no worktree and no project root: unknown', () => {
    expect(claimTreeOf(byId.get('loner')!, lookup, null)).toBeNull();
  });
  it('a parent loop terminates', () => {
    expect(claimTreeOf(byId.get('loopA')!, lookup, '/repo')).toBe('/repo');
  });
});

/**
 * Staged files nobody claims (aaa01834).
 *
 * The close commit takes only the card's claimed files, so a file the card
 * changed and forgot to claim is left staged in the tree after DONE - seen
 * this session with C1's flowContract.ts. The move that ends the flow is
 * refused while such a file exists; a file another card in the same tree
 * claims is that card's, and does not count.
 */
describe('strayStaged', () => {
  const other = (id: string, status: string, claims: string[], tree: string | null): ClaimHolder => ({ id, status, claims, tree });

  it('lists staged files outside the card\'s claims', () => {
    expect(strayStaged(['src/a.ts', 'src/b.ts', 'docs/x.md'], { id: 'me', claims: ['src/'], tree: '/t' }, [])).toEqual(['docs/x.md']);
  });
  it('a card that claims nothing has no strays: its commit takes everything staged', () => {
    expect(strayStaged(['src/a.ts'], { id: 'me', claims: [], tree: '/t' }, [])).toEqual([]);
  });
  it("a file another active card in the same tree claims is theirs", () => {
    expect(strayStaged(['docs/x.md'], { id: 'me', claims: ['src/'], tree: '/t' }, [other('them', 'IN_PROGRESS', ['docs/'], '/t')])).toEqual([]);
  });
  it('a claim in ANOTHER tree does not excuse a file staged in this one', () => {
    expect(strayStaged(['docs/x.md'], { id: 'me', claims: ['src/'], tree: '/t' }, [other('them', 'IN_PROGRESS', ['docs/'], '/elsewhere')])).toEqual(['docs/x.md']);
  });
  it('a finished card no longer holds its files', () => {
    expect(strayStaged(['docs/x.md'], { id: 'me', claims: ['src/'], tree: '/t' }, [other('them', 'DONE', ['docs/'], '/t')])).toEqual(['docs/x.md']);
  });
  it("the card's own entry in the holders list does not excuse anything", () => {
    expect(strayStaged(['docs/x.md'], { id: 'me', claims: ['src/'], tree: '/t' }, [other('me', 'IN_PROGRESS', ['docs/'], '/t')])).toEqual(['docs/x.md']);
  });
});

describe('claimlessNeighbours: who might own a stray', () => {
  const h = (id: string, status: string, claims: string[], tree: string | null): ClaimHolder => ({ id, status, claims, tree });
  const working = (st: string) => st !== 'TODO';

  it('names a working card in the same tree that claims nothing', () => {
    expect(claimlessNeighbours({ id: 'me', tree: '/t' }, [h('b', 'IN_PROGRESS', [], '/t')], working)).toEqual(['b']);
  });
  it('ignores cards that claim something, are not working, are finished, or sit in another tree', () => {
    expect(claimlessNeighbours({ id: 'me', tree: '/t' }, [
      h('claims', 'IN_PROGRESS', ['x'], '/t'),
      h('todo', 'TODO', [], '/t'),
      h('done', 'DONE', [], '/t'),
      h('elsewhere', 'IN_PROGRESS', [], '/other'),
      h('me', 'IN_PROGRESS', [], '/t'),
    ], working)).toEqual([]);
  });
  it('a paused card still counts: its staged work is still in the tree', () => {
    expect(claimlessNeighbours({ id: 'me', tree: '/t' }, [h('p', 'PAUSED', [], '/t')], working)).toEqual(['p']);
  });
});

describe('sameClaimTree on hostile input (CodeQL js/polynomial-redos)', () => {
  it('ignores any number of trailing separators', () => {
    expect(sameClaimTree('/wt/a///', '/wt/a')).toBe(true);
    expect(sameClaimTree('C:\\wt\\a\\\\', 'C:\\wt\\a')).toBe(true);
    expect(sameClaimTree('/wt/a/', '/wt/b')).toBe(false);
  });
  it('stays linear on a long run of separators that is not at the end', () => {
    const hostile = '/'.repeat(200_000) + 'x';
    const t = Date.now();
    expect(sameClaimTree(hostile, '/y')).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
