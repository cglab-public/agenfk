/**
 * @vitest-environment jsdom
 *
 * Story da96916f: the PR volume chart had no y-axis or gridlines, its exact
 * values lived only in title= tooltips (slow, unstyled, out of reach of a
 * keyboard or a finger), its x labels were 9px, and its Total repeated the
 * Total PRs tile. Now: a nice-tick y-axis with gridlines; one styled tooltip
 * on hover, tap or focus; the chart is one tab stop whose arrow keys walk the
 * bars, each bar a named option; and the stats name the busiest weekday and
 * the share of large PRs instead of the total.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { PrVolumeChart } from '../components/PrVolumeChart';
import { buildVolumeSeries, type DayPoint, type SizeDist } from '../prVolumeGranularity';

afterEach(cleanup);

const none = { xs: [], s: [], m: [], l: [], xl: [] };
function day(d: string, sizes: Partial<SizeDist>, devBySize: Partial<DayPoint['devBySize']> = {}): DayPoint {
  const full: SizeDist = { xs: 0, s: 0, m: 0, l: 0, xl: 0, ...sizes };
  return { day: d, sizes: full, total: Object.values(full).reduce((a, b) => a + b, 0), devBySize: { ...none, ...devBySize } };
}
// Tue 09-01: 2 S by alice. Wed 09-02: 3 XL (2 bob, 1 alice). Thu 09-03: none.
// Fri 09-04: 1 M + 1 L by carol.
const AXIS = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
const DAYS = [
  day('2026-09-01', { s: 2 }, { s: [{ user_key: 'alice@acme.com', count: 2 }] }),
  day('2026-09-02', { xl: 3 }, { xl: [{ user_key: 'bob@acme.com', count: 2 }, { user_key: 'alice@acme.com', count: 1 }] }),
  day('2026-09-04', { m: 1, l: 1 }, { m: [{ user_key: 'carol@acme.com', count: 1 }], l: [{ user_key: 'carol@acme.com', count: 1 }] }),
];
const mount = () => render(<PrVolumeChart series={buildVolumeSeries(DAYS, AXIS, 'daily', null)} unit="day" />);
const chart = () => screen.getByRole('listbox', { name: /PR volume by size/i });
const tooltip = () => screen.queryByTestId('volume-tooltip');

describe('the y-axis', () => {
  it('labels nice ticks from 0 to at least the busiest bar, each with a gridline', () => {
    const { container } = mount();
    const ticks = Array.from(container.querySelectorAll('[data-y-tick]')).map(t => t.textContent);
    // Busiest bar is 3: ticks 0, 1, 2, 3.
    expect(ticks).toEqual(['0', '1', '2', '3']);
    expect(container.querySelectorAll('[data-gridline]')).toHaveLength(4);
  });

  it('scales bars against the axis top, so their heights read off it', () => {
    render(<PrVolumeChart series={buildVolumeSeries([day('2026-09-01', { s: 7 })], ['2026-09-01'], 'daily', null)} unit="day" />);
    // 7 rounds the axis up to 8: the bar reaches 87.5%, not the top.
    const seg = screen.getByRole('option').querySelector('[data-segment]') as HTMLElement;
    expect(seg.style.height).toBe('87.5%');
  });
});

describe('values without title tooltips', () => {
  it('leaves nothing in title attributes', () => {
    mount();
    // The plot and its x labels (the stat tiles below keep their own titles
    // for truncated values).
    const plot = chart().parentElement!.parentElement!;
    expect(plot.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('names every bar for a screen reader', () => {
    mount();
    const names = screen.getAllByRole('option').map(o => o.getAttribute('aria-label'));
    expect(names).toEqual([
      '2026-09-01: 2 PRs — 2 S',
      '2026-09-02: 3 PRs — 3 XL',
      '2026-09-03: no PRs',
      '2026-09-04: 2 PRs — 1 M, 1 L',
    ]);
  });

  it('shows a styled tooltip on hover with the sizes and who opened them', () => {
    mount();
    fireEvent.mouseEnter(screen.getAllByRole('option')[1]);
    const tip = tooltip()!;
    expect(tip).toHaveTextContent('2026-09-02');
    expect(tip).toHaveTextContent('3 PRs');
    expect(tip).toHaveTextContent(/XL\s*3/);
    expect(tip).toHaveTextContent(/bob@acme\.com\s*2/);
    expect(tip).toHaveTextContent(/alice@acme\.com\s*1/);
    fireEvent.mouseLeave(chart());
    expect(tooltip()).toBeNull();
  });

  it('shows it on a tap too', () => {
    mount();
    fireEvent.click(screen.getAllByRole('option')[3]);
    expect(tooltip()).toHaveTextContent('2026-09-04');
  });
});

describe('the keyboard', () => {
  it('is one tab stop, not one per bar', () => {
    const { container } = mount();
    const stops = Array.from(container.querySelectorAll<HTMLElement>('[tabindex]')).filter(el => el.tabIndex >= 0);
    expect(stops).toEqual([chart()]);
  });

  it('opens on the latest bar and walks the bars with the arrow keys, Home and End', () => {
    mount();
    const lb = chart();
    fireEvent.focus(lb);
    const active = () => document.getElementById(lb.getAttribute('aria-activedescendant')!)!;
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-04/));
    expect(tooltip()).toHaveTextContent('2026-09-04');
    fireEvent.keyDown(lb, { key: 'ArrowLeft' });
    expect(active()).toHaveAttribute('aria-selected', 'true');
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-03/));
    fireEvent.keyDown(lb, { key: 'Home' });
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-01/));
    fireEvent.keyDown(lb, { key: 'ArrowLeft' });
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-01/));
    fireEvent.keyDown(lb, { key: 'End' });
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-04/));
    fireEvent.keyDown(lb, { key: 'ArrowRight' });
    expect(active()).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-04/));
  });

  it('closes the tooltip on Escape and when focus leaves', () => {
    mount();
    const lb = chart();
    fireEvent.focus(lb);
    fireEvent.keyDown(lb, { key: 'Escape' });
    expect(tooltip()).toBeNull();
    fireEvent.keyDown(lb, { key: 'ArrowLeft' });
    expect(tooltip()).not.toBeNull();
    fireEvent.blur(lb);
    expect(tooltip()).toBeNull();
  });
});

describe('the x labels', () => {
  it('are no smaller than the rest of the chart text', () => {
    const { container } = mount();
    const labels = Array.from(container.querySelectorAll('[data-x-label]'));
    expect(labels.map(l => l.textContent)).toEqual(['09-01', '09-02', '09-03', '09-04']);
    for (const l of labels) expect(l.className).toMatch(/\btext-\[11px\]/);
  });
});

describe('the stats under the chart', () => {
  it('name the busiest weekday and the share of large PRs, and drop the repeated total', () => {
    mount();
    const stats = screen.getByTestId('volume-stats');
    expect(within(stats).getByText('Busiest weekday').closest('[data-stat-tile]')).toHaveTextContent(/Wed/);
    expect(within(stats).getByText('Busiest weekday').closest('[data-stat-tile]')).toHaveTextContent(/43% of PRs/);
    // 1 L + 3 XL of 7.
    expect(within(stats).getByText('L / XL share').closest('[data-stat-tile]')).toHaveTextContent(/57%/);
    expect(within(stats).getByText('Average / day')).toBeInTheDocument();
    expect(within(stats).getByText(/^Max/)).toBeInTheDocument();
    expect(within(stats).queryByText('Total')).toBeNull();
  });

  it('show a dash for both when there are no PRs', () => {
    render(<PrVolumeChart series={buildVolumeSeries([], AXIS, 'daily', null)} unit="day" />);
    const stats = screen.getByTestId('volume-stats');
    expect(within(stats).getByText('Busiest weekday').closest('[data-stat-tile]')).toHaveTextContent('—');
    expect(within(stats).getByText('L / XL share').closest('[data-stat-tile]')).toHaveTextContent('—');
  });
});

// Epic review 115b658d.
describe('the tooltip is not clipped by the chart\'s scroll box', () => {
  it('renders outside the scrolling area, at the page root', () => {
    mount();
    fireEvent.mouseEnter(screen.getAllByRole('option')[1]);
    const tip = tooltip()!;
    const scroller = chart().closest('.overflow-x-auto')!;
    expect(scroller.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
  });
});

describe('keyboard state', () => {
  it('survives the pointer leaving while the chart has focus', () => {
    mount();
    const lb = chart();
    fireEvent.focus(lb);
    fireEvent.keyDown(lb, { key: 'Home' });
    fireEvent.mouseLeave(lb);
    expect(document.getElementById(lb.getAttribute('aria-activedescendant')!)).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-01/));
    expect(tooltip()).not.toBeNull();
  });

  it('points at a bar that exists when the series shrinks under it', () => {
    const { rerender } = mount();
    const lb = chart();
    fireEvent.focus(lb);
    fireEvent.keyDown(lb, { key: 'End' });
    rerender(<PrVolumeChart series={buildVolumeSeries(DAYS, AXIS.slice(0, 2), 'daily', null)} unit="day" />);
    const ref = chart().getAttribute('aria-activedescendant');
    if (ref) expect(document.getElementById(ref)).not.toBeNull();
    fireEvent.keyDown(chart(), { key: 'ArrowLeft' });
    expect(document.getElementById(chart().getAttribute('aria-activedescendant')!)).toHaveAttribute('aria-label', expect.stringMatching(/^2026-09-0[12]/));
  });

  it('leaves modified arrows to the browser (Alt+Left is Back)', () => {
    mount();
    const lb = chart();
    fireEvent.focus(lb);
    const before = lb.getAttribute('aria-activedescendant');
    expect(fireEvent.keyDown(lb, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(lb.getAttribute('aria-activedescendant')).toBe(before);
  });

  it('does not swallow Escape when no tooltip is open', () => {
    mount();
    const lb = chart();
    fireEvent.focus(lb);
    expect(fireEvent.keyDown(lb, { key: 'Escape' })).toBe(false);
    expect(fireEvent.keyDown(lb, { key: 'Escape' })).toBe(true);
  });
});

// Epic review round 2 (8706f29a).
describe('after the second review', () => {
  it('says "1 PR per", not "1 PRs per"', () => {
    render(<PrVolumeChart series={buildVolumeSeries([day('2026-09-01', { s: 1 })], AXIS, 'daily', null)} unit="day" />);
    expect(screen.getByTestId('volume-stats')).toHaveTextContent('1 PR per Tue');
  });

  it('keeps the tooltip on screen beside a bar at the viewport\'s right edge', () => {
    mount();
    const bar = screen.getAllByRole('option')[0];
    const near = (left: number) => ({ left, top: 100, width: 10, height: 100, right: left + 10, bottom: 200, x: left, y: 100, toJSON: () => ({}) }) as DOMRect;
    bar.getBoundingClientRect = () => near(window.innerWidth - 20);
    fireEvent.mouseEnter(bar);
    expect(tooltip()!.style.transform).toBe('translateX(-100%)');
  });

  it('lets the tooltip go when the pointer leaves after a click, even after using the keys', () => {
    mount();
    // Keyboard first, so the chart has been in keyboard mode…
    fireEvent.focus(chart());
    fireEvent.keyDown(chart(), { key: 'ArrowLeft' });
    // …then a click on a bar.
    const bar = screen.getAllByRole('option')[2];
    fireEvent.pointerDown(bar);
    fireEvent.click(bar);
    expect(tooltip()).not.toBeNull();
    fireEvent.mouseLeave(chart());
    expect(tooltip()).toBeNull();
  });

  it('scrolls a bar the keyboard moves to into view', () => {
    const calls: Array<{ el: Element; opts: unknown }> = [];
    const original = (Element.prototype as any).scrollIntoView;
    (Element.prototype as any).scrollIntoView = function (opts: unknown) { calls.push({ el: this, opts }); };
    try {
      mount();
      fireEvent.focus(chart());
      fireEvent.keyDown(chart(), { key: 'Home' });
      const first = screen.getAllByRole('option')[0];
      expect(calls.some(c => c.el === first)).toBe(true);
      expect(calls.at(-1)?.opts).toEqual({ block: 'nearest', inline: 'nearest' });
    } finally {
      (Element.prototype as any).scrollIntoView = original;
    }
  });
});

// Epic review round 3 (471d88f4).
describe('focus from Tab', () => {
  it('counts as keyboard focus, so a pointer crossing the chart keeps the place', () => {
    mount();
    // Tab's keydown lands on the element before the chart, not on it.
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.focus(chart());
    expect(tooltip()).not.toBeNull();
    fireEvent.mouseLeave(chart());
    expect(tooltip()).not.toBeNull();
  });
});
