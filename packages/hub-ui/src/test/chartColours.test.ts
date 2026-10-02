/**
 * Chart colours follow the thing they show, never its position (CGLAB-434 S3.1).
 *
 * The timeline used to colour a type by its index in the current selection, so
 * item.closed was teal alone and something else once validate.passed joined.
 * Colours are CSS variables from brand/tokens.css, so both themes get their own
 * validated steps.
 */
import { describe, it, expect } from 'vitest';
import { seriesColours, HEADLINE_TYPES, ALL_EVENTS_COLOR, OTHER_COLOR, heatColor, SPARK_STROKE } from '../chartColours';

describe('seriesColours', () => {
  it('pins the six headline event types to their own series colour', () => {
    const all = seriesColours(HEADLINE_TYPES);
    const colours = HEADLINE_TYPES.map(t => all[t]);
    for (const c of colours) expect(c).toMatch(/^var\(--series-[1-6]\)$/);
    expect(new Set(colours).size).toBe(6);
  });

  it('a headline type keeps its colour whatever else is selected, in any order', () => {
    const alone = seriesColours(['validate.passed'])['validate.passed'];
    for (const sel of [['item.closed', 'validate.passed'], ['pr.updated', 'validate.passed', 'item.created'], ['comment.added', 'test.logged', 'validate.passed']]) {
      expect(seriesColours(sel)['validate.passed']).toBe(alone);
      expect(seriesColours([...sel].reverse())['validate.passed']).toBe(alone);
    }
  });

  it('pass and fail are not coloured like warning and error: passed is a cool hue', () => {
    const c = seriesColours(['validate.passed', 'validate.failed']);
    expect(c['validate.passed']).toBe('var(--series-5)'); // sky
    expect(c['validate.failed']).toBe('var(--series-6)'); // rose
  });

  it('other selected types take the unused series slots, so two of them never share a colour', () => {
    const c = seriesColours(['pr.updated', 'comment.added']);
    expect(c['pr.updated']).toMatch(/^var\(--series-[1-6]\)$/);
    expect(c['comment.added']).toMatch(/^var\(--series-[1-6]\)$/);
    expect(c['pr.updated']).not.toBe(c['comment.added']);
  });

  it('other types never take a slot a selected headline type holds', () => {
    const c = seriesColours(['item.closed', 'comment.added', 'pr.updated']);
    const values = Object.values(c);
    expect(new Set(values).size).toBe(values.length);
  });

  it('other types are assigned by name, not by click order', () => {
    const a = seriesColours(['pr.updated', 'comment.added', 'test.logged']);
    const b = seriesColours(['test.logged', 'pr.updated', 'comment.added']);
    expect(a).toEqual(b);
  });

  it('past six colours the rest fold into one neutral "other", never a generated hue', () => {
    const many = [...HEADLINE_TYPES, 'comment.added', 'pr.updated'];
    const c = seriesColours(many);
    expect(c['comment.added']).toBe(OTHER_COLOR);
    expect(c['pr.updated']).toBe(OTHER_COLOR);
    expect(OTHER_COLOR).not.toMatch(/series|accent|status|brand/);
    expect(OTHER_COLOR).toMatch(/^var\(--/);
  });

  it('an unfiltered chart uses the indigo accent', () => {
    expect(ALL_EVENTS_COLOR).toBe('var(--accent)');
  });
});

describe('heatColor', () => {
  it('an empty cell has no fill', () => {
    expect(heatColor(0)).toBeUndefined();
  });

  it('mixes the accent token, denser as the count rises, capped at full strength', () => {
    const pct = (s: string | undefined) => Number(/(\d+(?:\.\d+)?)%/.exec(s ?? '')?.[1]);
    const [lo, mid, hi] = [0.1, 0.5, 1].map(heatColor);
    for (const c of [lo, mid, hi]) expect(c).toMatch(/^color-mix\(in srgb, var\(--accent\) [\d.]+%, transparent\)$/);
    expect(pct(lo)).toBeLessThan(pct(mid));
    expect(pct(mid)).toBeLessThan(pct(hi));
    expect(pct(heatColor(5))).toBe(100);
    // Even the lightest filled cell is visible against an empty one.
    expect(pct(lo)).toBeGreaterThanOrEqual(20);
  });
});

describe('sparkline', () => {
  it('strokes with the accent token', () => {
    expect(SPARK_STROKE).toBe('var(--accent)');
  });
});
