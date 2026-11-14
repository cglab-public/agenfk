/**
 * #223: the pure half of `agenfk hub deadletter requeue` and of the sticky
 * refusal indicator. The deadletter file (~/.agenfk/hub-deadletter.jsonl) is
 * the last copy of every event the hub refused, so the rules for which lines
 * may go back to the outbox, and which must stay, live here where the CLI and
 * the server share them and Stryker can mutate them without any I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDeadletterLines,
  serializeDeadletterLines,
  validateRequeueFilters,
  selectForRequeue,
  summarizeRequeue,
  deadletterIndicator,
  refusalHint,
  indicatorHint,
  REQUEUE_DEFAULT_EXCLUDED_REASONS,
} from '../hubDeadletter';

interface LineSpec {
  eventId?: string | null;
  payloadEventId?: string | null;
  occurredAt?: string;
  deadletteredAt?: string;
  reason?: string;
  orgId?: string;
  type?: string;
  installationId?: string;
  payload?: unknown;
}

let seq = 0;
function line(spec: LineSpec = {}): string {
  const id = spec.eventId === undefined ? `ev-${++seq}` : spec.eventId;
  const payload = spec.payload !== undefined ? spec.payload : {
    eventId: spec.payloadEventId === undefined ? id : spec.payloadEventId,
    orgId: spec.orgId ?? 'cglab',
    installationId: spec.installationId ?? 'inst-1',
    occurredAt: spec.occurredAt ?? '2026-10-07T10:00:00.000Z',
    type: spec.type ?? 'pr.opened',
    payload: {},
  };
  return JSON.stringify({
    eventId: id,
    occurredAt: spec.occurredAt ?? '2026-10-07T10:00:00.000Z',
    deadletteredAt: spec.deadletteredAt ?? '2026-10-07T10:00:05.000Z',
    reason: spec.reason ?? 'foreign_installation',
    payload,
  });
}

const file = (...lines: string[]) => lines.join('\n') + '\n';

describe('parseDeadletterLines / serializeDeadletterLines', () => {
  it('skips blank lines and keeps unparseable ones verbatim as entry:null', () => {
    const raw = file(line({ eventId: 'a' }), '', '   ', 'TORN-LINE{', line({ eventId: 'b' }));
    const lines = parseDeadletterLines(raw);
    expect(lines).toHaveLength(3);
    expect(lines[0].entry?.eventId).toBe('a');
    expect(lines[1]).toEqual({ raw: 'TORN-LINE{', entry: null });
    expect(lines[2].entry?.eventId).toBe('b');
  });

  it('handles CRLF files without inventing blank-line entries', () => {
    const lines = parseDeadletterLines(`${line({ eventId: 'a' })}\r\n${line({ eventId: 'b' })}\r\n`);
    expect(lines.map(l => l.entry?.eventId)).toEqual(['a', 'b']);
  });

  it('treats a JSON line that is not an object as unparseable', () => {
    const lines = parseDeadletterLines(file('42', 'null', '"str"'));
    expect(lines.every(l => l.entry === null)).toBe(true);
  });

  it('round-trips the raw bytes of every line', () => {
    const a = line({ eventId: 'a' });
    const raw = file(a, 'TORN', line({ eventId: 'b' }));
    expect(serializeDeadletterLines(parseDeadletterLines(raw))).toBe(raw);
  });

  it('serializes an empty set as the empty string', () => {
    expect(serializeDeadletterLines([])).toBe('');
  });
});

describe('validateRequeueFilters', () => {
  it('accepts an absent body as no filters', () => {
    expect(validateRequeueFilters(undefined)).toEqual({ ok: true, filters: {} });
    expect(validateRequeueFilters(null)).toEqual({ ok: true, filters: {} });
    expect(validateRequeueFilters({})).toEqual({ ok: true, filters: {} });
  });

  it('accepts every documented filter', () => {
    const r = validateRequeueFilters({
      reasons: ['foreign_installation'], org: 'cglab', types: ['pr.opened'], since: '2026-10-06T00:00:00Z',
    });
    expect(r).toEqual({
      ok: true,
      filters: { reasons: ['foreign_installation'], org: 'cglab', types: ['pr.opened'], since: '2026-10-06T00:00:00Z' },
    });
  });

  it('rejects unknown keys (a typo must not silently widen the selection)', () => {
    const r = validateRequeueFilters({ reason: ['foreign_installation'] });
    expect(r.ok).toBe(false);
  });

  it.each([
    [{ reasons: 'foreign_installation' }],
    [{ reasons: [] }],
    [{ reasons: [''] }],
    [{ reasons: ['Bad Reason!'] }],
    [{ org: '' }],
    [{ org: 42 }],
    [{ types: ['pr.opened', 7] }],
    [{ types: [] }],
    [{ since: 'yesterday-ish' }],
    [{ since: 12 }],
    ['not-an-object'],
    [[]],
  ])('rejects malformed input %j', (input) => {
    expect(validateRequeueFilters(input).ok).toBe(false);
  });

  it('refuses org_mismatch without --org and points to carry-over', () => {
    const r = validateRequeueFilters({ reasons: ['org_mismatch'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--org/);
    if (!r.ok) expect(r.error).toMatch(/carry-over/);
    expect(validateRequeueFilters({ reasons: ['org_mismatch'], org: 'old-corp' }).ok).toBe(true);
  });
});

describe('selectForRequeue', () => {
  it('selects foreign_installation and unknown by default, and leaves hidden_user, org_mismatch and invalid', () => {
    expect([...REQUEUE_DEFAULT_EXCLUDED_REASONS].sort()).toEqual(['hidden_user', 'invalid', 'org_mismatch']);
    const lines = parseDeadletterLines(file(
      line({ eventId: 'fi', reason: 'foreign_installation' }),
      line({ eventId: 'un', reason: 'unknown' }),
      line({ eventId: 'hu', reason: 'hidden_user' }),
      line({ eventId: 'om', reason: 'org_mismatch' }),
      line({ eventId: 'iv', reason: 'invalid' }),
    ));
    const { selected, excluded } = selectForRequeue(lines, {});
    expect(selected.map(s => s.eventId)).toEqual(['fi', 'un']);
    expect(excluded).toEqual({ 'reason:hidden_user': 1, 'reason:org_mismatch': 1, 'reason:invalid': 1 });
  });

  it('a line with no reason counts as unknown', () => {
    const raw = JSON.stringify({ eventId: 'x', occurredAt: '2026-10-07T10:00:00Z', payload: { eventId: 'x', orgId: 'cglab' } });
    const { selected } = selectForRequeue(parseDeadletterLines(raw), {});
    expect(selected).toHaveLength(1);
    expect(selected[0].reason).toBe('unknown');
  });

  it('an explicit --reason list replaces the default set', () => {
    const lines = parseDeadletterLines(file(
      line({ eventId: 'fi', reason: 'foreign_installation' }),
      line({ eventId: 'hu', reason: 'hidden_user' }),
    ));
    const { selected, excluded } = selectForRequeue(lines, { reasons: ['hidden_user'] });
    expect(selected.map(s => s.eventId)).toEqual(['hu']);
    expect(excluded).toEqual({ 'reason:foreign_installation': 1 });
  });

  it('never selects a line that cannot be replayed', () => {
    const lines = parseDeadletterLines(file(
      'TORN',
      line({ eventId: 'raw', payload: '{"not":"parsed"}' }),
      line({ eventId: 'nopayload', payload: null }),
      line({ eventId: 'arr', payload: [1, 2] }),
      line({ eventId: 'noid', payloadEventId: null }),
      line({ eventId: 'emptyid', payloadEventId: '' }),
      // The flusher matches rejections by the PAYLOAD's eventId and deletes by
      // the outbox key: if they differ, a refusal becomes a silent delete.
      line({ eventId: 'outer', payloadEventId: 'inner' }),
      line({ eventId: null, payloadEventId: 'p' }),
      line({ eventId: 'ok' }),
    ));
    const { selected, excluded } = selectForRequeue(lines, {});
    expect(selected.map(s => s.eventId)).toEqual(['ok']);
    expect(excluded).toEqual({ unparseable: 1, unreplayable: 7 });
  });

  it('a line without occurredAt falls back to the payload, and is unreplayable without either', () => {
    const fallback = JSON.stringify({ eventId: 'f', reason: 'foreign_installation', payload: { eventId: 'f', occurredAt: '2026-10-08T00:00:00Z' } });
    const neither = JSON.stringify({ eventId: 'n', reason: 'foreign_installation', payload: { eventId: 'n' } });
    const { selected, excluded } = selectForRequeue(parseDeadletterLines(file(fallback, neither)), {});
    expect(selected.map(s => [s.eventId, s.occurredAt])).toEqual([['f', '2026-10-08T00:00:00Z']]);
    expect(excluded).toEqual({ unreplayable: 1 });
  });

  it('filters by org, type and since', () => {
    const lines = parseDeadletterLines(file(
      line({ eventId: 'a', orgId: 'cglab', type: 'pr.opened', occurredAt: '2026-10-07T00:00:00Z' }),
      line({ eventId: 'b', orgId: 'other', type: 'pr.opened', occurredAt: '2026-10-07T00:00:00Z' }),
      line({ eventId: 'c', orgId: 'cglab', type: 'item.created', occurredAt: '2026-10-07T00:00:00Z' }),
      line({ eventId: 'd', orgId: 'cglab', type: 'pr.opened', occurredAt: '2026-10-01T00:00:00Z' }),
    ));
    const { selected, excluded } = selectForRequeue(lines, { org: 'cglab', types: ['pr.opened'], since: '2026-10-06T00:00:00Z' });
    expect(selected.map(s => s.eventId)).toEqual(['a']);
    expect(excluded).toEqual({ org: 1, type: 1, since: 1 });
  });

  it('since compares instants, not strings (offsets and missing millis)', () => {
    const lines = parseDeadletterLines(file(
      line({ eventId: 'later', occurredAt: '2026-10-06T22:00:00-03:00' }), // 2026-10-07T01:00Z
      line({ eventId: 'earlier', occurredAt: '2026-10-06T23:59:59.999Z' }),
    ));
    const { selected } = selectForRequeue(lines, { since: '2026-10-07T00:00:00Z' });
    expect(selected.map(s => s.eventId)).toEqual(['later']);
  });

  it('returns what the outbox needs: index, original eventId/occurredAt and the payload JSON', () => {
    const raw = file('TORN', line({ eventId: 'e1', occurredAt: '2026-10-06T22:37:09.924Z', installationId: 'inst-9', type: 'pr.opened' }));
    const [s] = selectForRequeue(parseDeadletterLines(raw), {}).selected;
    expect(s.index).toBe(1);
    expect(s.eventId).toBe('e1');
    expect(s.occurredAt).toBe('2026-10-06T22:37:09.924Z');
    expect(JSON.parse(s.payloadJson)).toMatchObject({ eventId: 'e1', installationId: 'inst-9', type: 'pr.opened', orgId: 'cglab' });
    expect(s.reason).toBe('foreign_installation');
    expect(s.type).toBe('pr.opened');
    expect(s.orgId).toBe('cglab');
    expect(s.installationId).toBe('inst-9');
  });
});

describe('summarizeRequeue', () => {
  it('counts by reason, type, org and installation, with the occurred-at range', () => {
    const lines = parseDeadletterLines(file(
      line({ eventId: 'a', type: 'pr.opened', installationId: 'i1', occurredAt: '2026-10-08T00:00:00Z' }),
      line({ eventId: 'b', type: 'item.closed', installationId: 'i1', occurredAt: '2026-10-06T00:00:00Z' }),
      line({ eventId: 'c', type: 'pr.opened', installationId: 'i2', orgId: 'other', reason: 'unknown', occurredAt: '2026-10-09T00:00:00Z' }),
    ));
    const s = summarizeRequeue(selectForRequeue(lines, {}).selected);
    expect(s).toEqual({
      count: 3,
      firstAt: '2026-10-06T00:00:00Z',
      lastAt: '2026-10-09T00:00:00Z',
      byReason: { foreign_installation: 2, unknown: 1 },
      byType: { 'pr.opened': 2, 'item.closed': 1 },
      byOrg: { cglab: 2, other: 1 },
      byInstallation: { i1: 2, i2: 1 },
    });
  });

  it('labels missing fields instead of dropping them', () => {
    const raw = JSON.stringify({ eventId: 'x', occurredAt: '2026-10-07T00:00:00Z', reason: 'foreign_installation', payload: { eventId: 'x' } });
    const s = summarizeRequeue(selectForRequeue(parseDeadletterLines(raw), {}).selected);
    expect(s.byType).toEqual({ '(none)': 1 });
    expect(s.byOrg).toEqual({ '(none)': 1 });
    expect(s.byInstallation).toEqual({ '(none)': 1 });
  });

  it('an empty selection summarizes to zero with no range', () => {
    expect(summarizeRequeue([])).toEqual({ count: 0, firstAt: null, lastAt: null, byReason: {}, byType: {}, byOrg: {}, byInstallation: {} });
  });
});

describe('deadletterIndicator', () => {
  it('is empty for an empty file', () => {
    expect(deadletterIndicator([])).toEqual({ count: 0, actionable: 0, since: null, reasons: {}, unparseable: 0 });
  });

  it('reports count, actionable (everything but hidden_user), the oldest refusal and reason tallies', () => {
    const lines = parseDeadletterLines(file(
      line({ reason: 'foreign_installation', deadletteredAt: '2026-10-07T00:00:00Z' }),
      line({ reason: 'hidden_user', deadletteredAt: '2026-10-05T00:00:00Z' }),
      line({ reason: 'foreign_installation', deadletteredAt: '2026-10-06T22:37:15.885Z' }),
      'TORN',
    ));
    expect(deadletterIndicator(lines)).toEqual({
      count: 4,
      actionable: 3,
      since: '2026-10-05T00:00:00Z',
      reasons: { foreign_installation: 2, hidden_user: 1 },
      unparseable: 1,
    });
  });

  it('hidden_user alone is not actionable', () => {
    const ind = deadletterIndicator(parseDeadletterLines(file(line({ reason: 'hidden_user' }))));
    expect(ind.count).toBe(1);
    expect(ind.actionable).toBe(0);
  });
});

describe('refusalHint / indicatorHint', () => {
  it('foreign_installation names the fix: a new invite, hub join, then requeue', () => {
    const h = refusalHint('foreign_installation');
    expect(h).toMatch(/another installation/);
    expect(h).toMatch(/agenfk hub join/);
    expect(h).toMatch(/agenfk hub deadletter requeue/);
  });

  it('org_mismatch points to carry-over, hidden_user to discard, invalid to inspection', () => {
    expect(refusalHint('org_mismatch')).toMatch(/carry-over/);
    expect(refusalHint('hidden_user')).toMatch(/discard/);
    expect(refusalHint('invalid')).toMatch(/agenfk hub deadletter/);
    expect(refusalHint('something_new')).toMatch(/agenfk hub deadletter requeue/);
  });

  // Review finding 2: every hint must name a command that actually removes
  // exactly those lines — `discard` alone fails, and `--all` would also
  // destroy events that could still be requeued.
  it('lines requeue cannot move point to a discard that removes only them', () => {
    expect(refusalHint('hidden_user')).toContain('agenfk hub deadletter discard --reason hidden_user');
    expect(refusalHint('invalid')).toContain('agenfk hub deadletter discard --reason invalid');
    expect(refusalHint('unparseable')).toContain('agenfk hub deadletter discard --unparseable');
  });

  it('a file whose only actionable lines are unreadable gets the unparseable hint, not requeue', () => {
    const ind = deadletterIndicator(parseDeadletterLines(file('TORN', line({ reason: 'hidden_user' }))));
    expect(ind.actionable).toBe(1);
    expect(indicatorHint(ind)).toBe(refusalHint('unparseable'));
  });

  it('indicatorHint follows the most frequent actionable reason, and is null when nothing is actionable', () => {
    const ind = deadletterIndicator(parseDeadletterLines(file(
      line({ reason: 'hidden_user' }), line({ reason: 'hidden_user' }), line({ reason: 'hidden_user' }),
      line({ reason: 'foreign_installation' }),
    )));
    expect(indicatorHint(ind)).toBe(refusalHint('foreign_installation'));
    expect(indicatorHint(deadletterIndicator(parseDeadletterLines(file(line({ reason: 'hidden_user' })))))).toBeNull();
    expect(indicatorHint(deadletterIndicator([]))).toBeNull();
  });
});
