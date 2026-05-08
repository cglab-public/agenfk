// Catalog of every event type the AgEnFK framework emits today. Kept in sync
// with EventType in packages/core/src/interfaces.ts. Used to seed the chip
// filter so users can pick a type even before any event of that kind has fired
// in their org. Unknown types coming back from /v1/event-types are merged in,
// so the catalog never gates on this list being exhaustive.
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
  'comment.added',
  'test.logged',
  'tokens.logged',
  'session.started',
  'session.ended',
] as const;

export function mergeEventTypes(observed: string[] | undefined): string[] {
  const set = new Set<string>(KNOWN_EVENT_TYPES);
  for (const t of observed ?? []) set.add(t);
  return [...set].sort();
}
