/**
 * Reordering the open terminals (e488bcdd).
 *
 * The tab order WAS the order the sessions were opened and could not change.
 * With three or more sessions the tab you want beside the active one can sit
 * at the far end of the strip, and once a split exists the pair that belongs
 * side by side is a person's decision - so expressing order by dragging is
 * the gesture, not a menu.
 *
 * Pure: the caller owns the array. Returns the input unchanged when the move
 * would be a no-op, so React can skip a render.
 */
export function moveInOrder<T extends { id: string }>(
  list: readonly T[],
  id: string,
  overId: string,
  side: 'before' | 'after',
): T[] {
  if (id === overId) return list as T[];
  const from = list.findIndex(entry => entry.id === id);
  if (from === -1) return list as T[];
  if (!list.some(entry => entry.id === overId)) return list as T[];

  const without = [...list];
  const [moved] = without.splice(from, 1);
  // Read the target from the array AFTER the removal: `from` may have been
  // before `overId`, and every later index shifts down by one.
  const at = without.findIndex(entry => entry.id === overId);
  without.splice(side === 'before' ? at : at + 1, 0, moved);
  return without;
}