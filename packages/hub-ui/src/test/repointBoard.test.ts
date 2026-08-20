import { describe, it, expect } from 'vitest';
import {
  classifyTarget,
  isStale,
  sortTargets,
  drainSummary,
  canDropOldName,
  type RepointTargetLike,
} from '../pages/repointBoard';

const CAMPAIGN_OPENED = '2026-08-10T00:00:00Z';

const t = (over: Partial<RepointTargetLike> = {}): RepointTargetLike => ({
  installationId: 'inst-1',
  state: 'pending',
  lastSeen: '2026-08-12T00:00:00Z',
  gitEmail: 'dev@acme.com',
  gitName: null,
  osUser: 'dev',
  errorMessage: null,
  reportedUrl: null,
  ...over,
});

describe('isStale', () => {
  it('flags an installation that has not checked in since the campaign opened', () => {
    // It cannot have seen the directive, so it will never move on its own.
    expect(isStale(t({ lastSeen: '2026-08-01T00:00:00Z' }), CAMPAIGN_OPENED)).toBe(true);
  });

  it('does not flag one that checked in after the campaign opened', () => {
    expect(isStale(t({ lastSeen: '2026-08-12T00:00:00Z' }), CAMPAIGN_OPENED)).toBe(false);
  });

  it('treats a never-seen installation as stale', () => {
    expect(isStale(t({ lastSeen: null }), CAMPAIGN_OPENED)).toBe(true);
  });

  it('is not stale once it has already succeeded, whatever its last-seen says', () => {
    // A confirmed move is proof of contact; the timestamp is irrelevant.
    expect(isStale(t({ state: 'succeeded', lastSeen: '2026-08-01T00:00:00Z' }), CAMPAIGN_OPENED)).toBe(false);
  });

  it('tolerates an unparseable timestamp by treating it as stale', () => {
    expect(isStale(t({ lastSeen: 'not-a-date' }), CAMPAIGN_OPENED)).toBe(true);
  });
});

describe('classifyTarget', () => {
  it('calls a succeeded target done', () => {
    expect(classifyTarget(t({ state: 'succeeded' }), CAMPAIGN_OPENED)).toBe('done');
  });

  it('calls a blocked target blocked, since it needs a human to change an env var', () => {
    expect(classifyTarget(t({ state: 'blocked_by_env' }), CAMPAIGN_OPENED)).toBe('blocked');
  });

  it('calls a failed target failed', () => {
    expect(classifyTarget(t({ state: 'failed' }), CAMPAIGN_OPENED)).toBe('failed');
  });

  it('calls a pending target that is still checking in waiting', () => {
    expect(classifyTarget(t({ state: 'pending' }), CAMPAIGN_OPENED)).toBe('waiting');
  });

  it('calls a pending target that stopped checking in stale', () => {
    expect(classifyTarget(t({ state: 'pending', lastSeen: null }), CAMPAIGN_OPENED)).toBe('stale');
  });
});

describe('sortTargets', () => {
  it('puts the rows needing action first and finished ones last', () => {
    const rows = [
      t({ installationId: 'done', state: 'succeeded' }),
      t({ installationId: 'waiting', state: 'pending' }),
      t({ installationId: 'stale', state: 'pending', lastSeen: null }),
      t({ installationId: 'blocked', state: 'blocked_by_env' }),
      t({ installationId: 'failed', state: 'failed' }),
    ];

    expect(sortTargets(rows, CAMPAIGN_OPENED).map(r => r.installationId))
      .toEqual(['stale', 'failed', 'blocked', 'waiting', 'done']);
  });

  it('does not mutate the input', () => {
    const rows = [t({ installationId: 'a', state: 'succeeded' }), t({ installationId: 'b' })];
    sortTargets(rows, CAMPAIGN_OPENED);
    expect(rows.map(r => r.installationId)).toEqual(['a', 'b']);
  });
});

describe('drainSummary', () => {
  it('counts each class', () => {
    const rows = [
      t({ installationId: '1', state: 'succeeded' }),
      t({ installationId: '2', state: 'succeeded' }),
      t({ installationId: '3', state: 'pending' }),
      t({ installationId: '4', state: 'pending', lastSeen: null }),
      t({ installationId: '5', state: 'blocked_by_env' }),
    ];

    expect(drainSummary(rows, CAMPAIGN_OPENED)).toEqual({
      total: 5, done: 2, waiting: 1, stale: 1, blocked: 1, failed: 0,
    });
  });

  it('is all zeroes for an empty fleet', () => {
    expect(drainSummary([], CAMPAIGN_OPENED)).toEqual({
      total: 0, done: 0, waiting: 0, stale: 0, blocked: 0, failed: 0,
    });
  });
});

describe('canDropOldName', () => {
  it('is true only when every target has confirmed on the new name', () => {
    const rows = [t({ installationId: '1', state: 'succeeded' }), t({ installationId: '2', state: 'succeeded' })];
    expect(canDropOldName(rows, CAMPAIGN_OPENED)).toBe(true);
  });

  it('is false while anything is still waiting', () => {
    expect(canDropOldName([t({ state: 'succeeded' }), t({ installationId: '2' })], CAMPAIGN_OPENED)).toBe(false);
  });

  it('is false while anything is stale — retire it to finish the campaign', () => {
    const rows = [t({ state: 'succeeded' }), t({ installationId: '2', lastSeen: null })];
    expect(canDropOldName(rows, CAMPAIGN_OPENED)).toBe(false);
  });

  it('is false while anything is blocked by an env var', () => {
    const rows = [t({ state: 'succeeded' }), t({ installationId: '2', state: 'blocked_by_env' })];
    expect(canDropOldName(rows, CAMPAIGN_OPENED)).toBe(false);
  });

  it('is false for an empty fleet, since nothing has proved anything', () => {
    // Dropping a DNS name because no installation exists yet is not a safe
    // conclusion — it is an absence of evidence.
    expect(canDropOldName([], CAMPAIGN_OPENED)).toBe(false);
  });
});
