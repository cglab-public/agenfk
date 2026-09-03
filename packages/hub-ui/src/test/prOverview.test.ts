import { describe, it, expect } from 'vitest';
import { buildDayAxis, pctDelta, SIZE_META } from '../prOverview';

describe('buildDayAxis', () => {
  it('lists every calendar day in [from, to] inclusive (UTC)', () => {
    expect(buildDayAxis('2026-05-03T00:00:00Z', '2026-05-05T12:00:00Z')).toEqual([
      '2026-05-03', '2026-05-04', '2026-05-05',
    ]);
  });

  it('returns a single day when from and to are the same date', () => {
    expect(buildDayAxis('2026-05-03T01:00:00Z', '2026-05-03T23:00:00Z')).toEqual(['2026-05-03']);
  });

  it('caps the axis length to avoid runaway ranges', () => {
    const axis = buildDayAxis('2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
    expect(axis.length).toBeLessThanOrEqual(366);
  });
});

describe('pctDelta', () => {
  it('computes a rounded percentage change', () => {
    expect(pctDelta(63, 50)).toBe(26);
    expect(pctDelta(45, 60)).toBe(-25);
  });

  it('returns null when there is no baseline to compare against', () => {
    expect(pctDelta(5, 0)).toBeNull();
  });

  it('handles a drop to zero', () => {
    expect(pctDelta(0, 10)).toBe(-100);
  });
});

describe('SIZE_META', () => {
  it('defines an ordered XS–XL ramp with labels and colors', () => {
    expect(SIZE_META.map(s => s.key)).toEqual(['xs', 's', 'm', 'l', 'xl']);
    for (const s of SIZE_META) {
      expect(s.label).toBeTruthy();
      expect(s.color).toMatch(/^#/);
    }
  });

  it('gives each step a badge text color with legible contrast on its own fill (CGLAB-131 drill-down)', () => {
    // The ramp is light → dark on the dark canvas. Text rendered ON a fill
    // (the drill-down modal badge) must not use one fixed color: white on the
    // near-white light end reads as a blank white box. Light steps take the
    // dark primary ink, dark steps take white.
    for (const s of ['xs', 's', 'm'] as const) {
      expect(SIZE_META.find(x => x.key === s)!.text).toBe('#000f3b');
    }
    for (const s of ['l', 'xl'] as const) {
      expect(SIZE_META.find(x => x.key === s)!.text).toBe('#ffffff');
    }
  });
});
