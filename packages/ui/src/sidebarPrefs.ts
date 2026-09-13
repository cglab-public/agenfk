/**
 * Sidebar preferences: pinned projects, expanded folders (CGLAB-172).
 *
 * These belong to the person sitting at this machine, not to the work, so they
 * stay in localStorage and never reach the server — pinning a project on your
 * laptop should not rearrange a teammate's sidebar.
 *
 * That makes storage the entire risk surface. Every read is defensive: a value
 * that is corrupt, hand-edited, or written by an older version degrades to
 * "nothing pinned" rather than throwing, because the alternative is a blank
 * sidebar with no way for the user to understand why.
 */

const PINNED_KEY = 'agenfk_pinned_projects';
const EXPANDED_KEY = 'agenfk_expanded_projects';

/** Read a stored array of ids, tolerating anything that is not one. */
function readIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    // Deduped: a hand-edited or corrupt value with a repeated id would
    // otherwise render the same project twice, with duplicate React keys.
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string'))];
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Private browsing, or quota exceeded. Losing a preference is a papercut;
    // throwing from here would take the sidebar down with it.
  }
}

/** Toggle membership, appending so pin order reflects when it was pinned. */
function toggleId(key: string, id: string): string[] {
  const current = readIds(key);
  const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
  writeIds(key, next);
  return next;
}

export const readPinned = (): string[] => readIds(PINNED_KEY);
export const togglePinned = (id: string): string[] => toggleId(PINNED_KEY, id);
export const isPinned = (id: string): boolean => readPinned().includes(id);

export const readExpanded = (): string[] => readIds(EXPANDED_KEY);
export const toggleExpanded = (id: string): string[] => toggleId(EXPANDED_KEY, id);
export const isExpanded = (id: string): boolean => readExpanded().includes(id);

/**
 * Pinned projects first, in the order they were pinned; everything else keeps
 * its original order. Pins for projects that no longer exist are skipped
 * rather than producing an empty row, and the input array is never mutated.
 */
export function sortProjectsByPin<T extends { id: string }>(projects: T[], pinned: string[]): T[] {
  const byId = new Map(projects.map(p => [p.id, p]));
  // Deduped here too, not only on read: this function produces the list that
  // gets rendered, and a caller passing repeats would otherwise emit the same
  // project twice with duplicate React keys.
  const top = [...new Set(pinned)]
    .map(id => byId.get(id))
    .filter((p): p is T => p !== undefined);
  const topIds = new Set(top.map(p => p.id));
  return [...top, ...projects.filter(p => !topIds.has(p.id))];
}
