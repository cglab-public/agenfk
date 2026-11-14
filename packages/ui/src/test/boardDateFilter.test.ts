/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_DATE_FILTER,
  isDateFilterActive,
  matchesDateFilter,
  describeDateFilter,
  emptyColumnMessage,
  dateFilterStorageKey,
  loadDateFilter,
  saveDateFilter,
  type DateFilter,
} from '../boardDateFilter';

// Every timestamp is built from LOCAL calendar parts, so the boundaries under
// test are local-day boundaries whatever timezone the suite runs in.
const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms).toISOString();

const NOW = new Date(2026, 2, 15, 12, 0, 0); // 15 Mar 2026, noon local

const card = (createdAt: string, updatedAt: string) => ({ createdAt, updatedAt });

const updated = (range: DateFilter['range']): DateFilter => ({ field: 'updatedAt', range });
const created = (range: DateFilter['range']): DateFilter => ({ field: 'createdAt', range });

describe('matchesDateFilter', () => {
  it('Any time matches every card, including one with an unparseable date', () => {
    expect(matchesDateFilter(card('garbage', 'garbage'), DEFAULT_DATE_FILTER, NOW)).toBe(true);
    expect(matchesDateFilter(card(local(2001, 1, 1), local(2001, 1, 1)), DEFAULT_DATE_FILTER, NOW)).toBe(true);
  });

  it('reads only the chosen field', () => {
    // Created long ago, touched today.
    const c = card(local(2025, 1, 1), local(2026, 3, 15, 9));
    expect(matchesDateFilter(c, updated({ kind: 'today' }), NOW)).toBe(true);
    expect(matchesDateFilter(c, created({ kind: 'today' }), NOW)).toBe(false);
  });

  it('Today spans the whole local day, both ends included', () => {
    const f = updated({ kind: 'today' });
    expect(matchesDateFilter(card('', local(2026, 3, 15, 0, 0, 0, 0)), f, NOW)).toBe(true);
    // Later than "now" but still today: a card updated at 23:59 counts.
    expect(matchesDateFilter(card('', local(2026, 3, 15, 23, 59, 59, 999)), f, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 3, 14, 23, 59, 59, 999)), f, NOW)).toBe(false);
    expect(matchesDateFilter(card('', local(2026, 3, 16, 0, 0, 0, 0)), f, NOW)).toBe(false);
  });

  it('Last 7 days is today plus the six days before it', () => {
    const f = updated({ kind: 'last7' });
    expect(matchesDateFilter(card('', local(2026, 3, 9, 0, 0)), f, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 3, 8, 23, 59, 59, 999)), f, NOW)).toBe(false);
    expect(matchesDateFilter(card('', local(2026, 3, 15, 23, 59)), f, NOW)).toBe(true);
  });

  it('Last 30 days is today plus the 29 days before it', () => {
    const f = updated({ kind: 'last30' });
    expect(matchesDateFilter(card('', local(2026, 2, 14, 0, 0)), f, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 2, 13, 23, 59, 59, 999)), f, NOW)).toBe(false);
  });

  it('Custom range includes both whole end days', () => {
    const f = created({ kind: 'custom', from: '2026-03-01', to: '2026-03-05' });
    expect(matchesDateFilter(card(local(2026, 3, 1, 0, 0), ''), f, NOW)).toBe(true);
    expect(matchesDateFilter(card(local(2026, 3, 5, 23, 59, 59, 999), ''), f, NOW)).toBe(true);
    expect(matchesDateFilter(card(local(2026, 2, 28, 23, 59, 59, 999), ''), f, NOW)).toBe(false);
    expect(matchesDateFilter(card(local(2026, 3, 6, 0, 0), ''), f, NOW)).toBe(false);
  });

  it('Custom range with an open end is unbounded on that side', () => {
    const fromOnly = updated({ kind: 'custom', from: '2026-03-10' });
    expect(matchesDateFilter(card('', local(2030, 1, 1)), fromOnly, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 3, 9, 23, 59)), fromOnly, NOW)).toBe(false);

    const toOnly = updated({ kind: 'custom', to: '2026-03-10' });
    expect(matchesDateFilter(card('', local(1999, 1, 1)), toOnly, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 3, 11, 0, 0)), toOnly, NOW)).toBe(false);
  });

  it('a custom range typed back to front is read the right way round', () => {
    const f = updated({ kind: 'custom', from: '2026-03-05', to: '2026-03-01' });
    expect(matchesDateFilter(card('', local(2026, 3, 3)), f, NOW)).toBe(true);
    expect(matchesDateFilter(card('', local(2026, 3, 6)), f, NOW)).toBe(false);
    expect(describeDateFilter(f)).toBe('Updated · 2026-03-01 → 2026-03-05');
  });

  it('an active filter excludes a card whose date cannot be parsed', () => {
    expect(matchesDateFilter(card('', 'not-a-date'), updated({ kind: 'last30' }), NOW)).toBe(false);
  });
});

describe('isDateFilterActive', () => {
  it('is off for Any time and for a custom range with no ends', () => {
    expect(isDateFilterActive(DEFAULT_DATE_FILTER)).toBe(false);
    expect(isDateFilterActive(updated({ kind: 'custom' }))).toBe(false);
    expect(isDateFilterActive(updated({ kind: 'custom', from: '', to: '' }))).toBe(false);
  });

  it('is on for presets and for a custom range with either end', () => {
    expect(isDateFilterActive(updated({ kind: 'today' }))).toBe(true);
    expect(isDateFilterActive(created({ kind: 'last7' }))).toBe(true);
    expect(isDateFilterActive(created({ kind: 'custom', to: '2026-03-01' }))).toBe(true);
  });
});

describe('labels', () => {
  it('describes the filter for the chip', () => {
    expect(describeDateFilter(updated({ kind: 'last7' }))).toBe('Updated · Last 7 days');
    expect(describeDateFilter(created({ kind: 'today' }))).toBe('Created · Today');
    expect(describeDateFilter(updated({ kind: 'last30' }))).toBe('Updated · Last 30 days');
    expect(describeDateFilter(created({ kind: 'custom', from: '2026-03-01', to: '2026-03-05' }))).toBe('Created · 2026-03-01 → 2026-03-05');
    expect(describeDateFilter(updated({ kind: 'custom', from: '2026-03-01' }))).toBe('Updated · from 2026-03-01');
    expect(describeDateFilter(updated({ kind: 'custom', to: '2026-03-05' }))).toBe('Updated · until 2026-03-05');
  });

  it('words the empty-column state after the filter', () => {
    expect(emptyColumnMessage(updated({ kind: 'last7' }))).toBe('No cards updated in the last 7 days');
    expect(emptyColumnMessage(created({ kind: 'today' }))).toBe('No cards created today');
    expect(emptyColumnMessage(updated({ kind: 'last30' }))).toBe('No cards updated in the last 30 days');
    expect(emptyColumnMessage(created({ kind: 'custom', from: '2026-03-01' }))).toBe('No cards created in this date range');
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a filter per project, under its own key', () => {
    const f = created({ kind: 'custom', from: '2026-03-01', to: '2026-03-05' });
    saveDateFilter('p1', f);
    expect(dateFilterStorageKey('p1')).toBe('agenfk_board_date_filter:p1');
    expect(JSON.parse(localStorage.getItem('agenfk_board_date_filter:p1')!)).toEqual(f);
    expect(loadDateFilter('p1')).toEqual(f);
    expect(loadDateFilter('p2')).toEqual(DEFAULT_DATE_FILTER);
  });

  it('saving an inactive filter forgets the project entry', () => {
    saveDateFilter('p1', updated({ kind: 'today' }));
    saveDateFilter('p1', DEFAULT_DATE_FILTER);
    expect(localStorage.getItem('agenfk_board_date_filter:p1')).toBeNull();
  });

  it.each([
    ['not json', '{oops'],
    ['wrong field', JSON.stringify({ field: 'deletedAt', range: { kind: 'today' } })],
    ['wrong range kind', JSON.stringify({ field: 'updatedAt', range: { kind: 'forever' } })],
    ['malformed custom date', JSON.stringify({ field: 'updatedAt', range: { kind: 'custom', from: '03/01/2026' } })],
    ['not an object', JSON.stringify(42)],
    ['impossible calendar day', JSON.stringify({ field: 'updatedAt', range: { kind: 'custom', from: '2026-02-31' } })],
  ])('falls back to Any time on a corrupt stored value (%s)', (_label, raw) => {
    localStorage.setItem('agenfk_board_date_filter:p1', raw);
    expect(loadDateFilter('p1')).toEqual(DEFAULT_DATE_FILTER);
  });

  it('loads Any time when there is no project', () => {
    expect(loadDateFilter(null)).toEqual(DEFAULT_DATE_FILTER);
  });
});
