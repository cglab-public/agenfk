/**
 * CGLAB-385 — a flow's step contract travels to the registry with it.
 *
 * Every publish path (the hub's pull request, this machine's gh push, the
 * CLI) used to keep only a step's name, label, order and exit criteria, so
 * publishing a flow quietly dropped its roles and checks. And an older agenfk
 * strips the fields it does not know before it publishes: its copy must never
 * replace a registry flow that has a contract.
 */

type AnyStep = { role?: unknown; checks?: unknown; [k: string]: unknown };

/** The contract fields a registry step carries: only the ones the step has. */
export function stepContractFields(step: AnyStep): { role?: string; checks?: unknown[]; autoCommit?: true; requireCommit?: true } {
  return {
    ...(typeof step?.role === 'string' && step.role ? { role: step.role } : {}),
    ...(Array.isArray(step?.checks) && step.checks.length ? { checks: step.checks } : {}),
    // CGLAB-388: the step commit flags are part of the step's contract too.
    ...(step?.autoCommit === true ? { autoCommit: true as const } : {}),
    ...(step?.requireCommit === true ? { requireCommit: true as const } : {}),
  };
}

/** Contract fields a step would be written to the registry with, as a comparable key set. */
const contractOf = (s: AnyStep | undefined) => {
  const c = s && typeof s === 'object' ? stepContractFields(s) : {};
  return { role: !!c.role, checks: !!c.checks, autoCommit: !!c.autoCommit, requireCommit: !!c.requireCommit };
};
const anyContract = (steps: AnyStep[]) => steps.some(s => Object.values(contractOf(s)).some(Boolean));
const stepName = (s: AnyStep) => (typeof s?.name === 'string' ? s.name : '');

/**
 * Would this publish drop a registry step's contract (role, checks, commit
 * flags)? Judged on the incoming steps as they would be written.
 *
 * Two rules. A publish with no contract at all over a registry flow that has
 * one is refused whatever its step names: that is exactly what an older agenfk
 * sends, and renaming the one contract step must not slip it through. Then,
 * step by step (names matched exactly, as the check engine does): a step that
 * is still there must keep each contract field it had. A step the publish no
 * longer has was removed or renamed on purpose, which is a structural edit.
 * A deliberate removal of the rest has its own escape: allowContractRemoval.
 */
export function wouldStripContracts(registrySteps: unknown, incomingSteps: unknown): boolean {
  const reg = (Array.isArray(registrySteps) ? (registrySteps as AnyStep[]) : []).filter(s => s && typeof s === 'object');
  const inc = (Array.isArray(incomingSteps) ? (incomingSteps as AnyStep[]) : []).filter(s => s && typeof s === 'object');
  if (anyContract(reg) && !anyContract(inc)) return true;
  const byName = new Map<string, AnyStep[]>();
  for (const s of inc) byName.set(stepName(s), [...(byName.get(stepName(s)) ?? []), s]);
  return reg.some(r => {
    const now = byName.get(stepName(r));
    if (!now) return false;
    const had = contractOf(r);
    // A duplicate name keeps the field if any step of that name does.
    const has = now.map(contractOf);
    return (Object.keys(had) as (keyof typeof had)[]).some(k => had[k] && !has.some(h => h[k]));
  });
}

/** Step fields a registry flow may bring along, beside name/label/order/exitCriteria. Never `command`. */
const CARRIED_FIELDS = ['role', 'checks', 'autoCommit', 'requireCommit', 'color', 'icon'] as const;
const carried = (s: AnyStep | undefined) => {
  const out: Record<string, unknown> = {};
  if (!s || typeof s !== 'object') return out;
  // Passed through as given, even when invalid: the caller validates the
  // result and refuses the flow whole, rather than installing it with parts dropped.
  for (const k of CARRIED_FIELDS) if (s[k] !== undefined) out[k] = s[k];
  return out;
};
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * The steps a registry flow installs as. Every install path (this machine's
 * public-registry install, the hub's install for a connected installation, the
 * hub admin install) builds them here, so a flow behaves the same however it
 * arrived and none of them strips its contract. The registry's anchors are
 * replaced by fresh TODO/DONE anchors, which keep the contract the registry's
 * anchors had (a DONE step with role 'closing', say).
 */
export function registryInstallSteps(rawSteps: unknown, newId: () => string): any[] {
  const raw = (Array.isArray(rawSteps) ? rawSteps : []).filter((s): s is AnyStep => !!s && typeof s === 'object');
  const isTodo = (s: AnyStep) => stepName(s).toUpperCase() === 'TODO';
  const isDone = (s: AnyStep) => stepName(s).toUpperCase() === 'DONE';
  const middle = raw
    .filter(s => !s.isAnchor && !isTodo(s) && !isDone(s))
    .map((s, i) => ({
      id: newId(),
      // `??` does not catch '': an empty name is the value flowStepsError rejects.
      name: nonEmpty(s.name) ? s.name : `step-${i}`,
      label: nonEmpty(s.label) ? s.label : (nonEmpty(s.name) ? s.name : `Step ${i + 1}`),
      order: i + 1,
      exitCriteria: typeof s.exitCriteria === 'string' ? s.exitCriteria : '',
      isSpecial: s.isSpecial === true,
      ...carried(s),
    }));
  const todo = raw.find(isTodo);
  const done = raw.find(isDone);
  return [
    { id: newId(), name: 'TODO', label: 'To Do', order: 0, exitCriteria: '', isAnchor: true, ...carried(todo) },
    ...middle,
    { id: newId(), name: 'DONE', label: 'Done', order: middle.length + 1, exitCriteria: '', isAnchor: true, ...carried(done) },
  ];
}

export const STRIPPED_PUBLISH_MESSAGE =
  'The registry copy of this flow has step roles, checks or commit settings that this publish drops - it was probably saved by an older agenfk, which drops fields it does not know. '
  + 'Upgrade agenfk (agenfk upgrade), install the registry version, and publish again, or publish it under a new name. '
  + 'If you are removing them on purpose, publish with: agenfk flow publish <id> --allow-removing-checks';
