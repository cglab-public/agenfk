interface AccessRow { id: string; role: string; active: number | boolean }

const isActiveAdmin = (r: AccessRow) => r.role === 'admin' && !!r.active;

/** Whether `row` is the only active admin in `rows`; the hub refuses to demote, switch off or delete it. */
export function isLastActiveAdmin(row: AccessRow, rows: AccessRow[]): boolean {
  return isActiveAdmin(row) && !rows.some(r => r.id !== row.id && isActiveAdmin(r));
}

/**
 * Why the Admin → Users row's role select and Active switch are locked for the
 * signed-in admin, or null when they are usable. Mirrors the hub's refusals on
 * PUT /v1/admin/users/:id (your own row; the last active admin), so the table
 * does not offer a change the server will turn down.
 */
export function userAccessLock(row: AccessRow, sessionUserId: string | null | undefined, rows: AccessRow[]): string | null {
  if (!sessionUserId) return 'Loading who is signed in…';
  if (row.id === sessionUserId) return 'This is your own account; another admin has to change its role or switch it off.';
  if (isLastActiveAdmin(row, rows)) {
    return 'This is the last active admin; make someone else an admin first.';
  }
  return null;
}
