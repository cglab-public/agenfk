/**
 * Story e3068dce (CGLAB-117): unit tests for the pure deadletter helpers
 * exported by the hub command module. Kept in their own file (no source
 * scanning) so they can run under the Stryker mutation runner, which mutates
 * the source on disk and would break readFileSync-based assertions.
 */
import { describe, it, expect } from 'vitest';
import { summarizeDeadletter, filterDeadletterForDiscard, filterDeadletterLinesForDiscard } from '../commands/hub';

const entry = (eventId: string, orgId: string | undefined, occurredAt: string, reason: string) => ({
  eventId,
  occurredAt,
  deadletteredAt: occurredAt,
  reason,
  payload: { ...(orgId === undefined ? {} : { orgId }), eventId },
});

describe('summarizeDeadletter', () => {
  it('groups by payload org with count, occurred range and reason tallies', () => {
    const out = summarizeDeadletter([
      entry('a', 'org-a', '2026-01-01T00:00:00Z', 'org_mismatch'),
      entry('b', 'org-a', '2026-01-03T00:00:00Z', 'hidden_user'),
      entry('c', 'org-b', '2026-02-01T00:00:00Z', 'invalid'),
    ]);
    expect(out).toEqual([
      { org: 'org-a', count: 2, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-03T00:00:00Z', reasons: { org_mismatch: 1, hidden_user: 1 } },
      { org: 'org-b', count: 1, firstAt: '2026-02-01T00:00:00Z', lastAt: '2026-02-01T00:00:00Z', reasons: { invalid: 1 } },
    ]);
  });

  it('buckets entries with no readable org under (unknown)', () => {
    const out = summarizeDeadletter([entry('x', undefined, '2026-03-01T00:00:00Z', 'invalid')]);
    expect(out).toHaveLength(1);
    expect(out[0].org).toBe('(unknown)');
    expect(out[0].count).toBe(1);
  });

  it('keeps first/last range correct across unordered input', () => {
    const out = summarizeDeadletter([
      entry('m', 'org-a', '2026-05-05T00:00:00Z', 'invalid'),
      entry('n', 'org-a', '2026-01-01T00:00:00Z', 'invalid'),
      entry('o', 'org-a', '2026-03-03T00:00:00Z', 'invalid'),
    ]);
    expect(out[0].firstAt).toBe('2026-01-01T00:00:00Z');
    expect(out[0].lastAt).toBe('2026-05-05T00:00:00Z');
    expect(out[0].reasons).toEqual({ invalid: 3 });
  });

  it('empty input yields no groups', () => {
    expect(summarizeDeadletter([])).toEqual([]);
  });

  it('tolerates malformed entries without crashing or misgrouping', () => {
    const out = summarizeDeadletter([
      null as any,
      { payload: 'NOT-JSON', occurredAt: '2026-01-01T00:00:00Z' } as any,
      { payload: { orgId: '' }, occurredAt: '2026-01-02T00:00:00Z' } as any,
      { payload: { orgId: 'x' }, occurredAt: 123, reason: '' } as any,
    ]);
    expect(out).toEqual([
      { org: '(unknown)', count: 3, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-02T00:00:00Z', reasons: { unknown: 3 } },
      { org: 'x', count: 1, firstAt: null, lastAt: null, reasons: { unknown: 1 } },
    ]);
  });
});

describe('filterDeadletterForDiscard', () => {
  const entries = [
    entry('a', 'org-a', '2026-01-01T00:00:00Z', 'org_mismatch'),
    entry('b', 'org-b', '2026-01-02T00:00:00Z', 'invalid'),
    entry('c', 'org-a', '2026-01-03T00:00:00Z', 'hidden_user'),
  ];

  it('discards ONLY the named org', () => {
    const kept = filterDeadletterForDiscard(entries, { org: 'org-a' });
    expect(kept.map(e => e.eventId)).toEqual(['b']);
  });

  it('--all discards everything', () => {
    expect(filterDeadletterForDiscard(entries, { all: true })).toEqual([]);
  });

  it('--all wins over --org when both are given', () => {
    expect(filterDeadletterForDiscard(entries, { org: 'org-a', all: true })).toEqual([]);
  });

  it('an org that matches nothing keeps every entry', () => {
    expect(filterDeadletterForDiscard(entries, { org: 'nope' })).toHaveLength(3);
  });

  it('no options keeps every entry', () => {
    expect(filterDeadletterForDiscard(entries, {})).toHaveLength(3);
  });
});

describe('filterDeadletterLinesForDiscard', () => {
  const parsed = (e: any) => ({ raw: JSON.stringify(e), entry: e });
  const lines = [
    parsed({ eventId: 'a', payload: { orgId: 'org-a' } }),
    { raw: 'TORN-GARBAGE-LINE', entry: null },
    parsed({ eventId: 'b', payload: { orgId: 'org-b' } }),
  ];

  it('--org preserves unparseable lines (they may be the last copy of something)', () => {
    const kept = filterDeadletterLinesForDiscard(lines, { org: 'org-a' });
    expect(kept.map(l => l.raw)).toEqual(['TORN-GARBAGE-LINE', JSON.stringify({ eventId: 'b', payload: { orgId: 'org-b' } })]);
  });

  it('--all removes unparseable lines too (typed confirmation covers the whole file)', () => {
    expect(filterDeadletterLinesForDiscard(lines, { all: true })).toEqual([]);
  });

  it('no options keeps every line', () => {
    expect(filterDeadletterLinesForDiscard(lines, {})).toHaveLength(3);
  });

  it('preserves raw bytes verbatim for untouched lines', () => {
    const weird = { raw: '{"eventId":"c","payload":{"orgId":"org-z"},"extra":  1}', entry: { eventId: 'c', payload: { orgId: 'org-z' } } };
    const kept = filterDeadletterLinesForDiscard([...lines, weird], { org: 'org-a' });
    expect(kept.map(l => l.raw)).toContain(weird.raw);
  });
});
