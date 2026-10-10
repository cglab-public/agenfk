/**
 * CGLAB-609 — the flow adherence score, computed ONLY from versioned events.
 *
 * A transition event counts toward the score only when it carries BOTH the
 * flowId and the flowRevision it happened under (CGLAB-608). Unstamped events
 * — legacy records, projects without a flow, dangling flows — are excluded
 * from BOTH the numerator and the denominator: backwards compatible by
 * construction, and a project that never used versioning simply has no score.
 *
 * A stamped event is judged against the flow REVISION it names (not today's
 * flow): it is compliant when both its statuses are steps of that revision.
 * Events naming a revision that no longer exists cannot be judged and are
 * reported separately, also outside the score.
 */
import type { Flow, FlowRevision, HistoryRecord } from './types';

export interface FlowAdherence {
  /** Stamped, judgeable transitions: the score's denominator. */
  judged: number;
  /** Judged transitions that were consistent with their own flow revision. */
  compliant: number;
  /** judged/compliant, or null when nothing is judgeable. */
  score: number | null;
  /** Stamped transitions whose revision could not be resolved (excluded). */
  unresolved: number;
  /** Transitions without flowId+flowRevision (excluded, backwards compatible). */
  unstamped: number;
}

/** The distinct flowIds named by any stamped event in these histories. */
export function flowIdsInHistories(histories: Array<HistoryRecord[] | undefined>): string[] {
  const ids = new Set<string>();
  for (const history of histories) {
    for (const h of history ?? []) {
      if (h.flowId && typeof h.flowRevision === 'number') ids.add(h.flowId);
    }
  }
  return [...ids];
}

export function computeFlowAdherence(
  history: HistoryRecord[] | undefined,
  revisions: FlowRevision[],
): FlowAdherence {
  // Key includes the flow's own id: an event stamped with flow X is never
  // judged against a revision of flow Y, however they are passed in.
  const stepsOf = new Map<string, Set<string>>();
  for (const r of revisions) {
    stepsOf.set(JSON.stringify([r.flow.id, r.revision]), new Set(r.flow.steps.map((s) => s.name)));
  }

  let judged = 0;
  let compliant = 0;
  let unresolved = 0;
  let unstamped = 0;

  for (const h of history ?? []) {
    if (!h.flowId || typeof h.flowRevision !== 'number') {
      unstamped++;
      continue;
    }
    const names = stepsOf.get(JSON.stringify([h.flowId, h.flowRevision]));
    if (!names) {
      unresolved++;
      continue;
    }
    judged++;
    if (names.has(h.fromStatus) && names.has(h.toStatus)) compliant++;
  }

  return { judged, compliant, unresolved, unstamped, score: judged ? compliant / judged : null };
}
