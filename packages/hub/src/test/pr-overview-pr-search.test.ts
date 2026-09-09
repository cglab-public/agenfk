import { describe, it, expect } from 'vitest';
import { aggregatePrOverview, parsePrNumberFilter, PrEventRow } from '../queries/pr-overview-aggregate';

/**
 * PR Overview — search by PR number (story 79220886).
 *
 * The search exists because a PR is a *thing you are looking for*, not a point
 * in a reporting window. Someone arrives with "#57" and wants that PR; making
 * them first widen the date range, clear the model facet and clear the
 * developer facet to find it is the whole friction the feature removes.
 *
 * So the number SUPERSEDES every other window predicate:
 *   - `from` / `to`   — a PR opened a year ago is still PR #57 today,
 *   - `models`        — the runtime that opened it is an attribute of the answer,
 *                       not a precondition of finding it,
 *   - `developers`    — same for the opener.
 *
 * What it does NOT supersede is the project (git remote) filter. That one is
 * applied in SQL, upstream of this function (`remote_url IN (...)`), because a
 * PR number is only unique inside one repo — `#57` exists in every repo the org
 * has ever reported. Keeping project as the one live axis is what stops a
 * number search from returning an unrelated `#57` from another repo.
 */

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
  remote_url: 'git@github.com:acme/api.git',
  ...o,
});

// Three PRs spread across openers, models and months, so any one of the
// superseded filters can be shown to be genuinely out of the way.
const ROWS: PrEventRow[] = [
  row({ pr_number: 11, occurred_at: '2025-01-05T10:00:00Z', user_key: 'alice@acme.com', model: 'claude-opus-4-8' }),
  row({ pr_number: 57, occurred_at: '2025-02-10T11:00:00Z', user_key: 'bob@acme.com', model: 'glm-5.2', task: 4 }),
  row({ pr_number: 58, occurred_at: '2026-05-03T12:00:00Z', user_key: 'carol@acme.com', model: 'qwen3.8-27b' }),
];

describe('parsePrNumberFilter', () => {
  it('parses a bare number and the # form people copy from GitHub', () => {
    expect(parsePrNumberFilter('57')).toBe(57);
    expect(parsePrNumberFilter('#57')).toBe(57);
    expect(parsePrNumberFilter(' 57 ')).toBe(57);
  });

  it('parses a pasted PR URL down to the number', () => {
    expect(parsePrNumberFilter('https://github.com/acme/api/pull/57')).toBe(57);
    expect(parsePrNumberFilter('https://github.com/acme/api/pull/57/files')).toBe(57);
    expect(parsePrNumberFilter('https://gitlab.com/acme/api/-/merge_requests/57')).toBe(57);
  });

  it('passes through a number the caller already parsed', () => {
    expect(parsePrNumberFilter(57)).toBe(57);
  });

  it('rejects numbers that are not a PR number, on the numeric path too', () => {
    // The string path has these cases covered; the numeric branch is a separate
    // expression and was not. Without them, `&& value > 0` can loosen to `||`
    // or `>= 0` and ?pr=0 becomes a search that matches nothing — the exact
    // blank-page-not-no-filter failure the parser exists to avoid.
    expect(parsePrNumberFilter(0)).toBeNull();
    expect(parsePrNumberFilter(-57)).toBeNull();
    expect(parsePrNumberFilter(1.5)).toBeNull();
    expect(parsePrNumberFilter(NaN)).toBeNull();
    expect(parsePrNumberFilter(Infinity)).toBeNull();
    expect(parsePrNumberFilter(9007199254740993)).toBeNull();
  });

  it('returns null for a value that is neither string nor number, rather than throwing', () => {
    // Express hands over whatever the query string held. Without the typeof
    // guard the next line is value.trim() on an object — a TypeError, and a 500
    // on an authenticated endpoint, from a hand-edited link.
    expect(() => parsePrNumberFilter({})).not.toThrow();
    expect(parsePrNumberFilter({})).toBeNull();
    expect(parsePrNumberFilter(true)).toBeNull();
    expect(parsePrNumberFilter([{}])).toBeNull();
    expect(parsePrNumberFilter([])).toBeNull();
    expect(parsePrNumberFilter(new Date())).toBeNull();
  });

  it('returns null for absent, empty and non-numeric input (no filter, not zero rows)', () => {
    expect(parsePrNumberFilter(undefined)).toBeNull();
    expect(parsePrNumberFilter(null)).toBeNull();
    expect(parsePrNumberFilter('')).toBeNull();
    expect(parsePrNumberFilter('   ')).toBeNull();
    expect(parsePrNumberFilter('abc')).toBeNull();
    expect(parsePrNumberFilter('12a')).toBeNull();
    expect(parsePrNumberFilter('0')).toBeNull();
    expect(parsePrNumberFilter('-57')).toBeNull();
    expect(parsePrNumberFilter('https://github.com/acme/api')).toBeNull();
    // past MAX_SAFE_INTEGER the number is no longer exact, so a match would be
    // a rounding coincidence rather than the PR the user asked for.
    expect(parsePrNumberFilter('9007199254740993')).toBeNull();
  });

  it('survives an array (repeated ?pr= params arrive as one from Express)', () => {
    // Same defensive shape as parseList for the other filters: never throw.
    expect(() => parsePrNumberFilter(['57', '58'] as unknown as string)).not.toThrow();
    expect(parsePrNumberFilter(['57', '58'] as unknown as string)).toBe(57);
  });
});

describe('aggregatePrOverview — PR number search', () => {
  it('returns just the PR with that number', () => {
    const r = aggregatePrOverview(ROWS, { prNumber: 57 });
    expect(r.totals.prs).toBe(1);
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0]).toMatchObject({ prNumber: 57, user_key: 'bob@acme.com', model: 'glm-5.2' });
  });

  it('supersedes the date window — a PR opened outside from/to is still found', () => {
    // PR#57 opened 2025-02-10; this window covers only 2026-05.
    const windowed = aggregatePrOverview(ROWS, { from: '2026-05-01T00:00:00Z', to: '2026-05-31T23:59:59Z' });
    expect(windowed.prs.map(p => p.prNumber)).toEqual([58]);

    const searched = aggregatePrOverview(ROWS, {
      from: '2026-05-01T00:00:00Z', to: '2026-05-31T23:59:59Z', prNumber: 57,
    });
    expect(searched.totals.prs).toBe(1);
    expect(searched.prs[0].prNumber).toBe(57);
  });

  it('supersedes the model filter — the runtime is an attribute of the answer, not a precondition', () => {
    // PR#57 was opened by glm-5.2, which the filter excludes.
    const r = aggregatePrOverview(ROWS, { models: ['claude-opus-4-8'], prNumber: 57 });
    expect(r.totals.prs).toBe(1);
    expect(r.prs[0].model).toBe('glm-5.2');
  });

  it('supersedes the developer filter — a PR is found whoever opened it', () => {
    const r = aggregatePrOverview(ROWS, { developers: ['carol@acme.com'], prNumber: 57 });
    expect(r.totals.prs).toBe(1);
    expect(r.prs[0].user_key).toBe('bob@acme.com');
  });

  it('supersedes all of them at once', () => {
    const r = aggregatePrOverview(ROWS, {
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T23:59:59Z',
      models: ['claude-opus-4-8'],
      developers: ['carol@acme.com'],
      prNumber: 57,
    });
    expect(r.totals.prs).toBe(1);
    expect(r.prs[0].prNumber).toBe(57);
  });

  it('accepts the number as a string, the shape json_extract hands over', () => {
    const r = aggregatePrOverview(ROWS, { prNumber: '57' });
    expect(r.totals.prs).toBe(1);
    expect(r.prs[0].prNumber).toBe(57);
  });

  it('matches the number alone, not the number of some other repo\'s PR', () => {
    // Same number in two repos: the aggregator sees both and returns both —
    // narrowing to one repo is the project filter's job (SQL side).
    const rows = [
      ...ROWS,
      row({ repo: 'acme/web', pr_number: 57, occurred_at: '2026-04-01T10:00:00Z', user_key: 'dave@acme.com' }),
    ];
    const r = aggregatePrOverview(rows, { prNumber: 57 });
    expect(r.totals.prs).toBe(2);
    expect(r.prs.map(p => p.repo).sort()).toEqual(['acme/api', 'acme/web']);
  });

  it('returns an honest empty result when no PR has that number', () => {
    const r = aggregatePrOverview(ROWS, { prNumber: 999 });
    expect(r.totals).toEqual({ prs: 0, sizePoints: 0, developers: 0, medianBucket: null });
    expect(r.prs).toEqual([]);
    expect(r.byDay).toEqual([]);
    expect(r.byDeveloper).toEqual([]);
    expect(r.byModel).toEqual([]);
  });

  it('applies NO number filter for null, empty or unparseable values (never silently zero the page)', () => {
    for (const v of [null, undefined, '', '  ', 'abc', '0', NaN]) {
      expect(aggregatePrOverview(ROWS, { prNumber: v as number | string | null | undefined }).totals.prs)
        .toBe(3);
    }
  });

  it('keeps "latest sizing wins" while superseding a window that excludes the re-size', () => {
    // PR#57 opens small on 2025-02-10 and is re-sized on 2026-06. A window that
    // ends before the re-size must not pin the answer to the stale size — the
    // search reads the whole event stream for that PR.
    const rows = [
      ...ROWS,
      row({
        pr_number: 57, type: 'pr.updated', occurred_at: '2026-06-01T10:00:00Z',
        user_key: 'bob@acme.com', model: 'glm-5.2', task: 4, leaf_story: 10,
      }),
    ];
    const r = aggregatePrOverview(rows, { prNumber: 57, to: '2025-12-31T23:59:59Z' });
    expect(r.totals.prs).toBe(1);
    // 10 leaf stories (×4) + 4 tasks (×2) = 48 pts → XL, the LATEST sizing.
    expect(r.prs[0]).toMatchObject({ points: 48, bucket: 'xl' });
    // …but it is still placed on the day it OPENED.
    expect(r.prs[0].day).toBe('2025-02-10');
  });

  it('drives every breakdown off the single matched PR, so the charts stay coherent', () => {
    const r = aggregatePrOverview(ROWS, { prNumber: 57 });
    // 4 tasks × 2 pts = 8 → 'm'
    expect(r.totals).toMatchObject({ prs: 1, sizePoints: 8, developers: 1, medianBucket: 'm' });
    expect(r.byDay).toMatchObject([{ day: '2025-02-10', total: 1 }]);
    expect(r.byDeveloper.map(d => d.user_key)).toEqual(['bob@acme.com']);
    expect(r.byModel.map(m => m.model)).toEqual(['glm-5.2']);
  });
});
