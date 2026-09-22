/**
 * Pure rules behind dispatching a flow to child hubs (CGLAB-358).
 *
 * The parent-side API shipped with CGLAB-182 and nothing in the UI called it,
 * so the only way a child ever received a parent flow was a hand-written
 * request. These are the decisions the page makes before it talks to the
 * server, kept out of React so each one can be pinned on its own.
 */
import { describe, it, expect } from 'vitest';
import {
  canDispatchFlow,
  flowDispatchBody,
  flowDispatchTargetRow,
  flowDispatchesLive,
  liveChildHubs,
  type ChildHubRow,
  type FlowDispatchRow,
} from '../pages/flowDispatch';

const child = (over: Partial<ChildHubRow> = {}): ChildHubRow => ({
  id: 'ch-1', name: 'acme-emea', detached: false, ...over,
});

const dispatch = (over: Partial<FlowDispatchRow> = {}): FlowDispatchRow => ({
  id: 'd-1', flowId: 'f-1', flowVersion: 2, scope: 'all', createdByEmail: 'ops@acme.test',
  createdAt: '2026-09-22T10:00:00.000Z', cancelledAt: null, targets: [], ...over,
});

describe('liveChildHubs', () => {
  it('drops detached hubs — a dead endpoint can never install anything', () => {
    const rows = [child(), child({ id: 'ch-2', name: 'gone', detached: true })];
    expect(liveChildHubs(rows).map(c => c.id)).toEqual(['ch-1']);
  });
});

describe('canDispatchFlow', () => {
  it('allows a flow this hub authored when it has at least one live child', () => {
    expect(canDispatchFlow({ source: 'hub' }, [child()])).toEqual({ allowed: true, reason: null });
  });

  it('allows a community-imported flow too — once installed it is ours', () => {
    expect(canDispatchFlow({ source: 'community' }, [child()]).allowed).toBe(true);
  });

  it("refuses a flow the parent sent — it is the parent's to dispatch, not ours to relay", () => {
    const r = canDispatchFlow({ source: 'parent' }, [child()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/parent/i);
  });

  it('refuses when there is no live child to send to, and says so', () => {
    const r = canDispatchFlow({ source: 'hub' }, [child({ detached: true })]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no (live )?child hub/i);
  });
});

describe('flowDispatchBody', () => {
  it("scope 'all' carries no ids — the server resolves current AND future children", () => {
    expect(flowDispatchBody('f-1', 'all', new Set(['ch-1']))).toEqual({
      ok: true, body: { flowId: 'f-1', scope: 'all' },
    });
  });

  it("scope 'selected' carries exactly the picked ids", () => {
    expect(flowDispatchBody('f-1', 'selected', new Set(['ch-2', 'ch-1']))).toEqual({
      ok: true, body: { flowId: 'f-1', scope: 'selected', childHubIds: ['ch-2', 'ch-1'] },
    });
  });

  it("refuses 'selected' with nothing picked instead of letting the server 400 it", () => {
    const r = flowDispatchBody('f-1', 'selected', new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pick at least one/i);
  });
});

describe('flowDispatchTargetRow', () => {
  it('pending reads as waiting on the child, not as done', () => {
    const row = flowDispatchTargetRow('pending', null);
    expect(row.label).toMatch(/pending/i);
    expect(row.settled).toBe(false);
    expect(row.tone).toBe('waiting');
  });

  it('installed is settled and says so', () => {
    const row = flowDispatchTargetRow('installed', null);
    expect(row.label).toMatch(/installed/i);
    expect(row.settled).toBe(true);
    expect(row.tone).toBe('ok');
  });

  it("failed carries the child's own explanation", () => {
    const row = flowDispatchTargetRow('failed', 'the directive did not carry a usable flow definition');
    expect(row.label).toMatch(/failed/i);
    expect(row.settled).toBe(true);
    expect(row.tone).toBe('error');
    expect(row.detail).toBe('the directive did not carry a usable flow definition');
  });

  it('an unknown state is shown verbatim rather than mislabelled', () => {
    const row = flowDispatchTargetRow('something-new', null);
    expect(row.label).toBe('something-new');
    expect(row.settled).toBe(false);
  });
});

describe('flowDispatchesLive — whether the board should keep polling', () => {
  it('polls while any live dispatch has a pending target', () => {
    const rows = [dispatch({ targets: [{ childHubId: 'ch-1', name: 'a', state: 'pending', detail: null, updatedAt: null }] })];
    expect(flowDispatchesLive(rows)).toBe(true);
  });

  it("polls while a live 'all' dispatch has no targets yet — nobody has polled, not nobody is targeted", () => {
    expect(flowDispatchesLive([dispatch({ targets: [] })])).toBe(true);
  });

  it('stops once every target has answered', () => {
    const rows = [dispatch({ targets: [
      { childHubId: 'ch-1', name: 'a', state: 'installed', detail: null, updatedAt: null },
      { childHubId: 'ch-2', name: 'b', state: 'failed', detail: 'x', updatedAt: null },
    ] })];
    expect(flowDispatchesLive(rows)).toBe(false);
  });

  it('a cancelled dispatch never keeps the board polling, whatever its targets say', () => {
    expect(flowDispatchesLive([dispatch({ cancelledAt: '2026-09-22T11:00:00.000Z', targets: [] })])).toBe(false);
  });

  it('an empty board does not poll', () => {
    expect(flowDispatchesLive([])).toBe(false);
  });
});
