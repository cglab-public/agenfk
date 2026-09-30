/**
 * @vitest-environment jsdom
 *
 * The timeline paints each event type the colour seriesColours gives it, the
 * same in the bars, the legend and the hover list, and keeps it when the
 * selection changes (CGLAB-434 S3.1). A unit test of the helper cannot see a
 * caller that goes back to colouring by position; this renders the component.
 */
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimelineBar } from '../components/TimelineBar';
import { fmtBucketKey } from '../components/timelineAxis';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { cleanup(); get.mockReset(); });

const today = fmtBucketKey(new Date(), 'day');

function renderWith(types: string[], byType: Record<string, number>) {
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  get.mockResolvedValue({ data: { bucket: 'day', buckets: [{ time: today, total, by_type: byType }] } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TimelineBar types={types} range="7d" /></QueryClientProvider>);
}

/** Fill of each drawn segment, in drawing order (excludes the transparent hit targets). */
const fills = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('rect')).map(r => r.getAttribute('fill')).filter((f): f is string => !!f && f !== 'transparent');

/** Legend: type name -> swatch background. */
function legend(c: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of Array.from(c.querySelectorAll('footer > span'))) {
    const sw = item.querySelector('span') as HTMLElement;
    out[item.textContent!.trim()] = sw.style.background;
  }
  return out;
}

describe('TimelineBar colours', () => {
  it('validate.passed keeps its colour when another type joins the selection', async () => {
    const a = renderWith(['validate.passed'], { 'validate.passed': 3 });
    await waitFor(() => expect(fills(a.container)).toHaveLength(1));
    const alone = fills(a.container)[0];
    cleanup();
    const b = renderWith(['item.closed', 'validate.passed'], { 'item.closed': 2, 'validate.passed': 3 });
    await waitFor(() => expect(fills(b.container)).toHaveLength(2));
    expect(legend(b.container)['validate.passed']).toBe(alone);
    expect(fills(b.container)).toContain(alone);
    expect(alone).toBe('var(--series-5)');
  });

  it('each bar segment wears its own type\'s legend colour, in drawing order', async () => {
    // Name order (comment.added first) differs from click order, so colouring
    // by position would give each type the other's colour.
    const types = ['pr.updated', 'comment.added'];
    const { container } = renderWith(types, { 'pr.updated': 2, 'comment.added': 1 });
    await waitFor(() => expect(fills(container)).toHaveLength(2));
    const lg = legend(container);
    expect(lg['pr.updated']).not.toBe(lg['comment.added']);
    // Segments are drawn in selection order.
    expect(fills(container)).toEqual(types.map(t => lg[t]));
    expect(lg['comment.added']).toBe('var(--series-1)');
    expect(lg['pr.updated']).toBe('var(--series-2)');
  });
});
