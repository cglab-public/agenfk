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
/**
 * Remember a whole set at once.
 *
 * `toggleExpanded` is per id and flips, which is wrong for opening several
 * projects together: the ones already open would close. This writes the list
 * the caller worked out, and the caller is the one that knows which projects
 * hold running work.
 */
export const writeExpanded = (ids: string[]): void => writeIds(EXPANDED_KEY, ids);
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

const SORT_KEY = 'agenfk_project_sort';

/** How the project list is ordered before pinning is applied. */
export type ProjectSort = 'last-used' | 'created';

const SORTS: ProjectSort[] = ['last-used', 'created'];

/**
 * Default is last-used, not creation date: with a dozen projects the one you
 * touched this morning is the one you are reaching for, and the oldest project
 * is usually the one you care about least.
 */
export function readProjectSort(): ProjectSort {
  try {
    const stored = localStorage.getItem(SORT_KEY);
    return SORTS.includes(stored as ProjectSort) ? (stored as ProjectSort) : 'last-used';
  } catch {
    return 'last-used';
  }
}

export function writeProjectSort(sort: ProjectSort): ProjectSort {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // Losing the preference is a papercut; throwing would blank the sidebar.
  }
  return sort;
}


const LAST_USED_KEY = 'agenfk_project_last_used';
/**
 * Cap on remembered projects. Bounded because this is a leaderboard, not a
 * log: nothing ever deletes an entry when a project is removed, so without a
 * trim the value grows for the life of the install.
 */
const LAST_USED_MAX = 50;

/**
 * `{ projectId: sequence }` for projects opened on this machine.
 *
 * A sequence number, not a timestamp. Date.now() has millisecond granularity,
 * so two opens in quick succession tie and a stable sort then falls back to
 * input order — the list stops responding to what you just clicked. A counter
 * cannot tie, and it is also immune to the clock moving backwards (DST, NTP,
 * a laptop waking in another timezone), which a timestamp is not. Nothing here
 * ever displays the value, so there is no reason for it to be a time.
 */
export function readLastUsed(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed)) {
      // Safe non-negative integers only. A hand-edited 1e308 survives a mere
      // isFinite check, and at that magnitude `highest + 1 === highest`, so the
      // next project opened ties instead of outranking and the poisoned entry
      // sits at the top forever.
      if (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) clean[id] = at;
    }
    return clean;
  } catch {
    // Hostile or truncated JSON must not blank the sidebar.
    return {};
  }
}

/**
 * Record that a project was opened here, now.
 *
 * "Last used" used to sort on Project.updatedAt, which the server writes only
 * when a project's name, description, verifyCommand or flow changes — creating,
 * moving or finishing an item never touches it. So the default sort was
 * indistinguishable from "Created at" on virtually every install. Opening a
 * project is a local act and is recorded locally, which is also the more
 * truthful reading: it is when YOU last worked here, not when someone last
 * renamed the thing.
 */
export function touchProjectUsed(id: string): Record<string, number> {
  const current = readLastUsed();
  const highest = Object.values(current).reduce((max, n) => (n > max ? n : max), 0);
  const next = { ...current, [id]: highest + 1 };
  const entries = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, LAST_USED_MAX);
  const trimmed = Object.fromEntries(entries);
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota or private mode — the order degrades, the sidebar still renders.
  }
  return trimmed;
}

const timeOf = (value: unknown): number => {
  const ms = Date.parse(String(value ?? ''));
  // A project with no usable date sorts last rather than vanishing or
  // poisoning the comparison with NaN.
  return Number.isFinite(ms) ? ms : -Infinity;
};

/** Order a copy of `projects`. Pinning is applied on top of this, not by it. */
export function orderProjects<T extends { id?: unknown; createdAt?: unknown; updatedAt?: unknown }>(
  projects: T[],
  sort: ProjectSort,
): T[] {
  if (sort === 'created') {
    return [...projects].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  }
  // Local open-history first, server updatedAt only as the fallback for
  // projects never opened on this machine — a fresh install still gets a
  // sensible order instead of collapsing to input order. Anything opened here
  // outranks anything not, however new the server thinks the other one is.
  const lastUsed = readLastUsed();
  const rank = (p: T): number => {
    const local = lastUsed[String(p.id ?? '')];
    return typeof local === 'number' ? local : Number.NEGATIVE_INFINITY;
  };
  return [...projects].sort((a, b) => {
    const byLocal = rank(b) - rank(a);
    if (byLocal !== 0 && !Number.isNaN(byLocal)) return byLocal;
    return timeOf(b.updatedAt) - timeOf(a.updatedAt);
  });
}
