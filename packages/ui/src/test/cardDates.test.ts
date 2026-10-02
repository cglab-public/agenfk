import { describe, it, expect } from 'vitest';
import { cardShortDate, cardAgo, cardFullTimestamp } from '../cardDates';

const NOW = new Date('2026-09-30T16:00:00Z');

describe('cardShortDate', () => {
  it('is day and month in the viewer\'s locale, without the year this year', () => {
    // en-GB abbreviates September as "Sept" in current ICU data.
    expect(cardShortDate('2026-09-12T14:03:00Z', NOW, 'en-GB')).toMatch(/^12 Sept?$/);
    expect(cardShortDate('2026-09-12T14:03:00Z', NOW, 'en-US')).toBe('Sep 12');
  });

  it('carries the year once it is not this year', () => {
    expect(cardShortDate('2025-09-12T14:03:00Z', NOW, 'en-GB')).toMatch(/^12 Sept? 2025$/);
  });

  it('is empty for a missing or invalid date', () => {
    expect(cardShortDate(undefined, NOW, 'en-GB')).toBe('');
    expect(cardShortDate('not a date', NOW, 'en-GB')).toBe('');
  });
});

describe('cardAgo', () => {
  it('says "just now" under a minute', () => {
    expect(cardAgo('2026-09-30T15:59:30Z', NOW, 'en-GB')).toBe('just now');
  });

  it('counts minutes, hours and days', () => {
    expect(cardAgo('2026-09-30T15:55:00Z', NOW, 'en-GB')).toBe('5m ago');
    expect(cardAgo('2026-09-30T14:00:00Z', NOW, 'en-GB')).toBe('2h ago');
    expect(cardAgo('2026-09-27T16:00:00Z', NOW, 'en-GB')).toBe('3d ago');
  });

  it('falls back to the short date after 30 days', () => {
    expect(cardAgo('2026-08-01T12:00:00Z', NOW, 'en-GB')).toBe('1 Aug');
  });

  it('treats a clock-skewed future timestamp as just now', () => {
    expect(cardAgo('2026-09-30T16:05:00Z', NOW, 'en-GB')).toBe('just now');
  });

  it('is empty for a missing or invalid date', () => {
    expect(cardAgo(undefined, NOW, 'en-GB')).toBe('');
  });
});

describe('cardFullTimestamp', () => {
  it('is the full local date and time', () => {
    const iso = '2026-09-12T14:03:00Z';
    expect(cardFullTimestamp(iso, 'en-GB')).toBe(new Date(iso).toLocaleString('en-GB'));
  });

  it('is empty for a missing or invalid date', () => {
    expect(cardFullTimestamp('nope', 'en-GB')).toBe('');
  });
});
