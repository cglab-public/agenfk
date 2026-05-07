/**
 * Pure helper for the searchable installation picker on Admin → Upgrades.
 * Filters the option list by case-insensitive partial match against the
 * label (which already includes user name / git name / git email).
 */
import { describe, it, expect } from 'vitest';
import { filterInstallationOptions, type InstallationOption } from '../pages/filterInstallationOptions';

const opts: InstallationOption[] = [
  { id: 'i1', label: 'mac-1 — Nathan / nathan.silva@cglab.com' },
  { id: 'i2', label: 'mac-2 — Daniel / danielp@cglab.com' },
  { id: 'i3', label: 'i3-fallback' },
  { id: 'i4', label: 'mac-4 — Ana / ana@cglab.com' },
];

describe('filterInstallationOptions', () => {
  it('returns the full list when the query is empty / whitespace', () => {
    expect(filterInstallationOptions(opts, '')).toEqual(opts);
    expect(filterInstallationOptions(opts, '   ')).toEqual(opts);
  });

  it('filters by case-insensitive substring match on the label', () => {
    expect(filterInstallationOptions(opts, 'NATHAN').map(o => o.id)).toEqual(['i1']);
    expect(filterInstallationOptions(opts, 'daniel').map(o => o.id)).toEqual(['i2']);
    // Substring across the email part works too.
    expect(filterInstallationOptions(opts, 'cglab.com').map(o => o.id)).toEqual(['i1', 'i2', 'i4']);
  });

  it('matches partials, not just word boundaries', () => {
    expect(filterInstallationOptions(opts, 'an').map(o => o.id)).toEqual(['i1', 'i2', 'i4']);
  });

  it('falls back to id substring when the label is bare', () => {
    expect(filterInstallationOptions(opts, 'fallback').map(o => o.id)).toEqual(['i3']);
    expect(filterInstallationOptions(opts, 'i3').map(o => o.id)).toEqual(['i3']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterInstallationOptions(opts, 'zzz')).toEqual([]);
  });

  it('preserves the original order (no reranking)', () => {
    expect(filterInstallationOptions(opts, 'mac').map(o => o.id)).toEqual(['i1', 'i2', 'i4']);
  });
});
