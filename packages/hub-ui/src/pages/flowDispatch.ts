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

export const NO_CHILD_HUBS_REASON = 'No live child hub to send to.';

/**
 * Whether a Dispatch control should be live for this flow.
 *
 * A flow the parent sent IS dispatchable onward. A dispatch reaches only the
 * dispatching hub's direct children (the directives feed is scoped to the
 * polled hub's own child_hubs), and a middle hub installs what it receives
 * without re-dispatching it. In HQ → Regional → Team, relaying from Regional
 * is therefore the only way the HQ standard reaches Team hubs. The copy is
 * read-only here, but relaying does not edit it: the version it carries is
 * the one Regional received, exactly as a re-dispatch of a newer version
 * works one level up. The server checks org ownership only, so refusing here
 * would be decorative anyway.
 */
export function canDispatchFlow(
  _flow: { source?: string | null },
  children: ChildHubRow[],
): { allowed: boolean; reason: string | null } {
  if (liveChildHubs(children).length === 0) return { allowed: false, reason: NO_CHILD_HUBS_REASON };
  return { allowed: true, reason: null };
}

/**
 * The server's refusal names the children it would not target as ids
 * (`{ error, missing }`, 404 for unknown, 409 for detached mid-request). An
 * admin unticks by name, so the names are appended when they resolve.
 */
export function dispatchRefusalMessage(
  data: { error?: string; missing?: string[] } | undefined,
  children: ChildHubRow[],
  fallback: string,
): string {
  const base = data?.error ?? fallback;
  const missing = Array.isArray(data?.missing) ? data.missing : [];
  if (missing.length === 0) return base;
  const names = missing.map(id => children.find(c => c.id === id)?.name ?? id);
  return `${base}: ${names.join(', ')}`;
}

export type FlowDispatchRequest =
  | { flowId: string; scope: 'all' }
  | { flowId: string; scope: 'selected'; childHubIds: string[] };

export type FlowDispatchBody =
  | { ok: true; body: FlowDispatchRequest }
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
 * A dispatch whose flow has since been deleted can never be served: the
 * directives feed skips it and no target row is ever created, so it would sit
 * at "no child hub has picked this up yet" forever. The board says so and the
 * poll ignores it.
 */
export function dispatchFlowDeleted(d: FlowDispatchRow, knownFlowIds: Set<string>): boolean {
  return !knownFlowIds.has(d.flowId);
}

/**
 * Whether the board still owes the admin an answer, i.e. should keep polling.
 * A live dispatch with no targets counts: under 'all' nobody has polled yet,
 * which is not the same as nobody being targeted. A cancelled dispatch never
 * resolves further, whatever its targets say, and neither does one whose flow
 * is gone.
 */
export function flowDispatchesLive(rows: FlowDispatchRow[], knownFlowIds?: Set<string>): boolean {
  return rows.some(d =>
    !d.cancelledAt
    && !(knownFlowIds && dispatchFlowDeleted(d, knownFlowIds))
    && (d.targets.length === 0 || d.targets.some(t => t.state === 'pending')));
}

/** react-query's refetchInterval: poll every 5 s while something is owed, else stop. */
export const FLOW_DISPATCH_POLL_MS = 5_000;
export function flowDispatchPollInterval(rows: FlowDispatchRow[], knownFlowIds: Set<string>): number | false {
  return flowDispatchesLive(rows, knownFlowIds) ? FLOW_DISPATCH_POLL_MS : false;
}
