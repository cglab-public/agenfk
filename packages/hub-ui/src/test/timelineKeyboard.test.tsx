/**
 * @vitest-environment jsdom
 *
 * The activity timeline without a mouse (TASK 6f243bc9, story "No hover-only
 * information"). Each bar's date, total and per-type counts lived only in a
 * hover tooltip: no tab stop, no tap, no text alternative. It now follows the
 * PR-volume chart: one tab stop (a listbox), a named option per bar, the arrow
 * keys, Home and End to move, and a tap to select.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimelineBar } from '../components/TimelineBar';
import { fmtBucketKey } from '../components/timelineAxis';
import { eventTypeLabel } from '../eventTypes';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const today = fmtBucketKey(new Date(), 'day');
beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: { bucket: 'day', buckets: [{ time: today, total: 3, by_type: { 'item.closed': 2, 'validate.passed': 1 } }] } });
});
afterEach(cleanup);

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><TimelineBar range="7d" /></QueryClientProvider>);
  const chart = await screen.findByRole('listbox', { name: /event timeline/i });
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));
  return chart;
}
const active = (chart: HTMLElement) => {
  const id = chart.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('the activity timeline', () => {
  it('is one tab stop, named for what it shows', async () => {
    const chart = await mount();
    expect(chart).toHaveAttribute('tabindex', '0');
  });

  it('names each bar with its date, total and counts per type', async () => {
    await mount();
    const options = screen.getAllByRole('option');
    const busy = `${today}: 3 events — ${eventTypeLabel('item.closed')} 2, ${eventTypeLabel('validate.passed')} 1`;
    expect(options.at(-1)).toHaveAccessibleName(busy);
    expect(options[0].getAttribute('aria-label')).toMatch(/: no events$/);
  });

  it('walks the bars with the arrow keys, Home and End, and lets go on Escape', async () => {
    const chart = await mount();
    const options = screen.getAllByRole('option');
    fireEvent.focus(chart);
    expect(active(chart)).toBe(options.at(-1));
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(active(chart)).toBe(options.at(-2));
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(active(chart)).toBe(options[0]);
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(active(chart)).toBe(options[0]);
    fireEvent.keyDown(chart, { key: 'End' });
    expect(active(chart)).toBe(options.at(-1));
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(active(chart)).toBe(options.at(-1));

    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(active(chart)).toBeNull();
  });

  it('selects a bar on a tap, showing its breakdown', async () => {
    const chart = await mount();
    const last = screen.getAllByRole('option').at(-1)!;
    fireEvent.click(last);
    expect(active(chart)).toBe(last);
    expect(screen.getByTestId('timeline-tooltip')).toHaveTextContent('3');
  });

  it('keeps the tooltip out of the accessibility tree: the option names carry it', async () => {
    await mount();
    fireEvent.click(screen.getAllByRole('option').at(-1)!);
    expect(screen.getByTestId('timeline-tooltip')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the axes and the EVENTS title out of the list, as decoration', async () => {
    await mount();
    expect(screen.getByText('EVENTS').closest('[aria-hidden="true"]')).not.toBeNull();
    const tick = document.querySelector('svg[role="listbox"] line')!;
    expect(tick.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('keeps a bar chosen by tap when the chart then takes focus', async () => {
    const chart = await mount();
    const options = screen.getAllByRole('option');
    fireEvent.click(options[1]);
    fireEvent.focus(chart);
    expect(active(chart)).toBe(options[1]);
  });

  it('leaves Escape alone when no bar is chosen, and modified arrows to the browser', async () => {
    const chart = await mount();
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(chart, { key: 'Escape' })).toBe(true);
    fireEvent.focus(chart);
    const before = active(chart);
    expect(fireEvent.keyDown(chart, { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(active(chart)).toBe(before);
  });

  it('keeps the keyboard\'s place when the pointer drifts off that bar', async () => {
    const chart = await mount();
    chart.focus();
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    const place = active(chart)!;
    expect(place).not.toBeNull();
    fireEvent.mouseLeave(place);
    expect(active(chart)).toBe(place);
  });

  it('lets go of a bar that a shorter range no longer has', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<QueryClientProvider client={qc}><TimelineBar range="30d" /></QueryClientProvider>);
    const chart = await screen.findByRole('listbox', { name: /event timeline/i });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(20));
    fireEvent.click(screen.getAllByRole('option')[20]);
    rerender(<QueryClientProvider client={qc}><TimelineBar range="7d" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeLessThan(10));
    expect(chart.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('does not pin the tooltip after a mouse click when the pointer leaves', async () => {
    // A click focuses the chart too; only a keyboard place survives the pointer.
    const chart = await mount();
    const bar = screen.getAllByRole('option').at(-2)!;
    fireEvent.pointerDown(bar);
    fireEvent.click(bar);
    chart.focus();
    fireEvent.focus(chart);
    fireEvent.mouseLeave(bar);
    expect(active(chart)).toBeNull();
  });

  it('drops the selection when focus leaves', async () => {
    const chart = await mount();
    fireEvent.focus(chart);
    fireEvent.blur(chart);
    expect(active(chart)).toBeNull();
  });
});
