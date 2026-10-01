/**
 * @vitest-environment jsdom
 *
 * Story f6fce254: the timeline drew in a fixed 920×220 viewBox stretched over
 * a full-width 220px box with preserveAspectRatio="none", so x and y scaled
 * differently — axis text squashed, rounded bar corners turned to ellipses.
 * It now draws in the box's own pixels: the viewBox is as wide as the box,
 * nothing stretches it, and a resize redraws at the new width.
 */
import React from 'react';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimelineBar } from '../components/TimelineBar';
import { fmtBucketKey } from '../components/timelineAxis';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

/** A ResizeObserver the test drives: `resize(w)` reports a new box width. */
let observers: Array<{ cb: ResizeObserverCallback; el: Element | null }> = [];
class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; el: Element | null };
  constructor(cb: ResizeObserverCallback) { this.entry = { cb, el: null }; observers.push(this.entry); }
  observe(el: Element) { this.entry.el = el; }
  unobserve() { this.entry.el = null; }
  disconnect() { this.entry.el = null; }
}
const resize = (width: number) => act(() => {
  for (const o of observers) {
    if (!o.el) continue;
    o.cb([{ target: o.el, contentRect: { width, height: 220 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  }
});

const original = (globalThis as any).ResizeObserver;
beforeEach(() => { observers = []; (globalThis as any).ResizeObserver = FakeResizeObserver; });
afterEach(() => { cleanup(); get.mockReset(); (globalThis as any).ResizeObserver = original; });

const today = fmtBucketKey(new Date(), 'day');

async function mount() {
  get.mockResolvedValue({ data: { bucket: 'day', buckets: [{ time: today, total: 5, by_type: { 'item.closed': 5 } }] } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(<QueryClientProvider client={qc}><TimelineBar range="7d" /></QueryClientProvider>);
  await waitFor(() => expect(r.container.querySelector('svg[role="img"]')).not.toBeNull());
  return r;
}
const svgOf = (c: HTMLElement) => c.querySelector('svg[role="img"]') as SVGSVGElement;
/** The drawn bars (the coloured segments), not hit targets or placeholders. */
const bars = (c: HTMLElement) => Array.from(c.querySelectorAll('svg[role="img"] rect'))
  .filter(r => { const f = r.getAttribute('fill'); return !!f && f !== 'transparent'; });

describe('the timeline draws in the box\'s own pixels', () => {
  it('uses the measured width as its viewBox and never stretches to fit', async () => {
    const { container } = await mount();
    resize(500);
    const svg = svgOf(container);
    expect(svg.getAttribute('viewBox')).toBe('0 0 500 220');
    // Anything but "none" keeps one unit one pixel in both directions.
    expect(svg.getAttribute('preserveAspectRatio')).not.toBe('none');
  });

  it('redraws at the new width when the box is resized', async () => {
    const { container } = await mount();
    resize(500);
    resize(360);
    expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 360 220');
  });

  it('lays every bar out inside the measured width', async () => {
    const { container } = await mount();
    resize(360);
    const drawn = bars(container);
    expect(drawn.length).toBeGreaterThan(0);
    for (const r of drawn) {
      expect(Number(r.getAttribute('x')) + Number(r.getAttribute('width'))).toBeLessThanOrEqual(360);
    }
  });

  it('keeps its old width where the box cannot be measured', async () => {
    (globalThis as any).ResizeObserver = undefined;
    const { container } = await mount();
    expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 920 220');
  });

  it('places the tooltip over the hovered bar at the measured width', async () => {
    const { container } = await mount();
    resize(500);
    const bar = bars(container)[0];
    fireEvent.mouseEnter(bar.closest('g')!);
    const tip = await waitFor(() => {
      const el = container.querySelector('.pointer-events-none.absolute') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    const centre = Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
    // In pixels from the wrapper's padding edge: its 12px padding plus the
    // bar's own x. A percentage resolves against the padding box, which put
    // the tooltip up to 12px off at either end (epic review 115b658d).
    expect(tip.style.left).toBe(`${12 + centre}px`);
  });

  it('keeps the last width while its box is hidden and reports nothing', async () => {
    const { container } = await mount();
    resize(500);
    resize(0);
    expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 500 220');
  });

  it('fits every hour of a week in a phone-wide box', async () => {
    const { container, getByRole } = await mount();
    resize(300);
    fireEvent.click(getByRole('button', { name: 'hour' }));
    await waitFor(() => expect(container.querySelectorAll('svg[role="img"] rect[fill="transparent"]').length).toBeGreaterThan(100));
    for (const r of Array.from(container.querySelectorAll('svg[role="img"] rect'))) {
      expect(Number(r.getAttribute('x')) + Number(r.getAttribute('width'))).toBeLessThanOrEqual(300);
    }
  });

  it('spaces the x labels so they cannot overlap in a narrow box', async () => {
    get.mockResolvedValue({ data: { bucket: 'day', buckets: [] } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={qc}><TimelineBar range="90d" /></QueryClientProvider>);
    await waitFor(() => expect(container.querySelector('svg[role="img"]')).not.toBeNull());
    resize(360);
    const xs = Array.from(container.querySelectorAll('svg[role="img"] text.font-mono')).map(t => Number(t.getAttribute('x')));
    expect(xs.length).toBeGreaterThan(1);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(40);
  });
});
