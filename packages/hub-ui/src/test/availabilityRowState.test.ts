import { describe, it, expect } from 'vitest';
import { availabilityRowState } from '../pages/availabilityRowState';

describe('availabilityRowState', () => {
  it('marks a non-default, non-available flow as available: false with a "make available" action', () => {
    const s = availabilityRowState(false, false);
    expect(s.available).toBe(false);
    expect(s.locked).toBe(false);
    expect(s.nextAvailable).toBe(true);
    expect(s.actionLabel).toBe('Make available');
    expect(s.hint).toMatch(/not available/i);
  });

  it('marks a non-default, available flow as available: true with a "remove" action', () => {
    const s = availabilityRowState(true, false);
    expect(s.available).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.nextAvailable).toBe(false);
    expect(s.actionLabel).toBe('Remove from picker');
    expect(s.hint).toMatch(/available in the org flow picker/i);
  });

  it('locks availability ON when the flow is the org default (default implies available)', () => {
    // The org default is always in the picker: setting the default forces
    // org_available=1 server-side, and selection refuses a non-available flow.
    const s = availabilityRowState(true, true);
    expect(s.available).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.actionLabel).toBeNull();
  });

  it('reports the org default as available/locked even if the stored flag is momentarily false', () => {
    // Defensive: the default is available regardless of the raw column value.
    const s = availabilityRowState(false, true);
    expect(s.available).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.actionLabel).toBeNull();
  });
});
