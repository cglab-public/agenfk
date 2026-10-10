/** CGLAB-609 — the score counts only versioned events, judged against their own revision. */
import { describe, it, expect } from 'vitest';
import { computeFlowAdherence } from '../flowAdherence';
import type { Flow, FlowRevision, HistoryRecord } from '../types';

const flow = (name: string): Flow => ({
  id: 'f1',
  name,
  steps: [
    { id: 's1', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 's2', name: 'IN_PROGRESS', label: 'In Progress', order: 1 },
    { id: 's3', name: 'DONE', label: 'Done', order: 2, isAnchor: true },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const rev = (revision: number, name: string): FlowRevision => ({
  revision,
  flow: flow(name),
  createdAt: new Date(),
});

const ev = (from: string, to: string, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  id: Math.random().toString(36).slice(2),
  fromStatus: from as HistoryRecord['fromStatus'],
  toStatus: to as HistoryRecord['toStatus'],
  timestamp: new Date(),
  ...extra,
});

describe('computeFlowAdherence', () => {
  it('scores a fully consistent stamped history at 1', () => {
    const a = computeFlowAdherence(
      [
        ev('TODO', 'IN_PROGRESS', { flowId: 'f1', flowRevision: 1 }),
        ev('IN_PROGRESS', 'DONE', { flowId: 'f1', flowRevision: 1 }),
      ],
      [rev(1, 'v1')],
    );
    expect(a).toMatchObject({ judged: 2, compliant: 2, score: 1, unstamped: 0 });
  });

  it('judges each event against ITS OWN revision, not the current flow', () => {
    // Revision 1 had DISCOVERY; revision 2 renamed it. An event into DISCOVERY
    // is compliant under revision 1 even though DISCOVERY is gone today.
    const r1 = rev(1, 'v1');
    r1.flow.steps.splice(1, 0, { id: 'sd', name: 'DISCOVERY', label: 'Discovery', order: 1 });
    const a = computeFlowAdherence(
      [ev('TODO', 'DISCOVERY', { flowId: 'f1', flowRevision: 1 })],
      [r1, rev(2, 'v2')],
    );
    expect(a).toMatchObject({ judged: 1, compliant: 1, score: 1 });
  });

  it('counts a transition to a status that did not exist in the event revision as non-compliant', () => {
    const a = computeFlowAdherence(
      [ev('TODO', 'GHOST_STEP', { flowId: 'f1', flowRevision: 1 })],
      [rev(1, 'v1')],
    );
    expect(a).toMatchObject({ judged: 1, compliant: 0, score: 0 });
  });

  it('EXCLUDES unstamped events from both numerator and denominator', () => {
    const a = computeFlowAdherence(
      [
        ev('TODO', 'GHOST_STEP'), // legacy, no stamp
        ev('TODO', 'IN_PROGRESS', { flowId: 'f1', flowRevision: 1 }),
      ],
      [rev(1, 'v1')],
    );
    expect(a).toMatchObject({ unstamped: 1, judged: 1, compliant: 1, score: 1 });
  });

  it('excludes events naming an unresolvable revision and reports them separately', () => {
    const a = computeFlowAdherence(
      [ev('TODO', 'DONE', { flowId: 'f1', flowRevision: 99 })],
      [rev(1, 'v1')],
    );
    expect(a).toMatchObject({ unresolved: 1, judged: 0, score: null });
  });

  it('events stamped with a flowId but no revision are unstamped', () => {
    const a = computeFlowAdherence([ev('TODO', 'DONE', { flowId: 'f1' })], [rev(1, 'v1')]);
    expect(a.unstamped).toBe(1);
  });

  it('never judges an event stamped with flow X against revisions of flow Y', () => {
    const other = rev(1, 'Other');
    (other.flow as Flow).id = 'other-flow';
    const a = computeFlowAdherence(
      [ev('TODO', 'IN_PROGRESS', { flowId: 'f1', flowRevision: 1 })],
      [other],
    );
    expect(a).toMatchObject({ unresolved: 1, judged: 0, score: null });
  });

  it('an empty or undefined history scores null', () => {
    expect(computeFlowAdherence(undefined, [rev(1, 'v1')]).score).toBeNull();
    expect(computeFlowAdherence([], []).score).toBeNull();
  });
});
