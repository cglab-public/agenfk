/**
 * Workflow_gatekeeper decision helpers.
 *
 * The flow-aware core — `getActiveStepItems`, `decideGatekeeperAuthorization`,
 * and the shared types — now lives in `@agenfk/core` so the server and the
 * `agenfk` CLI share one definition of "active working step". This module
 * re-exports it (preserving existing import paths) and keeps the deprecated
 * single-step helpers that only the server's legacy callers reference.
 */

export {
  getActiveStepItems,
  decideGatekeeperAuthorization,
  resolveStepContract,
  renderStepContract,
  INACTIVE_STATUSES,
  type GatekeeperFlow,
  type GatekeeperItem,
  type GatekeeperDecision,
  type GatekeeperDecisionOptions,
} from "@agenfk/core";

import type { GatekeeperFlow, GatekeeperItem } from "@agenfk/core";

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
