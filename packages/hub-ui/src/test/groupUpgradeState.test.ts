import { describe, it, expect } from 'vitest';
import { groupUpgradeRow } from '../pages/groupUpgradeState';

describe('groupUpgradeRow', () => {
  it('keeps "asked to stop" distinct from "stopped"', () => {
    // The whole point. Rendering them the same tells an admin a rollout was
    // halted when the hub may still be working.
    const asked = groupUpgradeRow('cancel-pending', { pending: 3, updated: 0, failed: 0, skipped: 0 });
    const stopped = groupUpgradeRow('cancelled', { pending: 0, updated: 0, failed: 3, skipped: 0 });
    expect(asked.label).not.toBe(stopped.label);
    expect(asked.awaiting).toBe(true);
    expect(asked.settled).toBe(false);
    expect(stopped.awaiting).toBe(false);
    expect(stopped.settled).toBe(true);
  });

  it('marks a hub that has never answered as awaiting, not as having nothing to do', () => {
    const r = groupUpgradeRow('pending', null);
    expect(r.awaiting).toBe(true);
    expect(r.summary).toMatch(/no report/i);
    expect(r.summary).not.toMatch(/0 updated/);
  });

  it('treats a completed hub as settled and not awaiting', () => {
    const r = groupUpgradeRow('completed', { pending: 0, updated: 4, failed: 0, skipped: 1 });
    expect(r.settled).toBe(true);
    expect(r.awaiting).toBe(false);
    expect(r.summary).toContain('4 updated');
    expect(r.summary).toContain('1 skipped');
  });

  it('states zero skips on a finished rollout rather than leaving it out', () => {
    expect(groupUpgradeRow('completed', { pending: 0, updated: 2, failed: 0, skipped: 0 }).summary)
      .toContain('0 skipped');
  });

  it('shows work still to go while running', () => {
    const r = groupUpgradeRow('running', { pending: 2, updated: 1, failed: 0, skipped: 0 });
    expect(r.settled).toBe(false);
    expect(r.summary).toContain('2 to go');
  });

  it('surfaces failures', () => {
    expect(groupUpgradeRow('completed', { pending: 0, updated: 1, failed: 2, skipped: 0 }).summary)
      .toContain('2 failed');
  });

  it('does not invent numbers from a malformed report', () => {
    const r = groupUpgradeRow('running', { updated: 'lots' as any, pending: NaN as any });
    expect(r.summary).toContain('0 updated');
    expect(r.summary).not.toContain('NaN');
  });

  it('falls back to showing an unknown state rather than hiding it', () => {
    expect(groupUpgradeRow('something-new', null).label).toBe('something-new');
  });
});
