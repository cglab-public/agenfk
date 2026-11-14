/**
 * #223: the pre-action hub banner, as a pure function of the local server's
 * /internal/hub/status reply.
 *
 * Refusals used to vanish: the flusher's lastError was cleared by the next
 * flush, so a machine reported into a black hole for three days. The banner
 * now keys off the deadletter indicator, which only clears when the
 * deadletter file is emptied (requeued or discarded).
 */
import { describe, it, expect } from 'vitest';
import { hubBannerMessages, STUCK_FAILURE_THRESHOLD } from '../hubBanner';

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const msgs = (status: unknown) => hubBannerMessages(status).map(plain);

describe('hubBannerMessages', () => {
  it('is silent for a healthy, empty status', () => {
    expect(msgs({ halted: false, consecutiveFailures: 0, deadletter: { count: 0, actionable: 0, since: null, reasons: {}, unparseable: 0 } })).toEqual([]);
    expect(msgs({})).toEqual([]);
    expect(msgs(null)).toEqual([]);
  });

  it('keeps the halted warning', () => {
    const [m] = msgs({ halted: true, lastError: 'HTTP 401: bad key' });
    expect(m).toMatch(/Hub flusher halted/);
    expect(m).toMatch(/HTTP 401: bad key/);
  });

  it('keeps the stuck-delivery warning at the threshold, not below it', () => {
    expect(STUCK_FAILURE_THRESHOLD).toBe(3);
    expect(msgs({ consecutiveFailures: 2 })).toEqual([]);
    const [m] = msgs({ consecutiveFailures: 3, outboxDepth: 12, lastError: 'ETIMEDOUT' });
    expect(m).toMatch(/not being delivered — 3 consecutive failures, 12 queued/);
  });

  it('warns about actionable refusals until the deadletter is emptied, with the fix', () => {
    const [m] = msgs({
      halted: false, consecutiveFailures: 0, lastError: null,
      deadletter: { count: 204, actionable: 204, since: '2026-10-06T22:37:15.885Z', reasons: { foreign_installation: 204 }, unparseable: 0 },
    });
    expect(m).toMatch(/Hub refused 204 event\(s\) since 2026-10-06T22:37:15\.885Z/);
    expect(m).toMatch(/agenfk hub join/);
    expect(m).toMatch(/agenfk hub deadletter requeue/);
  });

  it('does not nag about hidden_user refusals alone (an admin decision, not a fault)', () => {
    expect(msgs({ deadletter: { count: 3, actionable: 0, since: '2026-10-06T00:00:00Z', reasons: { hidden_user: 3 }, unparseable: 0 } })).toEqual([]);
  });

  it('reports a halt AND refusals together — they are different problems', () => {
    const m = msgs({
      halted: true, lastError: 'x',
      deadletter: { count: 1, actionable: 1, since: '2026-10-06T00:00:00Z', reasons: { unknown: 1 }, unparseable: 0 },
    });
    expect(m).toHaveLength(2);
    expect(m[0]).toMatch(/halted/);
    expect(m[1]).toMatch(/Hub refused 1 event/);
  });
});
