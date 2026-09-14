/**
 * Adding one streamed event to a run's transcript (CGLAB f713eb70).
 *
 * This ran on every `run:event` and did three things: a linear scan for a
 * duplicate, a full copy, and a complete RE-SORT of an array that was already
 * sorted. Over a run of N events that is N arrays totalling N²/2 slots and
 * ΣN log N comparisons — work proportional to the SQUARE of how long the
 * session has been going, in an app whose premise is sessions that last hours.
 *
 * The copy is not the waste and cannot be removed: React Query re-renders on
 * reference identity, so a new array is the price of the update. The scan and
 * the sort are the waste, and they exist to handle a case that is rare rather
 * than normal — events carry a monotonically increasing `seq` and arrive in
 * order almost always.
 *
 * So the ordinary path is decided in constant time by looking at the tail, and
 * the old behaviour is kept intact for the case that actually needs it. That
 * ordering matters more than the arithmetic: getting it wrong would silently
 * scramble a transcript, which is worse than being slow.
 */

/**
 * The shape this needs. The panel's own `RunEvent` is wider.
 *
 * `seq` is OPTIONAL here, and the type used to say otherwise — which made a
 * real bug invisible. The server assigns the position inside the insert, and
 * for a while it emitted the object it was handed rather than the one it
 * wrote, so every socket event carried `seq: undefined`. Declaring the field
 * required did not make it present; it only stopped TypeScript from asking.
 */
export interface Sequenced {
  readonly seq?: number;
}

/**
 * Add `event` to `prev`, keeping it ordered by `seq`.
 *
 * Returns `prev` UNCHANGED — the same reference — when the event is already
 * there. That is load-bearing rather than tidy: a new array would re-render
 * every row of the transcript to display nothing new, and duplicates are
 * ordinary, since a refetch and the socket can deliver the same event.
 */
export function appendEvent<T extends Sequenced>(
  prev: readonly T[] | undefined,
  event: T,
): readonly T[] {
  const list = Array.isArray(prev) ? prev : [];
  if (list.length === 0) return [event];

  /*
   * An event with no position cannot be placed or compared, so it goes on the
   * end and nothing pretends to know more than that.
   *
   * This is the case that broke the live transcript. Two positionless events
   * compare EQUAL to one another, so every event after the first read as a
   * duplicate of it and was thrown away — a session showed one line and then
   * nothing. Appending is the only honest answer: they arrived in order, and
   * arrival order is all there is to go on.
   */
  const last = list[list.length - 1];
  if (event.seq === undefined || last.seq === undefined) return [...list, event];

  // The overwhelmingly common case: the newest event, arriving newest-last.
  // One comparison, no scan, no sort.
  if (event.seq > last.seq) return [...list, event];

  // A duplicate of the newest, which is what a refetch racing the socket
  // produces. Caught before the scan because it is the second most common
  // thing that happens here.
  if (event.seq === last.seq) return list;

  /*
   * Out of order, or an old duplicate. Rare, and handled exactly as before —
   * scan, then insert and sort. Falling back rather than trying to be clever
   * is deliberate: an event that lands in the wrong place is a transcript
   * that reads as a different conversation, and no amount of speed pays for
   * that.
   */
  if (list.some(e => e.seq === event.seq)) return list;
  return [...list, event].sort((a, z) => a.seq - z.seq);
}
