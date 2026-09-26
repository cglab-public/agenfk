/**
 * CGLAB-384 — what a draft flow's steps mean, for the flow editor.
 *
 * The browser cannot import core (it compiles to CommonJS), so the editor
 * asks its server. Both servers answer with this, built from the same
 * functions that validate a flow on save and run its checks on verify, so
 * what the editor shows cannot drift from what is enforced.
 */
import { stepCommitsOnLeave } from './gatekeeper';
import {
  CHECK_CATALOGUE, ROLE_BUILTINS, STEP_ROLES, checkDef, flowChecksErrors, resolveStepChecks,
  type CheckParamDef, type CheckSeverity, type RecordName, type ResolvedCheck, type StepCheckRef, type StepRole,
} from './flowChecks';

export interface FlowContract {
  valid: boolean;
  /** What a save would be refused with, one per problem. */
  errors: string[];
  /**
   * `checks`: the step's own contract. `onLeave`: exactly what verify runs to
   * leave it - the terminal step's checks land on the step before it, and a
   * terminal step is never left (`terminal`). `consumes`: the records its
   * applicable checks read from earlier steps.
   */
  steps: Array<{ name: string; role: string | null; checks: ResolvedCheck[]; onLeave: ResolvedCheck[]; terminal: boolean; produces: RecordName[]; consumes: RecordName[]; commitsOnLeave: 'auto' | 'required' | null }>;
  roles: Array<{ id: StepRole; builtins: StepCheckRef[] }>;
  catalogue: Array<{ id: string; group: string; description: string; defaultSeverity: CheckSeverity; params: Record<string, CheckParamDef>; needsCapture: boolean; unavailable?: string }>;
}

type AnyStep = { name?: unknown; order?: unknown; role?: unknown; checks?: unknown; isAnchor?: unknown; isSpecial?: unknown };

export function describeFlowContract(steps: unknown): FlowContract {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s): s is AnyStep => !!s && typeof s === 'object' && typeof (s as AnyStep).name === 'string')
    .sort((a, b) => Number(a.order) - Number(b.order));
  const errors = flowChecksErrors(list);
  const last = list[list.length - 1] as (AnyStep & { isAnchor?: unknown; isSpecial?: unknown }) | undefined;
  const described = list.map((s, i) => {
    const name = String(s.name);
    const terminal = i === list.length - 1 && !!last && !!(last.isAnchor || last.isSpecial);
    const onLeave = terminal ? [] : resolveStepChecks(list, name);
    // d26832d6 #10: the server holds a card here when the NEXT step's blocking
    // checks judge against the per-test results recorded as the card enters it
    // (entry-baseline), so leaving this step takes a usable baseline too.
    const nextName = list[i + 1]?.name;
    if (!terminal && typeof nextName === 'string' && resolveStepChecks(list, String(nextName)).some(c => c.applicable && c.severity === 'block' && (checkDef(c.id)?.requires(c.params) ?? []).includes('stepEntryTests'))) {
      onLeave.push({ id: 'entry-baseline', step: name, source: 'universal', severity: 'block', params: {}, applicable: true } as ResolvedCheck);
    }
    // A step's own contract: resolveStepChecks also runs the terminal step's
    // checks on the move into it, which belong to the terminal step here.
    const checks = resolveStepChecks(list, name).filter(c => c.step === name || c.source === 'universal');
    const produces = [...new Set(checks.filter(c => c.applicable).flatMap(c => checkDef(c.id)?.produces(c.params) ?? []))];
    const consumes = [...new Set(checks.filter(c => c.applicable).flatMap(c => checkDef(c.id)?.requires(c.params) ?? []).filter(r => r !== 'stepEntryTests'))];
    // CGLAB-388: the same answer the server's commit gives.
    const commitsOnLeave = stepCommitsOnLeave(list as any, name) ?? null;
    return { name, role: typeof s.role === 'string' ? s.role : null, checks, onLeave, terminal, produces, consumes, commitsOnLeave };
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
