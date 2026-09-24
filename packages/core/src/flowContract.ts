/**
 * CGLAB-384 — what a draft flow's steps mean, for the flow editor.
 *
 * The browser cannot import core (it compiles to CommonJS), so the editor
 * asks its server. Both servers answer with this, built from the same
 * functions that validate a flow on save and run its checks on verify, so
 * what the editor shows cannot drift from what is enforced.
 */
import {
  CHECK_CATALOGUE, ROLE_BUILTINS, STEP_ROLES, flowChecksErrors, resolveStepChecks,
  type CheckParamDef, type CheckSeverity, type RecordName, type ResolvedCheck, type StepCheckRef, type StepRole,
} from './flowChecks';

export interface FlowContract {
  valid: boolean;
  /** What a save would be refused with, one per problem. */
  errors: string[];
  /** `consumes`: the records its applicable checks read from earlier steps. */
  steps: Array<{ name: string; role: string | null; checks: ResolvedCheck[]; produces: RecordName[]; consumes: RecordName[] }>;
  roles: Array<{ id: StepRole; builtins: StepCheckRef[] }>;
  catalogue: Array<{ id: string; group: string; description: string; defaultSeverity: CheckSeverity; params: Record<string, CheckParamDef>; needsCapture: boolean; unavailable?: string }>;
}

type AnyStep = { name?: unknown; order?: unknown; role?: unknown; checks?: unknown };

export function describeFlowContract(steps: unknown): FlowContract {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s): s is AnyStep => !!s && typeof s === 'object' && typeof (s as AnyStep).name === 'string')
    .sort((a, b) => Number(a.order) - Number(b.order));
  const errors = flowChecksErrors(list);
  const described = list.map(s => {
    const name = String(s.name);
    // A step's own contract: resolveStepChecks also runs the terminal step's
    // checks on the move into it, which belong to the terminal step here.
    const checks = resolveStepChecks(list, name).filter(c => c.step === name || c.source === 'universal');
    const produces = [...new Set(checks.filter(c => c.applicable).flatMap(c => CHECK_CATALOGUE[c.id]?.produces(c.params) ?? []))];
    const consumes = [...new Set(checks.filter(c => c.applicable).flatMap(c => CHECK_CATALOGUE[c.id]?.requires(c.params) ?? []).filter(r => r !== 'stepEntryTests'))];
    return { name, role: typeof s.role === 'string' ? s.role : null, checks, produces, consumes };
  });
  return {
    valid: errors.length === 0,
    errors,
    steps: described,
    roles: STEP_ROLES.map(id => ({ id, builtins: ROLE_BUILTINS[id] })),
    catalogue: Object.values(CHECK_CATALOGUE).map(d => ({
      id: d.id, group: d.group, description: d.description, defaultSeverity: d.defaultSeverity,
      params: d.params, needsCapture: d.needsCapture, ...(d.unavailable ? { unavailable: d.unavailable } : {}),
    })),
  };
}
