/**
 * Putting a view tab somewhere else in the bar (CGLAB-176).
 *
 * Pulled out of AppShell as a pure function for one reason: there are now two
 * ways to reorder — the arrow button and dragging — and the alternative is two
 * implementations of the same rule that agree until one of them is edited. That
 * pattern already cost this epic real bugs, so the arrow is expressed in terms
 * of this too rather than keeping its own splice.
 *
 * Drag stays an ADDITION. The arrow button works from the keyboard and needs no
 * pointer; dragging is better with a mouse and impossible without one, so
 * replacing one with the other would trade an accessible affordance for an
 * inaccessible one.
 */

/**
 * Move `moved` into the slot `target` currently occupies.
 *
 * The slot, not the gap before it. Dropping a tab onto another tab means "put
 * it here", and the tab that was here shifts toward where the dragged one came
 * from — which is what the bar looks like it is doing while you drag.
 *
 * Returns the input array's contents unchanged when the move is a no-op, so a
 * caller holding it in state can compare identity of the CONTENTS; it always
 * returns a new array, because a state setter returning its own argument is a
 * subtle way to skip a render that a later caller may actually need.
 */
export function moveTab<T>(order: readonly T[], moved: T, target: T): T[] {
  const from = order.indexOf(moved);
  const to = order.indexOf(target);
  // Either end missing means the drag ended somewhere this function has no
  // opinion about — off the bar, or on a tab a different build has. Refusing
  // beats guessing at an index.
  if (from < 0 || to < 0 || from === to) return [...order];

  const next = [...order];
  next.splice(from, 1);
  // `to` is read from the ORIGINAL array on purpose. Removing first shifts
  // everything after `from` left by one, which is exactly the correction needed
  // when dragging rightward: inserting at the original index then lands the tab
  // AFTER the target, where the pointer was. Dragging leftward is unaffected,
  // since indices before `from` do not move.
  next.splice(to, 0, moved);
  return next;
}
