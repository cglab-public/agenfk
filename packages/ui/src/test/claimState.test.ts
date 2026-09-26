/**
 * The claim chip on a sidebar card (CGLAB-190).
 *
 * The claims mechanism shipped this week and is invisible in the product: a
 * card owns files, another card is refused because of it, and nothing on
 * screen says so. The interface this implements puts the word `held` on a
 * sidebar row and names the reason - *"the fourth card in the sidebar says
 * held — lead claims the same file"*.
 *
 * THE FAILURE THAT MATTERS HERE IS THE SAME ONE AS IN THE GATE: reporting a
 * held card as free. A chip that fails open is not cosmetic - it tells a
 * person their card is ready to work when the server will refuse it, and they
 * will go looking for the bug in the wrong place.
 *
 * The second failure is noise. Every card in the database declares nothing, so
 * a chip that renders on all of them is thirty rows announcing an absence.
 */
import { describe, it, expect } from 'vitest';
import { claimStateOf, claimChipLabel, claimChipTitle, collide, sameTree, type ClaimCard } from '../claimState';

const card = (id: string, status: string, claims?: string[]): ClaimCard => ({ id, status, claims });

describe('what a card owns', () => {
  it('says nothing at all when it declares nothing, which is every card today', () => {
    const state = claimStateOf('a', [card('a', 'IN_PROGRESS')]);
    expect(state).toEqual({ owns: [], heldBy: [], rejected: [] });
    expect(claimChipLabel(state), 'a chip rendered on a card with no claims').toBeNull();
    expect(claimChipTitle(state)).toBeNull();
  });

  it('counts what it owns, and counts in words a person reads', () => {
    const one = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(claimChipLabel(one)).toBe('owns 1 path');
    const two = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/', 'src/x.ts'])]);
    expect(claimChipLabel(two)).toBe('owns 2 paths');
  });

  it('puts the actual paths in the title, because a count is not actionable', () => {
    const state = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(claimChipTitle(state)).toContain('packages/ui/');
  });
});

describe('when somebody else owns it too', () => {
  it('says held, and names who', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('theirs-1234', 'REVIEW', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state)).toBe('held');
    expect(state.heldBy).toEqual(['theirs-1234']);
    // Truncated to eight characters, the way every id is shown in this UI.
    expect(claimChipTitle(state), 'held without naming the holder is a dead end').toContain('theirs-1');
  });

  it('counts a PAUSED holder, which the active list would have dropped', () => {
    /*
     * THE test. A paused card's files are half-edited in the shared tree, so
     * it still holds them - and the sidebar is drawn from the in-flight list,
     * which does not contain it. Computing holders from that list reports this
     * card as free while the server refuses it.
     */
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('paused-1234', 'PAUSED', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state), 'a paused holder was treated as released').toBe('held');
  });

  it('does not count a DONE holder, or the first fan-out owns those files forever', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('done-1234', 'DONE', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state)).toBe('owns 1 path');
  });

  it('does not report a card as held by itself', () => {
    // A card re-declaring or widening its own claim is not a collision, and a
    // row that said `held` here would be permanently, uselessly amber.
    const state = claimStateOf('mine', [card('mine', 'IN_PROGRESS', ['packages/ui/'])]);
    expect(state.heldBy).toEqual([]);
  });

  it('names a holder once, not once per colliding file', () => {
    // A directory claim collides with every file beneath it, and a row reading
    // "held by a, a, a" is noise where "held by a" is the fact.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/a.ts', 'packages/ui/b.ts', 'packages/ui/c.ts']),
      card('theirs', 'REVIEW', ['packages/ui/']),
    ]);
    expect(state.heldBy).toEqual(['theirs']);
  });

  it('defers to the gate on spelling, rather than comparing strings itself', () => {
    // The server treats these as the same path. A sidebar that disagreed would
    // say free where the gate says refused, and the reader cannot tell which
    // of the two is lying.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/src/App.tsx']),
      card('theirs', 'REVIEW', ['packages\\ui']),
    ]);
    expect(claimChipLabel(state)).toBe('held');
  });
});

describe('input the sidebar can actually hand it', () => {
  it('survives a card id that is not in the list', () => {
    expect(claimStateOf('ghost', [card('a', 'IN_PROGRESS', ['x/'])])).toEqual({ owns: [], heldBy: [], rejected: [] });
  });

  it('survives holders with no claims field, which is most of them', () => {
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/']),
      { id: 'theirs', status: 'IN_PROGRESS' } as ClaimCard,
    ]);
    expect(claimChipLabel(state)).toBe('owns 1 path');
  });
});

/**
 * The copy must agree with the original (CGLAB-190).
 *
 * `collide` in claimState.ts duplicates `claimsCollide` from packages/core,
 * because core is CommonJS and a browser bundle cannot have it: a named import
 * fails the build, and a namespace import made the build PASS and shipped a
 * bundle that threw `ReferenceError: exports is not defined` on load - a black
 * window with every test and the build reporting success.
 *
 * A copy that drifts is worse than either sharing or not: the sidebar would say
 * free where the server says refused, and the reader has no way to know which
 * of them is lying. This test can import core because it runs where core
 * resolves to SOURCE, which is precisely the thing the bundle cannot do.
 */
describe('the duplicated overlap check agrees with core', () => {
  it('gives the same answer as claimsCollide on every case that matters', async () => {
    const { claimsCollide } = await import('@agenfk/core');
    const cases: Array<[string, string]> = [
      ['packages/ui/src/App.tsx', 'packages/ui/'],
      ['packages/ui/src/App.tsx', 'packages\\ui'],
      ['src/a.ts', 'src//a.ts'],
      ['packages/ui-legacy/App.tsx', 'packages/ui/'],
      ['src/App.tsx.map', 'src/App.tsx'],
      ['a/b.ts', 'a/b.ts'],
      ['packages/ui/', 'packages/'],
      ['x', 'y'],
    ];
    for (const [a, b] of cases) {
      expect(collide(a, b), `the sidebar and the server disagree on ${a} vs ${b}`).toBe(claimsCollide(a, b));
    }
  });

  it('releases on the same statuses the gate does', async () => {
    // RELEASED here is a second copy of RELEASED_STATUSES. Two lists that drift
    // produce a sidebar that says held where the server says free.
    const { gateOnClaims } = await import('@agenfk/core');
    for (const status of ['DONE', 'TRASHED', 'ARCHIVED', 'IDEAS', 'PAUSED', 'BLOCKED', 'IN_PROGRESS', 'TODO']) {
      const mine = { id: 'mine', status: 'IN_PROGRESS', claims: ['packages/ui/a.ts'] };
      const theirs = { id: 'theirs', status, claims: ['packages/ui/'] };
      const uiSaysHeld = claimStateOf('mine', [mine, theirs]).heldBy.length > 0;
      const gateRefuses = !gateOnClaims(
        { id: 'mine', claims: mine.claims },
        [mine, theirs].map(c => ({ id: c.id, status: c.status, claims: c.claims })),
      ).authorized;
      expect(uiSaysHeld, `sidebar and gate disagree for a ${status} holder`).toBe(gateRefuses);
    }
  });
});

/**
 * A claim it cannot read is not one it has cleared (review of 9058005c).
 *
 * The first version of the local copy dropped `isWellFormedClaim`, so a card
 * claiming `packages/**` was shown a neutral grey "owns 1 path" while the
 * gatekeeper refused it outright. FAIL-OPEN, in the file whose own header says
 * a copy that drifts is worse than not sharing - written minutes earlier to fix
 * a different defect, and caught by adversarial review rather than by the
 * parity test, which used eight well-formed pairs and could not see this class
 * at all.
 */
describe('claims it cannot read', () => {
  it('says unreadable rather than owns, for a glob', () => {
    const state = claimStateOf('a', [card('a', 'IN_PROGRESS', ['packages/**'])]);
    expect(claimChipLabel(state), 'a glob was reported as owned').toBe('unreadable');
    expect(state.rejected).toContain('packages/**');
  });

  it('says unreadable rather than held, since the card holds nothing', () => {
    // Unreadable outranks a conflict: a card told it "owns" paths it does not
    // hold goes looking for the bug in the wrong place when it is refused.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/**']),
      card('theirs', 'REVIEW', ['packages/ui/']),
    ]);
    expect(claimChipLabel(state)).toBe('unreadable');
  });

  it('reports a malformed claim held by SOMEBODY ELSE, which is the worse half', () => {
    // A malformed held claim protects nothing and the card that wrote it is
    // never told, so treating it as absent authorizes an overwrite.
    const state = claimStateOf('mine', [
      card('mine', 'IN_PROGRESS', ['packages/ui/a.ts']),
      card('theirs', 'REVIEW', ['packages/ui ']),
    ]);
    expect(state.rejected).toContain('packages/ui ');
    expect(claimChipLabel(state)).toBe('unreadable');
  });

  it('agrees with the gate on every malformed shape', async () => {
    const { gateOnClaims } = await import('@agenfk/core');
    for (const bad of ['packages/**', 'src/*.ts', '../secrets', '/etc/passwd', 'a/../b', ' src/a.ts']) {
      const mine = { id: 'mine', status: 'IN_PROGRESS', claims: [bad] };
      const uiRefuses = claimStateOf('mine', [mine]).rejected.length > 0;
      const gateRefuses = !gateOnClaims({ id: 'mine', claims: [bad] }, [mine]).authorized;
      expect(uiRefuses, `sidebar and gate disagree on ${bad}`).toBe(gateRefuses);
    }
  });
});

/**
 * Claims are per worktree (aaa01834), and the sidebar must say what the server
 * says: a chip reading `held` for a card the gatekeeper authorizes sends
 * somebody to renegotiate files nobody is racing for.
 */
describe('claims are per worktree in the sidebar', () => {
  const at = (id: string, claims: string[], extra: Partial<ClaimCard>): ClaimCard => ({ id, status: 'IN_PROGRESS', claims, ...extra });

  it('a card in another worktree does not hold this one', () => {
    const state = claimStateOf('mine', [
      at('epicA', [], { worktreePath: '/wt/a' }),
      at('mine', ['x.ts'], { parentId: 'epicA' }),
      at('theirs', ['x.ts'], { worktreePath: '/wt/b' }),
    ]);
    expect(state.heldBy).toEqual([]);
  });

  it('a card at the project root collides with one whose worktree IS the root', () => {
    const state = claimStateOf('mine', [
      at('mine', ['x.ts'], { projectId: 'p' }),
      at('theirs', ['x.ts'], { worktreePath: '/repo' }),
    ], () => '/repo');
    expect(state.heldBy).toEqual(['theirs']);
  });

  it('agrees with the core gate across trees', async () => {
    const { gateOnClaims, claimTreeOf } = await import('@agenfk/core');
    // 686fdbf6: a card's chosen tree ('root' or a path) wins over its parent's worktree.
    type Place = Partial<Pick<ClaimCard, 'worktreePath' | 'worktreeChoice'>>;
    const places: Place[] = [
      { worktreePath: '/wt/a' }, { worktreePath: '/wt/b' }, { worktreePath: '/wt/a/' }, {},
      { worktreeChoice: 'root' }, { worktreeChoice: '/wt/a' }, { worktreePath: '/wt/b', worktreeChoice: '/wt/a' },
      { worktreePath: '/wt/a', worktreeChoice: 'root' },
    ];
    for (const p1 of places) for (const p2 of places) {
      const cards: ClaimCard[] = [
        at('parent', [], { worktreePath: '/wt/b', projectId: 'p' }),
        at('mine', ['x.ts'], { ...p1, parentId: 'parent', projectId: 'p' }),
        at('theirs', ['x.ts'], { ...p2, projectId: 'p' }),
      ];
      const t1 = JSON.stringify(p1), t2 = JSON.stringify(p2);
      const byId = new Map(cards.map(c => [c.id, c]));
      const coreTree = (c: ClaimCard) => claimTreeOf(c, (id: string) => byId.get(id), '/repo');
      const gateRefuses = !gateOnClaims({ id: 'mine', claims: ['x.ts'], tree: coreTree(cards[1]) },
        cards.map(c => ({ id: c.id, status: c.status, claims: c.claims, tree: coreTree(c) }))).authorized;
      expect(claimStateOf('mine', cards, () => '/repo').heldBy.length > 0, `${t1} vs ${t2}`).toBe(gateRefuses);
    }
  });
});

describe('sameTree on hostile input (CodeQL js/polynomial-redos)', () => {
  it('agrees with core and stays linear', async () => {
    const { sameClaimTree } = await import('@agenfk/core');
    for (const [a, b] of [['/wt/a///', '/wt/a'], ['/wt/a', '/wt/b'], [null, '/wt/a']] as const) {
      expect(sameTree(a, b)).toBe(sameClaimTree(a, b));
    }
    const t = Date.now();
    expect(sameTree('/'.repeat(200_000) + 'x', '/y')).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
