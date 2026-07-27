import { describe, it, expect } from 'vitest';
import {
  hideTargetKey,
  visibleInstallationRows,
  partitionHiddenRows,
  canHideRow,
  type InstallationRowLike,
} from '../pages/hiddenPeople';

const rows: InstallationRowLike[] = [
  { id: 'inst-1', gitEmail: 'active@acme.com', hidden: false },
  { id: 'inst-2', gitEmail: 'departed@acme.com', hidden: true },
  { id: 'inst-3', gitEmail: null, hidden: false },
];

describe('hideTargetKey', () => {
  it('returns the lowercased trimmed git email', () => {
    expect(hideTargetKey({ gitEmail: '  Departed@Acme.COM ' })).toBe('departed@acme.com');
  });

  it('returns null when the row has no git email (cannot attribute to a person)', () => {
    expect(hideTargetKey({ gitEmail: null })).toBeNull();
    expect(hideTargetKey({ gitEmail: '' })).toBeNull();
    expect(hideTargetKey({ gitEmail: '   ' })).toBeNull();
  });
});

describe('visibleInstallationRows', () => {
  it('excludes hidden rows when showHidden is false', () => {
    expect(visibleInstallationRows(rows, false).map(r => r.id)).toEqual(['inst-1', 'inst-3']);
  });

  it('returns all rows when showHidden is true', () => {
    expect(visibleInstallationRows(rows, true).map(r => r.id)).toEqual(['inst-1', 'inst-2', 'inst-3']);
  });

  it('treats a missing hidden flag as visible', () => {
    expect(visibleInstallationRows([{ id: 'x', gitEmail: 'a@b' }], false)).toHaveLength(1);
  });
});

describe('partitionHiddenRows', () => {
  it('splits rows into visible and hidden buckets', () => {
    const { visible, hidden } = partitionHiddenRows(rows);
    expect(visible.map(r => r.id)).toEqual(['inst-1', 'inst-3']);
    expect(hidden.map(r => r.id)).toEqual(['inst-2']);
  });

  it('handles an empty list', () => {
    expect(partitionHiddenRows([])).toEqual({ visible: [], hidden: [] });
  });
});

describe('canHideRow', () => {
  it('allows hiding a visible row with a git email', () => {
    expect(canHideRow({ id: 'inst-1', gitEmail: 'active@acme.com', hidden: false })).toBe(true);
  });

  it('disallows hiding an already-hidden row', () => {
    expect(canHideRow({ id: 'inst-2', gitEmail: 'departed@acme.com', hidden: true })).toBe(false);
  });

  it('disallows hiding a row with no git email', () => {
    expect(canHideRow({ id: 'inst-3', gitEmail: null, hidden: false })).toBe(false);
  });
});
