/**
 * Workflow_gatekeeper decision helpers.
 *
 * The flow-aware core — `getActiveStepItems`, `decideGatekeeperAuthorization`,
 * and the shared types — now lives in `@agenfk/core` so the server and the
 * `agenfk` CLI share one definition of "active working step". This module
 * re-exports it, preserving existing import paths.
 */

export {
  getActiveStepItems,
  isBoundaryStep,
  decideGatekeeperAuthorization,
  resolveStepContract,
  renderStepContract,
  INACTIVE_STATUSES,
  type GatekeeperFlow,
  type GatekeeperItem,
  type GatekeeperDecision,
  type GatekeeperDecisionOptions,
} from "@agenfk/core";
