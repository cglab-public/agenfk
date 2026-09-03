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
  remote_url: null,
  ...o,
});

describe('aggregatePrOverview', () => {
  it('counts a single PR once and buckets it by size points', () => {
    // 1 leaf story (×4) + 1 task (×2) = 6 → 's'
    const r = aggregatePrOverview([row({ leaf_story: 1, task: 1 })]);
    expect(r.totals.prs).toBe(1);
    expect(r.totals.sizePoints).toBe(6);
    expect(r.totals.developers).toBe(1);
    expect(r.byDay).toMatchObject([
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
    expect(r.byDay).toMatchObject([
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

  it('byDay carries a per-size developer breakdown (for slice tooltips)', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com', occurred_at: '2026-05-03T10:00:00Z', task: 1 }),               // xs
      row({ pr_number: 2, user_key: 'bob@acme.com', occurred_at: '2026-05-03T11:00:00Z', task: 1 }),                 // xs
      row({ pr_number: 3, user_key: 'alice@acme.com', occurred_at: '2026-05-03T12:00:00Z', leaf_story: 1, task: 4 }), // m
    ];
    const day = aggregatePrOverview(rows).byDay.find(d => d.day === '2026-05-03')!;
    expect(day.devBySize.xs).toEqual([
      { user_key: 'alice@acme.com', count: 1 },
      { user_key: 'bob@acme.com', count: 1 },
    ]);
    expect(day.devBySize.m).toEqual([{ user_key: 'alice@acme.com', count: 1 }]);
    expect(day.devBySize.s).toEqual([]);
  });

  it('per-size developer breakdown sorts by count desc', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com', task: 1 }),
      row({ pr_number: 2, user_key: 'alice@acme.com', task: 1 }),
      row({ pr_number: 3, user_key: 'bob@acme.com', task: 1 }),
    ];
    const day = aggregatePrOverview(rows).byDay[0];
    expect(day.devBySize.xs).toEqual([
      { user_key: 'alice@acme.com', count: 2 },
      { user_key: 'bob@acme.com', count: 1 },
    ]);
  });

  it('filters by developer on the opener (multi-select)', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com' }),
      row({ pr_number: 2, user_key: 'bob@acme.com' }),
      row({ pr_number: 3, user_key: 'carol@acme.com' }),
      // opened by alice, re-sized by bob → filtering bob must NOT pull it in
      row({ pr_number: 4, type: 'pr.opened', user_key: 'alice@acme.com', occurred_at: '2026-05-03T09:00:00Z' }),
      row({ pr_number: 4, type: 'pr.updated', user_key: 'bob@acme.com', occurred_at: '2026-05-04T09:00:00Z', task: 2 }),
    ];
    const r = aggregatePrOverview(rows, { developers: ['alice@acme.com', 'bob@acme.com'] });
    expect(r.totals.prs).toBe(3); // alice #1 #4, bob #2 — carol excluded
    expect(r.byDeveloper.map(d => d.user_key).sort()).toEqual(['alice@acme.com', 'bob@acme.com']);
    const alice = r.byDeveloper.find(d => d.user_key === 'alice@acme.com')!;
    expect(alice.prs).toBe(2); // #4 attributed to its opener, not bob
  });

  it('handles Postgres row shapes — Date occurred_at and string-typed numerics', () => {
    // On Postgres, occurred_at (TIMESTAMPTZ) comes back as a JS Date and
    // jsonb_extract_path_text numerics come back as strings. The aggregator must
    // normalise both rather than calling .slice()/.localeCompare() on a Date or
    // doing string math. (Regression: prod 500 "iso.slice is not a function".)
    const pgRow = (o: Record<string, unknown>) => ({
      user_key: 'alice@acme.com',
      occurred_at: new Date('2026-05-03T10:00:00Z'),
      type: 'pr.opened',
      repo: 'acme/api',
      pr_number: '7',          // pg returns text
      leaf_story: '1',
      task: '4',
      bug: '0',
      model: 'claude-opus-4-8',
      harness: 'claude-code',
      ...o,
    }) as unknown as PrEventRow;

    const r = aggregatePrOverview([
      pgRow({}),
      pgRow({ type: 'pr.updated', occurred_at: new Date('2026-05-04T10:00:00Z'), task: '1', leaf_story: '0' }),
    ]);
    expect(r.totals.prs).toBe(1);
    expect(r.totals.sizePoints).toBe(2); // latest: leafStory 0 + task 1 → 2
    expect(r.byDay).toMatchObject([
      { day: '2026-05-03', sizes: { xs: 1, s: 0, m: 0, l: 0, xl: 0 }, total: 1 },
    ]);
    expect(r.resized).toEqual({ count: 1, grew: 0, shrank: 1 });
  });

  it('applies the opener-day window correctly when occurred_at is a Date (Postgres)', () => {
    const r = aggregatePrOverview(
      [{
        user_key: 'a@x', occurred_at: new Date('2026-05-03T10:00:00Z'), type: 'pr.opened',
        repo: 'acme/api', pr_number: 1, leaf_story: 0, task: 1, bug: 0, model: 'm', harness: 'h',
      } as unknown as PrEventRow],
      { from: '2026-05-01T00:00:00Z', to: '2026-05-05T00:00:00Z' },
    );
    expect(r.totals.prs).toBe(1); // Date openerAt must compare correctly against ISO bounds
  });

  it('ignores rows without a repo/prNumber', () => {
    const r = aggregatePrOverview([row({ repo: null }), row({ pr_number: null })]);
    expect(r.totals.prs).toBe(0);
    expect(r.totals.medianBucket).toBeNull();
  });
});

// CGLAB-131 — the heatmap drill-down: the overview response carries the same
// resolved PR set as a detail list, so the per-cell modal can never drift from
// the cell it backs (one aggregation pass, same opener attribution and window).
describe('prs detail list (drill-down)', () => {
  const GH = 'git@github.com:acme/api.git';

  it('exposes one entry per PR with the full drill-down shape', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com', occurred_at: '2026-05-03T10:00:00Z', task: 1, remote_url: GH }),
      row({ pr_number: 2, user_key: 'bob@acme.com', occurred_at: '2026-05-03T11:00:00Z', repo: 'acme/web', leaf_story: 1, remote_url: 'git@github.com:acme/web.git' }),
    ];
    const r = aggregatePrOverview(rows);
    expect(r.prs).toHaveLength(2);
    const [p1, p2] = r.prs;
    expect(p1).toMatchObject({
      repo: 'acme/api', prNumber: 1, user_key: 'alice@acme.com',
      model: 'claude-opus-4-8', harness: 'claude-code',
      openedAt: '2026-05-03T10:00:00Z', day: '2026-05-03',
      points: 2, bucket: 'xs', url: 'https://github.com/acme/api/pull/1',
    });
    expect(p2.url).toBe('https://github.com/acme/web/pull/2');
    expect(p2.bucket).toBe('s'); // leafStory 1 → 4 pts
    expect(typeof p1.prNumber).toBe('number');
  });

  it('counts a resized PR once at its latest size, on its open day, at the opener identity', () => {
    const rows = [
      row({ pr_number: 9, user_key: 'alice@acme.com', occurred_at: '2026-05-03T09:00:00Z', task: 1, remote_url: GH }), // 2 → xs
      row({ pr_number: 9, type: 'pr.updated', user_key: 'bob@acme.com', occurred_at: '2026-05-05T09:00:00Z', model: 'glm-5.2', task: 4, remote_url: 'git@ghe.internal:acme/api.git' }), // 8 → m
    ];
    const r = aggregatePrOverview(rows);
    expect(r.prs).toHaveLength(1);
    const p = r.prs[0];
    expect(p.user_key).toBe('alice@acme.com'); // opener
    expect(p.model).toBe('claude-opus-4-8');   // opener's model
    expect(p.day).toBe('2026-05-03');          // open day
    expect(p.bucket).toBe('m');                // latest sizing (8 pts)
    // the link follows the OPENER's remote — bob's GHE remote must not leak in
    expect(p.url).toBe('https://github.com/acme/api/pull/9');
  });

  it('returns a null url for non-GitHub remotes (no guessing)', () => {
    const rows = [row({ pr_number: 5, repo: 'team/service', remote_url: 'git@ghe.internal:team/service.git' })];
    const r = aggregatePrOverview(rows);
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0].url).toBeNull();
  });

  it('falls back to the payload slug for the link when the remote is missing', () => {
    const rows = [row({ pr_number: 6, repo: 'acme/api', remote_url: null })];
    const r = aggregatePrOverview(rows);
    expect(r.prs[0].url).toBe('https://github.com/acme/api/pull/6');
  });

  it('applies the window, model and developer filters to the list exactly like the totals', () => {
    const rows = [
      row({ pr_number: 1, user_key: 'alice@acme.com', occurred_at: '2026-05-01T09:00:00Z', remote_url: GH }),
      row({ pr_number: 2, user_key: 'alice@acme.com', occurred_at: '2026-05-03T09:00:00Z', model: 'glm-5.2', remote_url: GH }),
      row({ pr_number: 3, user_key: 'bob@acme.com', occurred_at: '2026-05-03T09:00:00Z', remote_url: GH }),
    ];
    const all = aggregatePrOverview(rows);
    expect(all.prs).toHaveLength(3);
    // #1 opened before the window — excluded, same rule as the totals
    const win = aggregatePrOverview(rows, { from: '2026-05-02T00:00:00Z' });
    expect(win.prs.map(p => p.prNumber).sort()).toEqual([2, 3]);
    // model filter matches the OPENER's model
    const byModel = aggregatePrOverview(rows, { model: 'glm-5.2' });
    expect(byModel.prs.map(p => p.prNumber)).toEqual([2]);
    // developer filter is opener-based
    const byDev = aggregatePrOverview(rows, { developers: ['bob@acme.com'] });
    expect(byDev.prs.map(p => p.prNumber)).toEqual([3]);
  });

  it('orders the list by open time, then repo#number (stable for the modal)', () => {
    const rows = [
      row({ pr_number: 3, occurred_at: '2026-05-03T09:00:00Z', remote_url: GH }),
      row({ pr_number: 1, repo: 'acme/zeta', occurred_at: '2026-05-03T08:00:00Z', remote_url: 'git@github.com:acme/zeta.git' }),
      row({ pr_number: 2, occurred_at: '2026-05-03T08:00:00Z', remote_url: GH }), // ties #1 on time → repo#number breaks it
    ];
    const r = aggregatePrOverview(rows);
    // 'acme/api#2' < 'acme/zeta#1' → the api PR comes first
    expect(r.prs.map(p => p.prNumber)).toEqual([2, 1, 3]);
  });
});
