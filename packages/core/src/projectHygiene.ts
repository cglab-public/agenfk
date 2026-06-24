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
