import { describe, it, expect } from 'vitest';
import { coerceMetricsRow } from '../queries/metrics-coerce';

describe('coerceMetricsRow — string→Number for Postgres bigint columns', () => {
  it('Numbers the six numeric columns (regression: leading zeros from concat)', () => {
    const row = {
      user_key: 'tester',
      day: '2026-05-05',
      events_count: '78113',
      items_closed: '401',
      tokens_in: '12345',
      tokens_out: '67890',
      validate_passes: '701',
      validate_fails: '100',
    };
    const out = coerceMetricsRow(row);
    expect(out.events_count).toBe(78113);
    expect(out.items_closed).toBe(401);
    expect(out.tokens_in).toBe(12345);
    expect(out.tokens_out).toBe(67890);
    expect(out.validate_passes).toBe(701);
    expect(out.validate_fails).toBe(100);
    // Identity columns pass through unchanged.
    expect(out.user_key).toBe('tester');
    expect(out.day).toBe('2026-05-05');
  });

  it('summing across rows produces a real number, not a concatenated string', () => {
    const rows = [
      { user_key: 'a', day: '2026-05-05', events_count: '500', items_closed: '0', tokens_in: '0', tokens_out: '0', validate_passes: '0', validate_fails: '0' },
      { user_key: 'b', day: '2026-05-05', events_count: '113', items_closed: '0', tokens_in: '0', tokens_out: '0', validate_passes: '0', validate_fails: '0' },
    ].map(coerceMetricsRow);
    const total = rows.reduce((acc, r) => acc + r.events_count, 0);
    expect(total).toBe(613);
    expect(typeof total).toBe('number');
  });

  it('passes through real numbers unchanged (sqlite returns numbers natively)', () => {
    const row = {
      user_key: 'x', day: '2026-05-05',
      events_count: 42, items_closed: 1, tokens_in: 0, tokens_out: 0,
      validate_passes: 0, validate_fails: 0,
    };
    expect(coerceMetricsRow(row).events_count).toBe(42);
  });

  it('treats null / undefined as 0 (no NaN propagation)', () => {
    const row = {
      user_key: 'x', day: '2026-05-05',
      events_count: null, items_closed: undefined, tokens_in: null, tokens_out: null,
      validate_passes: null, validate_fails: null,
    } as any;
    const out = coerceMetricsRow(row);
    expect(out.events_count).toBe(0);
    expect(out.items_closed).toBe(0);
  });
});
