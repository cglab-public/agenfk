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
}

/**
 * Returns the name of the coding step (first non-anchor step) from the active
 * flow. Falls back to 'IN_PROGRESS' when no flow is active or the flow has no
 * non-anchor steps.
 */
export function getCodingStepName(activeFlow: GatekeeperFlow | null): string {
  if (!activeFlow) return 'IN_PROGRESS';
  const sorted = [...activeFlow.steps].sort((a, b) => a.order - b.order);
  return sorted.find(s => !s.isAnchor)?.name ?? 'IN_PROGRESS';
}

/**
 * Filters the given items to those currently in the coding step.
 * Comparison is case-insensitive.
 */
export function getCodingStepItems(
  items: GatekeeperItem[],
  codingStepName: string,
): GatekeeperItem[] {
  const upper = codingStepName.toUpperCase();
  return items.filter(i => i.status.toUpperCase() === upper);
}
