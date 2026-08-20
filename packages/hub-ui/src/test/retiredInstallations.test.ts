import { describe, it, expect } from 'vitest';
import {
  canRetireRow,
  canUnretireRow,
  visibleByRetirement,
  countRetired,
  retireConfirmMessage,
  type RetirableRowLike,
} from '../pages/retiredInstallations';

const rows: RetirableRowLike[] = [
  { id: 'inst-live', retired: false },
  { id: 'inst-dead', retired: true },
  { id: 'inst-unknown' }, // absent flag — older API response
];

describe('canRetireRow', () => {
  it('allows retiring a live installation', () => {
    expect(canRetireRow({ id: 'a', retired: false })).toBe(true);
  });

  it('treats a missing flag as live, so older API responses stay actionable', () => {
    expect(canRetireRow({ id: 'a' })).toBe(true);
  });

  it('refuses an already-retired installation', () => {
    expect(canRetireRow({ id: 'a', retired: true })).toBe(false);
  });
});

describe('canUnretireRow', () => {
  it('is the exact complement of canRetireRow', () => {
    for (const row of rows) {
      expect(canUnretireRow(row)).toBe(!canRetireRow(row));
    }
  });
});

describe('visibleByRetirement', () => {
  it('excludes retired rows when the toggle is off', () => {
    expect(visibleByRetirement(rows, false).map(r => r.id)).toEqual(['inst-live', 'inst-unknown']);
  });

  it('keeps every row when the toggle is on', () => {
    expect(visibleByRetirement(rows, true).map(r => r.id)).toEqual(['inst-live', 'inst-dead', 'inst-unknown']);
  });

  it('does not mutate the input array', () => {
    const input = [...rows];
    visibleByRetirement(input, false);
    expect(input).toHaveLength(3);
  });
});

describe('countRetired', () => {
  it('counts only retired rows', () => {
    expect(countRetired(rows)).toBe(1);
  });

  it('is zero for an empty list', () => {
    expect(countRetired([])).toBe(0);
  });
});

describe('retireConfirmMessage', () => {
  it('names the installation being retired', () => {
    expect(retireConfirmMessage('inst-abc')).toContain('inst-abc');
  });

  it('warns that API keys are revoked permanently', () => {
    const msg = retireConfirmMessage('inst-abc').toLowerCase();
    expect(msg).toContain('key');
    expect(msg).toMatch(/revoke/);
  });

  it('states that historical data is kept, so an admin is not scared off', () => {
    // Retiring is safe precisely because events are attributed by user_key,
    // not installation_id — the confirm text has to say so or nobody will use it.
    expect(retireConfirmMessage('inst-abc').toLowerCase()).toMatch(/histor|event/);
  });

  it('states that it is reversible', () => {
    expect(retireConfirmMessage('inst-abc').toLowerCase()).toContain('reversible');
  });
});
