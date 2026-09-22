/**
 * Dispatching a flow to child hubs, the decisions the page makes before it
 * talks to the server (CGLAB-358).
 *
 * The parent-side API shipped with CGLAB-182 and nothing in the UI called it,
 * so a child hub never received a parent flow unless someone hand-wrote the
 * request. These rules sit outside React so each can be pinned on its own; the
 * page only renders what they decide.
 */

export interface ChildHubRow {
  id: string;
  name: string;
  detached: boolean;
}

export interface FlowDispatchTarget {
  childHubId: string;
  name: string;
  state: string;
  detail: string | null;
  updatedAt: string | null;
}

export interface FlowDispatchRow {
  id: string;
  flowId: string;
  flowVersion: number;
  scope: 'all' | 'selected' | string;
  createdByEmail: string | null;
  createdAt: string | null;
  cancelledAt: string | null;
  /** Under scope 'all' a target appears only once a hub has been served. */
  targets: FlowDispatchTarget[];
}

export type DispatchScopeMode = 'all' | 'selected';

/** A detached hub is a dead endpoint: it is never offered as a target. */
export function liveChildHubs(rows: ChildHubRow[]): ChildHubRow[] {
  return rows.filter(r => !r.detached);
}

export const PARENT_FLOW_DISPATCH_REASON =
  "This flow was sent by the parent hub. It is the parent's to dispatch, not ours to relay.";
export const NO_CHILD_HUBS_REASON = 'No live child hub to send to.';

/**
 * Whether a Dispatch control should be live for this flow.
 *
 * A flow of origin `parent` belongs upstream: relaying it downstream would let
 * a middle hub re-dispatch a definition it cannot edit, and the parent's own
 * dispatch already reaches every hub below it under scope 'all'.
 */
export function canDispatchFlow(
  flow: { source?: string | null },
  children: ChildHubRow[],
): { allowed: boolean; reason: string | null } {
  if (flow.source === 'parent') return { allowed: false, reason: PARENT_FLOW_DISPATCH_REASON };
  if (liveChildHubs(children).length === 0) return { allowed: false, reason: NO_CHILD_HUBS_REASON };
  return { allowed: true, reason: null };
}

export type FlowDispatchBody =
  | { ok: true; body: { flowId: string; scope: 'all' } | { flowId: string; scope: 'selected'; childHubIds: string[] } }
  | { ok: false; error: string };

/**
 * The request the page sends. 'all' deliberately carries no ids: the server
 * resolves it against current AND future children, which is what makes a
 * late-joining hub pick the flow up. 'selected' with nothing ticked is refused
 * here rather than letting the server 400 it.
 */
export function flowDispatchBody(flowId: string, mode: DispatchScopeMode, selected: Set<string>): FlowDispatchBody {
  if (mode === 'all') return { ok: true, body: { flowId, scope: 'all' } };
  const childHubIds = Array.from(selected);
  if (childHubIds.length === 0) return { ok: false, error: 'Pick at least one child hub, or choose All.' };
  return { ok: true, body: { flowId, scope: 'selected', childHubIds } };
}

export interface FlowDispatchTargetRow {
  label: string;
  tone: 'waiting' | 'ok' | 'error' | 'unknown';
  /** Muted styling for a row whose answer is in. */
  settled: boolean;
  detail: string | null;
}

/** How one child's answer reads. Pending is "waiting on the child", never "done". */
export function flowDispatchTargetRow(state: string, detail: string | null): FlowDispatchTargetRow {
  switch (state) {
    case 'pending': return { label: 'Pending', tone: 'waiting', settled: false, detail: null };
    case 'installed': return { label: 'Installed', tone: 'ok', settled: true, detail: null };
    case 'failed': return { label: 'Failed', tone: 'error', settled: true, detail };
    default: return { label: state, tone: 'unknown', settled: false, detail };
  }
}

/**
 * Whether the board still owes the admin an answer, i.e. should keep polling.
 * A live dispatch with no targets counts: under 'all' nobody has polled yet,
 * which is not the same as nobody being targeted. A cancelled dispatch never
 * resolves further, whatever its targets say.
 */
export function flowDispatchesLive(rows: FlowDispatchRow[]): boolean {
  return rows.some(d =>
    !d.cancelledAt && (d.targets.length === 0 || d.targets.some(t => t.state === 'pending')));
}
