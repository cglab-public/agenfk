/**
 * Whether the Admin → Users row for `rowUserId` should expose a Delete
 * action to the currently signed-in admin (`sessionUserId`).
 *
 * The hub backend already returns 400 if an admin tries to delete their
 * own row — this predicate just keeps that always-failing button from
 * being shown in the first place.
 */
export function canDeleteUserRow(rowUserId: string, sessionUserId: string | null | undefined): boolean {
  if (!sessionUserId) return false;
  return rowUserId !== sessionUserId;
}
