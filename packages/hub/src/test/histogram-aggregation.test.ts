/**
 * Regression test for BUG 307a9fbe: under Postgres, `COUNT(*)` returns a
 * bigint that the `pg` driver serializes as a STRING (because bigints can
 * exceed Number.MAX_SAFE_INTEGER and the driver refuses to silently lossy-cast).
 * The histogram aggregation loop in `routes/queries.ts` did:
 *
 *   entry.by_type[r.type] = r.n;
 *   entry.total += r.n;
 *
 * which under Postgres produced `total = "012"` (string concatenation) when
 * three buckets had counts "0","1","2" — manifesting in the UI as the
 * tooltip showing concatenated digits instead of an integer sum when more
 * than one event type was visible.
 *
 * pg-mem (used in the dual-backend parity tests) auto-coerces aggregates back
 * to JS numbers, so the bug only surfaces against real Postgres. This test
 * pins the contract directly by exercising the aggregation function with
 * string-typed rows (the actual prod-shape).
 */
import { describe, it, expect } from 'vitest';
import { aggregateHistogramRows } from '../queries/histogram-aggregate';

describe('BUG 307a9fbe — histogram aggregation must coerce string counts to numbers', () => {
  it('returns total as a number when counts are JS numbers (SQLite path)', () => {
    const buckets = aggregateHistogramRows([
      { time: '2026-05-03', type: 'item.created', n: 1 },
      { time: '2026-05-03', type: 'step.transitioned', n: 2 },
    ]);
    expect(buckets).toHaveLength(1);
    expect(typeof buckets[0].total).toBe('number');
    expect(buckets[0].total).toBe(3);
    expect(typeof buckets[0].by_type['item.created']).toBe('number');
    expect(buckets[0].by_type['item.created']).toBe(1);
    expect(buckets[0].by_type['step.transitioned']).toBe(2);
  });

  it('returns total as a number when counts arrive as STRINGS (Postgres path)', () => {
    // Exact prod shape: pg returns COUNT(*) as a stringified bigint.
    const buckets = aggregateHistogramRows([
      { time: '2026-05-03', type: 'item.created', n: '1' as any },
      { time: '2026-05-03', type: 'step.transitioned', n: '2' as any },
      { time: '2026-05-03', type: 'validate.passed', n: '7' as any },
    ]);
    expect(buckets).toHaveLength(1);
    expect(typeof buckets[0].total).toBe('number');
    // The bug produced "0127" for these three counts. Strict numeric assertion.
    expect(buckets[0].total).toBe(10);
    expect(typeof buckets[0].by_type['item.created']).toBe('number');
    expect(buckets[0].by_type['item.created']).toBe(1);
    expect(buckets[0].by_type['step.transitioned']).toBe(2);
    expect(buckets[0].by_type['validate.passed']).toBe(7);
  });

  it('groups multiple buckets and sums each independently', () => {
    const buckets = aggregateHistogramRows([
      { time: '2026-05-03', type: 'a', n: '4' as any },
      { time: '2026-05-03', type: 'b', n: '5' as any },
      { time: '2026-05-04', type: 'a', n: '11' as any },
    ]);
    const may3 = buckets.find((b) => b.time === '2026-05-03')!;
    const may4 = buckets.find((b) => b.time === '2026-05-04')!;
    expect(may3.total).toBe(9);
    expect(may4.total).toBe(11);
    expect(typeof may3.total).toBe('number');
    expect(typeof may4.total).toBe('number');
  });

  it('preserves SQL row order in the output buckets array', () => {
    const buckets = aggregateHistogramRows([
      { time: '2026-05-01', type: 'a', n: 1 },
      { time: '2026-05-02', type: 'a', n: 1 },
      { time: '2026-05-03', type: 'a', n: 1 },
    ]);
    expect(buckets.map((b) => b.time)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
  });
});
