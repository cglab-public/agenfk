/**
 * CGLAB-385 — a flow's step contract travels to the registry with it.
 *
 * Every publish path (the hub's pull request, this machine's gh push, the
 * CLI) used to keep only a step's name, label, order and exit criteria, so
 * publishing a flow quietly dropped its roles and checks. And an older agenfk
 * strips the fields it does not know before it publishes: its copy must never
 * replace a registry flow that has a contract.
 */
import { hasStepContracts } from './flowChecks';

type AnyStep = { role?: unknown; checks?: unknown; [k: string]: unknown };

/** The contract fields a registry step carries: only the ones the step has. */
export function stepContractFields(step: AnyStep): { role?: string; checks?: unknown[] } {
  return {
    ...(typeof step?.role === 'string' && step.role ? { role: step.role } : {}),
    ...(Array.isArray(step?.checks) && step.checks.length ? { checks: step.checks } : {}),
  };
}

/** Would this publish replace a registry flow that has a step contract with one that has none? */
export function wouldStripContracts(registrySteps: unknown, incomingSteps: unknown): boolean {
  const reg = Array.isArray(registrySteps) ? (registrySteps as AnyStep[]) : [];
  const inc = Array.isArray(incomingSteps) ? (incomingSteps as AnyStep[]) : [];
  return hasStepContracts(reg as any) && !hasStepContracts(inc as any);
}

export const STRIPPED_PUBLISH_MESSAGE =
  'The registry copy of this flow has step roles and checks, and this publish has none - it was probably saved by an older agenfk, which drops fields it does not know. '
  + 'Publishing it would remove them from the registry. Upgrade agenfk (agenfk upgrade), install the registry version, and publish again - or publish it under a new name.';
