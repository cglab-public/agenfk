import { describe, it, expect } from 'vitest';
import { aggregatePrOverview, PrEventRow } from '../queries/pr-overview-aggregate';

// Helper to build a raw json_extract-shaped row.
const row = (o: Partial<PrEventRow>): PrEventRow => ({
  user_key: 'alice@acme.com',
  occurred_at: '2026-05-03T10:00:00Z',
  type: 'pr.opened',
  repo: 'acme/api',
  pr_number: 1,
  leaf_story: 0,
  task: 1,
  bug: 0,
  model: 'claude-opus-4-8',
  harness: 'claude-code',
  ...o,
});

describe('aggregatePrOverview', () => {
  it('counts a single PR once and buckets it by size points', () => {
    // 1 leaf story (×4) + 1 task (×2) = 6 → 's'
    const r = aggregatePrOverview([row({ leaf_story: 1, task: 1 })]);
    expect(r.totals.prs).toBe(1);
    expect(r.totals.sizePoints).toBe(6);
    expect(r.totals.developers).toBe(1);
    expect(r.byDay).toEqual([
      { day: '2026-05-03', sizes: { xs: 0, s: 1, m: 0, l: 0, xl: 0 }, total: 1 },
    ]);
    expect(r.byDeveloper[0].user_key).toBe('alice@acme.com');
    expect(r.byDeveloper[0].sizes.s).toBe(1);
  });

  it('dedupes pr.updated onto the same PR — counts once, at the LATEST sizing', () => {
    const rows = [
      row({ pr_number: 7, type: 'pr.opened', occurred_at: '2026-05-03T10:00:00Z', task: 1, leaf_story: 0 }), // 2 pts → xs
      row({ pr_number: 7, type: 'pr.updated', occurred_at: '2026-05-04T10:00:00Z', task: 4, leaf_story: 1 }), // 12 pts → m
    ];
    const r = aggregatePrOverview(rows);
    expect(r.totals.prs).toBe(1); // counted ONCE
    expect(r.totals.sizePoints).toBe(12); // latest sizing wins
    // placed on the OPEN day, at its final (latest) size
    expect(r.byDay).toEqual([
      { day: '2026-05-03', sizes: { xs: 0, s: 0, m: 1, l: 0, xl: 0 }, total: 1 },
    ]);
    expect(r.resized).toEqual({ count: 1, grew: 1, shrank: 0 });
  });

  it('attributes a resized PR to its OPENER, not the later updater', () => {
    const rows = [
      row({ pr_number: 9, type: 'pr.opened', user_key: 'alice@acme.com', occurred_at: '2026-05-03T10:00:00Z', model: 'claude-opus-4-8' }),
      row({ pr_number: 9, type: 'pr.updated', user_key: 'bob@acme.com', occurred_at: '2026-05-05T10:00:00Z', model: 'glm-5.2', task: 1, bug: 1 }),
    ];
    const r = aggregatePrOverview(rows);
    expect(r.totals.developers).toBe(1);
    expect(r.byDeveloper).toHaveLength(1);
    expect(r.byDeveloper[0].user_key).toBe('alice@acme.com');
    // model attribution also follows the opener
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0].model).toBe('claude-opus-4-8');
  });

  it('rolls up per developer and per model with size distributions', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com', model: 'claude-opus-4-8', task: 1 }),        // 2 → xs
      row({ pr_number: 2, user_key: 'alice@acme.com', model: 'claude-opus-4-8', leaf_story: 1, task: 4 }), // 12 → m
      row({ pr_number: 3, user_key: 'bob@acme.com', model: 'claude-sonnet-4-6', task: 2 }),         // 4 → s
    ];
    const r = aggregatePrOverview(rows);
    const alice = r.byDeveloper.find(d => d.user_key === 'alice@acme.com')!;
    expect(alice.prs).toBe(2);
    expect(alice.sizes).toEqual({ xs: 1, s: 0, m: 1, l: 0, xl: 0 });
    expect(alice.sizePoints).toBe(14);
    // byDeveloper sorted by prs desc → alice first
    expect(r.byDeveloper[0].user_key).toBe('alice@acme.com');

    const opus = r.byModel.find(m => m.model === 'claude-opus-4-8')!;
    expect(opus.prs).toBe(2);
    expect(opus.harnesses).toEqual(['claude-code']);
    const sonnet = r.byModel.find(m => m.model === 'claude-sonnet-4-6')!;
    expect(sonnet.prs).toBe(1);
  });

  it('classifies a PR that shrank on update', () => {
    const rows = [
      row({ pr_number: 5, type: 'pr.opened', occurred_at: '2026-05-03T10:00:00Z', leaf_story: 1, task: 4 }), // 12 → m
      row({ pr_number: 5, type: 'pr.updated', occurred_at: '2026-05-04T10:00:00Z', leaf_story: 0, task: 1 }), // 2 → xs
    ];
    const r = aggregatePrOverview(rows);
    expect(r.totals.sizePoints).toBe(2); // latest (smaller) sizing wins
    expect(r.resized).toEqual({ count: 1, grew: 0, shrank: 1 });
  });

  it('a re-size that keeps the same points is not counted as resized', () => {
    const rows = [
      row({ pr_number: 6, type: 'pr.opened', occurred_at: '2026-05-03T10:00:00Z', task: 2 }),
      row({ pr_number: 6, type: 'pr.updated', occurred_at: '2026-05-04T10:00:00Z', task: 2 }),
    ];
    expect(aggregatePrOverview(rows).resized).toEqual({ count: 0, grew: 0, shrank: 0 });
  });

  it('omits harness from a model row when no harness was reported', () => {
    const r = aggregatePrOverview([row({ harness: null })]);
    expect(r.byModel[0].harnesses).toEqual([]);
  });

  it('keeps a PR opened in-window even if a later event would fall outside it', () => {
    const rows = [
      row({ pr_number: 8, type: 'pr.opened', occurred_at: '2026-05-03T10:00:00Z' }),
      row({ pr_number: 8, type: 'pr.updated', occurred_at: '2026-05-09T10:00:00Z', task: 3 }),
    ];
    // opener 05-03 is inside [05-01, 05-05]; the PR is kept and sized by the latest event.
    const r = aggregatePrOverview(rows, { from: '2026-05-01T00:00:00Z', to: '2026-05-05T00:00:00Z' });
    expect(r.totals.prs).toBe(1);
    expect(r.byDay[0].day).toBe('2026-05-03');
  });

  it('excludes a PR opened before the window even if it was re-sized inside it', () => {
    const rows = [
      row({ pr_number: 10, type: 'pr.opened', occurred_at: '2026-04-20T10:00:00Z' }),
      row({ pr_number: 10, type: 'pr.updated', occurred_at: '2026-05-03T10:00:00Z', task: 3 }),
    ];
    const r = aggregatePrOverview(rows, { from: '2026-05-01T00:00:00Z', to: '2026-05-05T00:00:00Z' });
    expect(r.totals.prs).toBe(0); // opener is before `from`
  });

  it('model filter matches the OPENER model, even when a later re-size used another model', () => {
    const rows = [
      row({ pr_number: 11, type: 'pr.opened', user_key: 'alice@acme.com', occurred_at: '2026-05-03T10:00:00Z', model: 'claude-opus-4-8' }),
      row({ pr_number: 11, type: 'pr.updated', user_key: 'bob@acme.com', occurred_at: '2026-05-04T10:00:00Z', model: 'glm-5.2', task: 3 }),
      row({ pr_number: 12, type: 'pr.opened', user_key: 'bob@acme.com', occurred_at: '2026-05-03T11:00:00Z', model: 'glm-5.2' }),
    ];
    const opus = aggregatePrOverview(rows, { model: 'claude-opus-4-8' });
    expect(opus.totals.prs).toBe(1); // PR#11 only (opened with opus); the glm re-size does not drop it
    expect(opus.byDeveloper[0].user_key).toBe('alice@acme.com');

    const glm = aggregatePrOverview(rows, { model: 'glm-5.2' });
    expect(glm.totals.prs).toBe(1); // PR#12 only — PR#11 was OPENED with opus, not glm
    expect(glm.byDeveloper[0].user_key).toBe('bob@acme.com');
  });

  it('computes the median bucket for an even number of PRs (lower-middle)', () => {
    const rows = [
      row({ pr_number: 1, task: 1 }),                 // xs (2)
      row({ pr_number: 2, task: 2 }),                 // s (4)
      row({ pr_number: 3, leaf_story: 1, task: 4 }),  // m (12)
      row({ pr_number: 4, leaf_story: 4, task: 4 }),  // l (24)
    ];
    // 4 PRs → buckets [xs,s,m,l]; lower-middle of the two centres (s,m) → s
    expect(aggregatePrOverview(rows).totals.medianBucket).toBe('s');
  });

  it('computes the median bucket across PRs', () => {
    const rows = [
      row({ pr_number: 1, task: 1 }),                 // xs (2)
      row({ pr_number: 2, task: 2 }),                 // s (4)
      row({ pr_number: 3, leaf_story: 1, task: 4 }),  // m (12)
    ];
    const r = aggregatePrOverview(rows);
    expect(r.totals.medianBucket).toBe('s');
  });

  it('labels missing model as "unknown" and tolerates missing leafStory (old events)', () => {
    const r = aggregatePrOverview([row({ model: null, leaf_story: null, task: 1 })]);
    expect(r.byModel[0].model).toBe('unknown');
    expect(r.totals.sizePoints).toBe(2); // leaf_story null treated as 0
  });

  it('ignores rows without a repo/prNumber', () => {
    const r = aggregatePrOverview([row({ repo: null }), row({ pr_number: null })]);
    expect(r.totals.prs).toBe(0);
    expect(r.totals.medianBucket).toBeNull();
  });
});
