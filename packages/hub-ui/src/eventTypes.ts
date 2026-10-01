// Type-only, by relative path: hub-ui has no runtime dependency on core, and
// this import is erased from the bundle. It exists so the label catalogue below
// is checked against the event types the framework actually emits.
import type { HubEventType, LegacyHubEventType } from '../../core/src/interfaces';

// The event types offered in the Event type filter before any has fired in the
// org: the developer-activity subset of the catalogue below (PR, fleet and
// repoint events are left to appear once observed). Unknown types coming back
// from /v1/event-types are merged in, so the filter never gates on this list.
export const KNOWN_EVENT_TYPES = [
  'item.created',
  'item.updated',
  'item.moved',
  'item.deleted',
  'item.closed',
  'step.transitioned',
  'validate.invoked',
  'validate.passed',
  'validate.failed',
  'step.approved',
  'check.overridden',
  'passkey.enrolled',
  'passkey.removed',
  'command.approved',
  'comment.added',
  'test.logged',
  'session.started',
  'session.ended',
] as const;

export function mergeEventTypes(observed: string[] | undefined): string[] {
  const set = new Set<string>(KNOWN_EVENT_TYPES);
  for (const t of observed ?? []) set.add(t);
  return [...set].sort();
}

/** The headings event types are filed under, in display order. */
export const EVENT_TYPE_GROUPS = ['Work items', 'Checks', 'Pull requests', 'Sessions', 'Security', 'Fleet', 'Other'] as const;
export type EventTypeGroup = typeof EVENT_TYPE_GROUPS[number];

/**
 * A plain label and a heading for every type the framework emits. The raw id
 * stays the value everywhere (URLs, queries, colours); this is only what a
 * person reads. A type missing here shows as its raw id under "Other".
 */
const EVENT_TYPE_META: Record<string, { label: string; group: EventTypeGroup }> = ({
  'item.created': { label: 'Item created', group: 'Work items' },
  'item.updated': { label: 'Item updated', group: 'Work items' },
  'item.moved': { label: 'Item moved', group: 'Work items' },
  'item.deleted': { label: 'Item deleted', group: 'Work items' },
  'item.closed': { label: 'Item closed', group: 'Work items' },
  'step.transitioned': { label: 'Step changed', group: 'Work items' },
  'comment.added': { label: 'Comment added', group: 'Work items' },
  'validate.invoked': { label: 'Check run', group: 'Checks' },
  'validate.passed': { label: 'Check passed', group: 'Checks' },
  'validate.failed': { label: 'Check failed', group: 'Checks' },
  'step.approved': { label: 'Step approved', group: 'Checks' },
  'check.overridden': { label: 'Check overridden', group: 'Checks' },
  'test.logged': { label: 'Test result logged', group: 'Checks' },
  'command.approved': { label: 'Command approved', group: 'Checks' },
  'pr.opened': { label: 'PR opened', group: 'Pull requests' },
  'pr.updated': { label: 'PR re-sized', group: 'Pull requests' },
  'session.started': { label: 'Session started', group: 'Sessions' },
  'session.ended': { label: 'Session ended', group: 'Sessions' },
  'passkey.enrolled': { label: 'Passkey enrolled', group: 'Security' },
  'passkey.removed': { label: 'Passkey removed', group: 'Security' },
  'fleet:upgrade:started': { label: 'Upgrade started', group: 'Fleet' },
  'fleet:upgrade:succeeded': { label: 'Upgrade succeeded', group: 'Fleet' },
  'fleet:upgrade:failed': { label: 'Upgrade failed', group: 'Fleet' },
  'hub:repoint:succeeded': { label: 'Repoint succeeded', group: 'Fleet' },
  'hub:repoint:blocked': { label: 'Repoint blocked', group: 'Fleet' },
  'hub:repoint:failed': { label: 'Repoint failed', group: 'Fleet' },
  // Checked against core's union: a type the framework starts emitting fails
  // the build until it gets a label here. Legacy types are never offered.
}) satisfies Record<Exclude<HubEventType, LegacyHubEventType>, { label: string; group: EventTypeGroup }>;

/** What a person reads for an event type; the raw id when it is not known. */
export function eventTypeLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_META, type) ? EVENT_TYPE_META[type].label : type;
}

/**
 * Types filed under their headings, in heading order; within a heading, in
 * catalogue order (unknown types alphabetically). Empty headings are dropped.
 */
export function groupEventTypes(types: string[]): Array<{ group: EventTypeGroup; types: string[] }> {
  const order = Object.keys(EVENT_TYPE_META);
  const groupOf = (t: string): EventTypeGroup =>
    Object.prototype.hasOwnProperty.call(EVENT_TYPE_META, t) ? EVENT_TYPE_META[t].group : 'Other';
  const rank = (t: string) => { const i = order.indexOf(t); return i < 0 ? order.length : i; };
  return EVENT_TYPE_GROUPS
    .map(group => ({
      group,
      types: types.filter(t => groupOf(t) === group).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
    }))
    .filter(g => g.types.length > 0);
}
