/**
 * Whether a flow is the parent hub's rather than this hub's (CGLAB-182).
 *
 * The server refuses the write whichever client asks — that is the control.
 * This is the explanation: an admin should see who owns the flow before they
 * click, instead of drafting an edit into a 409. The sentence also carries the
 * promise the detach path keeps, because "you cannot edit this" without "and
 * you keep it if you leave" reads like a hostage note.
 *
 * Keyed on the ORIGIN, never the name: a flow this hub authored that happens
 * to share a dispatched flow's name is an ordinary local flow, which is what
 * the install-alongside rule is for. An absent source is a row from an older
 * hub and is local — defaulting to locked would freeze an org out of its own
 * flows on upgrade.
 */
export interface ParentFlowLock {
  locked: boolean;
  reason: string | null;
}

export const PARENT_FLOW_LOCK_REASON =
  'Sent by the parent hub and managed there. It stays if this hub leaves the group, and becomes editable then.';

export function parentFlowLock(source: string | null | undefined): ParentFlowLock {
  return source === 'parent'
    ? { locked: true, reason: PARENT_FLOW_LOCK_REASON }
    : { locked: false, reason: null };
}
