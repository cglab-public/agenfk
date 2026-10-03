/**
 * Project data-hygiene helpers.
 *
 * Multiple AgEnFK projects pointing at the same `projectRoot` make
 * `findProjectId(cwd)` fragile and lead to items being tracked against the
 * "wrong" project for a directory. `findDuplicateProjectRoots` surfaces those
 * collisions (e.g. in `agenfk health`) so they can be cleaned up.
 */

export interface ProjectRootInfo {
  id: string;
  name: string;
  projectRoot?: string | null;
}

export interface DuplicateRootGroup<T extends ProjectRootInfo = ProjectRootInfo> {
  projectRoot: string;
  projects: T[];
}

/** Normalize a root for comparison: trim, drop a single trailing slash. */
function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Returns groups of projects that share the same (normalized, non-empty)
 * projectRoot. Projects without a projectRoot are ignored. Each returned group
 * has 2+ projects.
 */
export function findDuplicateProjectRoots<T extends ProjectRootInfo>(
  projects: T[],
): DuplicateRootGroup<T>[] {
  const byRoot = new Map<string, T[]>();
  for (const p of projects) {
    if (!p.projectRoot) continue;
    const key = normalizeRoot(p.projectRoot);
    if (!key) continue;
    const arr = byRoot.get(key) ?? [];
    arr.push(p);
    byRoot.set(key, arr);
  }
  const groups: DuplicateRootGroup<T>[] = [];
  for (const [projectRoot, group] of byRoot) {
    if (group.length > 1) groups.push({ projectRoot, projects: group });
  }
  return groups;
}

/**
 * Is this a directory we are willing to record as a project's root?
 *
 * `projectRoot` is the directory a worktree is cut from and the cwd that
 * `git add -A && git commit` runs in. A project rooted at $HOME points both at
 * the user's private files, and that is not hypothetical: `findProjectRoot`
 * walks up looking for a `.agenfk` directory and `~/.agenfk` exists, so
 * `agenfk verify` run from anywhere under $HOME with no closer `.agenfk`
 * resolves to $HOME — which is how four projects on one machine came to share
 * it.
 *
 * Refused rather than corrected: there is no defensible guess at what the user
 * meant, and recording "somewhere plausible" is how this happened.
 */
export function isPersistableProjectRoot(root: string | null | undefined, homeDir: string): boolean {
  if (typeof root !== 'string' || !root.trim()) return false;
  // Normalised so a trailing slash or a `.` segment cannot walk around the
  // comparison: they name the same directory, and a guard that can be missed
  // by accident is not a guard.
  const normalise = (p: string): string => {
    const collapsed = p.replace(/\/+/g, '/').replace(/\/\.(?=\/|$)/g, '');
    return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
  };
  const candidate = normalise(root.trim());
  const home = normalise(homeDir);
  if (candidate === '/' || candidate === '') return false;
  if (candidate === home) return false;
  // ~/.agenfk is precisely what the walk-up finds. Recording it would point a
  // worktree at the framework's own state.
  if (candidate === `${home}/.agenfk`) return false;
  return true;
}
