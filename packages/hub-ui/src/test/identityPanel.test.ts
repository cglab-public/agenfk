import { describe, it, expect } from 'vitest';
import {
  canMergeInOneClick,
  mergeBlockedReason,
  sortSuggestions,
  suggestionSummary,
  isValidManualMerge,
  type SuggestionLike,
} from '../pages/identityPanel';

const s = (over: Partial<SuggestionLike> = {}): SuggestionLike => ({
  from: 'dev',
  to: 'dev@acme.com',
  events: 10,
  firstSeen: '2026-01-10T00:00:00Z',
  lastSeen: '2026-02-20T00:00:00Z',
  installations: ['inst-1'],
  sourceInstallationCount: 1,
  targetCandidateCount: 1,
  confidence: 'unambiguous',
  blockedByLiveKey: false,
  ...over,
});

describe('canMergeInOneClick', () => {
  it('allows an unambiguous, unblocked suggestion', () => {
    expect(canMergeInOneClick(s())).toBe(true);
  });

  it('refuses a conflated suggestion', () => {
    // A bare-osUser key can be several people; merging it would attribute one
    // person's history to another, and there is no unmerge.
    expect(canMergeInOneClick(s({ confidence: 'conflated', sourceInstallationCount: 2 }))).toBe(false);
  });

  it('refuses while the source still holds a live key', () => {
    expect(canMergeInOneClick(s({ blockedByLiveKey: true }))).toBe(false);
  });
});

describe('mergeBlockedReason', () => {
  it('explains a live key, naming the remedy', () => {
    const reason = mergeBlockedReason(s({ blockedByLiveKey: true })) ?? '';
    expect(reason).toMatch(/live/i);
    expect(reason).toMatch(/retire|revoke/i);
  });

  it('explains conflation in terms of the risk, not the rule', () => {
    const reason = mergeBlockedReason(s({ confidence: 'conflated', sourceInstallationCount: 3 })) ?? '';
    expect(reason).toContain('3');
    expect(reason.toLowerCase()).toMatch(/more than one|several|different people|another/);
  });

  it('reports the live key first when both apply, since it blocks server-side', () => {
    const reason = mergeBlockedReason(s({ confidence: 'conflated', blockedByLiveKey: true })) ?? '';
    expect(reason).toMatch(/live/i);
  });

  it('returns null when nothing blocks', () => {
    expect(mergeBlockedReason(s())).toBeNull();
  });
});

describe('sortSuggestions', () => {
  it('puts actionable suggestions before blocked ones', () => {
    const rows = [
      s({ from: 'blocked', blockedByLiveKey: true, events: 100 }),
      s({ from: 'conflated', confidence: 'conflated', events: 50 }),
      s({ from: 'ready', events: 1 }),
    ];

    expect(sortSuggestions(rows).map(r => r.from)).toEqual(['ready', 'conflated', 'blocked']);
  });

  it('orders by event count within the same actionability', () => {
    const rows = [s({ from: 'small', events: 2 }), s({ from: 'big', events: 99 })];
    expect(sortSuggestions(rows).map(r => r.from)).toEqual(['big', 'small']);
  });

  it('does not mutate the input', () => {
    const rows = [s({ from: 'a', events: 1 }), s({ from: 'b', events: 9 })];
    sortSuggestions(rows);
    expect(rows.map(r => r.from)).toEqual(['a', 'b']);
  });
});

describe('suggestionSummary', () => {
  it('counts what is actionable versus needing attention', () => {
    expect(suggestionSummary([
      s(),
      s({ from: 'x', blockedByLiveKey: true }),
      s({ from: 'y', confidence: 'conflated' }),
      s({ from: 'z', confidence: 'conflated', blockedByLiveKey: true }),
    ])).toEqual({ total: 4, ready: 1, conflated: 2, blocked: 2 });
  });

  it('is all zeroes for an empty list', () => {
    expect(suggestionSummary([])).toEqual({ total: 0, ready: 0, conflated: 0, blocked: 0 });
  });
});

describe('isValidManualMerge', () => {
  it('accepts two different keys', () => {
    expect(isValidManualMerge('old', 'new@acme.com')).toBe(true);
  });

  it('rejects blanks', () => {
    expect(isValidManualMerge('', 'new@acme.com')).toBe(false);
    expect(isValidManualMerge('old', '   ')).toBe(false);
  });

  it('rejects a self-merge, including case and whitespace differences', () => {
    // Mirrors the server, which 400s these — no point letting the form submit.
    expect(isValidManualMerge('dev@acme.com', 'dev@acme.com')).toBe(false);
    expect(isValidManualMerge('  Dev@Acme.com ', 'dev@acme.com')).toBe(false);
  });
});
