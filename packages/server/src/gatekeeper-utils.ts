/**
 * Pure helper functions for workflow_gatekeeper decision logic.
 * Extracted to be unit-testable without an HTTP server.
 */

export interface GatekeeperFlow {
  steps: Array<{ name: string; order: number; isAnchor?: boolean }>;
}

export interface GatekeeperItem {
  id: string;
  status: string;
  type: string;
  title?: string;
  branchName?: string;
  parentId?: string;
}

/** Statuses that are never considered "active working" steps regardless of flow. */
const INACTIVE_STATUSES = new Set(['BLOCKED', 'PAUSED', 'TRASHED', 'ARCHIVED', 'IDEAS']);

/**
 * Returns all items currently in any active working step — i.e. any step that
 * is not an anchor (TODO/DONE) and not a special inactive status.
 *
 * This replaces the old getCodingStepItems approach that was coupled to a single
 * step name, which broke multi-step coding flows (e.g. TDD flows where both
 * 'create_unit_tests' and 'IN_PROGRESS' are valid working steps).
 */
export function getActiveStepItems(
  items: GatekeeperItem[],
  flow: GatekeeperFlow | null,
): GatekeeperItem[] {
  const anchorNames = new Set(
    flow
      ? flow.steps.filter(s => s.isAnchor).map(s => s.name.toUpperCase())
      : ['TODO', 'DONE'],
  );
  return items.filter(i => {
    const upper = i.status.toUpperCase();
    return !anchorNames.has(upper) && !INACTIVE_STATUSES.has(upper);
  });
}

/**
 * Returns true when an item is a STORY that can act as a leaf node:
 * it has a parentId (belongs to an EPIC) and has no active children
 * (TRASHED and ARCHIVED children are ignored).
 *
 * Such stories are allowed to advance in the flow without child TASKs.
 */
export function isLeafStory(
  item: GatekeeperItem & { parentId?: string },
  allItems: Array<GatekeeperItem & { parentId?: string }>,
): boolean {
  if (item.type.toUpperCase() !== 'STORY') return false;
  if (!item.parentId) return false;
  const activeChildren = allItems.filter(
    c => c.parentId === item.id &&
      c.status.toUpperCase() !== 'TRASHED' &&
      c.status.toUpperCase() !== 'ARCHIVED',
  );
  return activeChildren.length === 0;
}

/**
 * @deprecated Use getActiveStepItems instead.
 * Returns the name of the coding step (first non-anchor step) from the active flow.
 */
export function getCodingStepName(activeFlow: GatekeeperFlow | null): string {
  if (!activeFlow) return 'IN_PROGRESS';
  const sorted = [...activeFlow.steps].sort((a, b) => a.order - b.order);
  return sorted.find(s => !s.isAnchor)?.name ?? 'IN_PROGRESS';
}

/**
 * @deprecated Use getActiveStepItems instead.
 * Filters items to those in a specific step by name (case-insensitive).
 */
export function getCodingStepItems(
  items: GatekeeperItem[],
  codingStepName: string,
): GatekeeperItem[] {
  const upper = codingStepName.toUpperCase();
  return items.filter(i => i.status.toUpperCase() === upper);
}
