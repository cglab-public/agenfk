/**
 * CGLAB-380 — step roles, the check catalogue, and which checks a step runs.
 *
 * A step's NAME says nothing the server can use: a step called WRITE_SPECS may
 * be where tests are written, or not. So a step may carry a ROLE, which brings
 * built-in checks, and extra CHECKS, which a flow adds. A flow can add
 * requirements; it can never take a role's built-ins away.
 *
 * Checks pass state to later steps through named RECORDS, never through step
 * names: `some-new-test-red` produces `redSet`, and `red-set-passes-by-name`
 * requires it. A flow whose check requires a record no EARLIER step produces is
 * refused at save time. A role built-in in that position is simply not
 * applicable - which is how one `coding` role gives the TDD flow its red-set
 * checks and the default flow none.
 *
 * Pure data and functions: the engine that runs the checks lives in the server.
 */

/** One vocabulary with the gatekeeper's advisory `--role`, extended. */
export const STEP_ROLES = ['planning', 'test-authoring', 'coding', 'refactoring', 'review', 'testing', 'closing'] as const;
export type StepRole = typeof STEP_ROLES[number];

export type CheckSeverity = 'block' | 'warn';

/** A check as a flow step lists it. */
export interface StepCheckRef {
  id: string;
  params?: Record<string, unknown>;
  severity?: CheckSeverity;
}

/**
 * What checks hand to later steps.
 * - `stepEntryTests`: the per-test results as the card entered the step. The
 *   ENGINE provides it (the previous step's capture, or one taken on entry), so
 *   it never needs an earlier producer.
 * - `redSet`: the new tests that failed when they were written.
 * - `testSurface`: the hashed test files and runner config as they were then.
 * - `authoredTests`: every test name as the tests were written.
 */
export type RecordName = 'stepEntryTests' | 'redSet' | 'testSurface' | 'authoredTests';
const ENGINE_RECORDS: ReadonlySet<RecordName> = new Set(['stepEntryTests']);

export interface CheckParamDef {
  values: readonly string[];
  default: string;
  description: string;
}

export interface CheckDef {
  id: string;
  group: 'git' | 'tests' | 'review' | 'approvals';
  /** What the check requires, in words the flow editor shows. */
  description: string;
  defaultSeverity: CheckSeverity;
  params: Record<string, CheckParamDef>;
  produces: (params: Record<string, string>) => RecordName[];
  requires: (params: Record<string, string>) => RecordName[];
  /** Needs per-test results (a capture of the test report). */
  needsCapture: boolean;
  /** Set when the check cannot run on this server yet: it is refused at save time. */
  unavailable?: string;
}

const none = () => [] as RecordName[];
const def = (d: Omit<CheckDef, 'params' | 'produces' | 'requires' | 'needsCapture'> & Partial<CheckDef>): CheckDef => ({
  params: {}, produces: none, requires: none, needsCapture: false, ...d,
});

export const CHECK_CATALOGUE: Record<string, CheckDef> = {
  'tree-clean': def({ id: 'tree-clean', group: 'git', defaultSeverity: 'block',
    description: 'The working tree has no uncommitted changes when work starts, so the card begins from a known commit.' }),
  'on-card-branch': def({ id: 'on-card-branch', group: 'git', defaultSeverity: 'block',
    description: "The tree is on the card's own branch, so work never lands on somebody else's." }),
  'jira-key-valid': def({ id: 'jira-key-valid', group: 'git', defaultSeverity: 'block',
    description: 'The card is linked to a JIRA key (PROJ-123) that its branch name can carry.' }),
  'has-children': def({ id: 'has-children', group: 'git', defaultSeverity: 'block',
    description: 'A card of the listed types has been broken down into child cards before work moves on.',
    params: { types: { values: ['EPIC', 'STORY', 'EPIC,STORY'], default: 'EPIC', description: 'Which card types must have children.' } } }),
  'only-test-files-changed': def({ id: 'only-test-files-changed', group: 'tests', defaultSeverity: 'block',
    description: 'Only test files changed in this step: tests are written before the code they test.' }),
  'no-broken-test-files': def({ id: 'no-broken-test-files', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    description: 'Every test file loads. A file that fails to import has no test names, so its tests cannot be tracked.' }),
  'new-tests-exist': def({ id: 'new-tests-exist', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'At least one test was added in this step.' }),
  'some-new-test-red': def({ id: 'some-new-test-red', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    requires: () => ['stepEntryTests'], produces: () => ['redSet', 'testSurface', 'authoredTests'],
    description: 'At least one new test fails before the code exists. Those tests become the red set that must pass later, and the test files are frozen.' }),
  'new-tests-born-green': def({ id: 'new-tests-born-green', group: 'tests', defaultSeverity: 'warn', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'Warns about new tests that already pass: they prove nothing about code not yet written.' }),
  'red-is-assertion': def({ id: 'red-is-assertion', group: 'tests', defaultSeverity: 'warn', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'Warns when a new test fails with an error rather than a failed assertion.' }),
  'existing-tests-still-green': def({ id: 'existing-tests-still-green', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'Tests that passed when the step began still pass.' }),
  'suite-green': def({ id: 'suite-green', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    description: 'The whole test suite passes and every test file loads.' }),
  'red-set-passes-by-name': def({ id: 'red-set-passes-by-name', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    requires: () => ['redSet'],
    description: 'Every test in the red set now passes, under the same name. A skipped or missing test is not a pass.' }),
  'test-surface-frozen': def({ id: 'test-surface-frozen', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    params: {
      mode: { values: ['append', 'strict'], default: 'append', description: 'append: new test files may be added; strict: nothing may change.' },
      since: { values: ['test-authoring', 'step-entry'], default: 'test-authoring', description: 'Compare against the tests as written, or as they were when this step began.' },
    },
    requires: p => [p.since === 'step-entry' ? 'stepEntryTests' : 'testSurface'],
    description: 'Test files and runner config are unchanged, so a failing test cannot be weakened, skipped or deleted.' }),
  'test-count-not-lower': def({ id: 'test-count-not-lower', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    params: { since: { values: ['step-entry', 'test-authoring'], default: 'step-entry', description: 'Compare with the tests as this step began, or as they were written.' } },
    requires: p => [p.since === 'test-authoring' ? 'authoredTests' : 'stepEntryTests'],
    description: 'There are at least as many tests as before: as the step began, or as they were written.' }),
  'test-set-identical': def({ id: 'test-set-identical', group: 'tests', defaultSeverity: 'block', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'The same tests, by name, as when the step began: none added, none removed.' }),
  'review-record': def({ id: 'review-record', group: 'review', defaultSeverity: 'block',
    params: { appliesTo: { values: ['parent', 'every-card'], default: 'parent', description: 'parent: a card with children, or with none above it, needs a review, and its children pass with it; every-card: every card needs its own.' } },
    description: 'An independent reviewer, not the author, recorded a review covering the card\'s commits, and every finding is fixed or rejected with a reason.' }),
  'human-approval': def({ id: 'human-approval', group: 'approvals', defaultSeverity: 'block',
    params: {
      appliesTo: { values: ['parent', 'every-card'], default: 'parent', description: "parent: a card passes with its parent's go-ahead for the same step, so approving a breakdown approves its children; every-card: each card needs its own." },
      signature: { values: ['none', 'passkey'], default: 'none', description: "passkey: the approval, and any override on this step, must be signed with a passkey enrolled on the board (fingerprint, face or PIN), which an agent cannot produce; none: the board's approval is enough." },
    },
    description: 'A person approved in the UI before the card leaves this step. An agent cannot approve.' }),
  'server-owned-verify': def({ id: 'server-owned-verify', group: 'tests', defaultSeverity: 'block',
    description: "The project's own verify command passes. The server runs it; a caller cannot substitute another." }),
};

const ref = (id: string, params?: Record<string, string>): StepCheckRef => (params ? { id, params } : { id });

/** What each role brings. A built-in whose record no earlier step produces is not applicable. */
export const ROLE_BUILTINS: Record<StepRole, StepCheckRef[]> = {
  planning: [],
  'test-authoring': [
    ref('only-test-files-changed'), ref('no-broken-test-files'), ref('new-tests-exist'), ref('some-new-test-red'),
    ref('existing-tests-still-green'), ref('new-tests-born-green'), ref('red-is-assertion'),
  ],
  coding: [
    ref('suite-green'), ref('red-set-passes-by-name'), ref('test-surface-frozen', { mode: 'append', since: 'test-authoring' }),
    ref('test-count-not-lower', { since: 'test-authoring' }),
  ],
  refactoring: [ref('suite-green'), ref('test-set-identical'), ref('test-surface-frozen', { mode: 'strict', since: 'step-entry' })],
  review: [ref('review-record')],
  testing: [ref('suite-green')],
  closing: [ref('server-owned-verify')],
};

export interface ResolvedCheck {
  id: string;
  params: Record<string, string>;
  severity: CheckSeverity;
  source: 'universal' | 'role' | 'flow';
  /** The step whose contract listed it (the terminal step's checks run on the move into it). */
  step: string;
  applicable: boolean;
  /** Records it needs that no earlier step produces (why it is not applicable). */
  missing?: RecordName[];
}

type AnyStep = { name?: unknown; order?: unknown; role?: unknown; checks?: unknown; isAnchor?: unknown; isSpecial?: unknown };

const ordered = <T extends AnyStep>(steps: readonly T[]): T[] =>
  [...steps].sort((a, b) => Number(a.order) - Number(b.order));

const isRole = (r: unknown): r is StepRole => typeof r === 'string' && (STEP_ROLES as readonly string[]).includes(r);

/** Does any step carry a role or a check? A flow with none keeps today's behaviour. */
export function hasStepContracts(steps: readonly AnyStep[]): boolean {
  return steps.some(s => (s.role !== undefined && s.role !== null) || (Array.isArray(s.checks) && s.checks.length > 0));
}

function withDefaults(d: CheckDef, params: unknown): Record<string, string> {
  const given = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(d.params)) out[k] = typeof given[k] === 'string' ? (given[k] as string) : p.default;
  return out;
}

const refsOf = (s: AnyStep): StepCheckRef[] =>
  Array.isArray(s.checks) ? (s.checks as unknown[]).filter((c): c is StepCheckRef => !!c && typeof c === 'object' && typeof (c as any).id === 'string') : [];

/** The step's own contract: role built-ins, then flow extras, in order, with records resolved. */
function contractOf(s: AnyStep, produced: ReadonlySet<RecordName>): ResolvedCheck[] {
  const name = String(s.name);
  const out: ResolvedCheck[] = [];
  const push = (r: StepCheckRef, source: 'role' | 'flow') => {
    const d = CHECK_CATALOGUE[r.id];
    if (!d) return;
    const params = withDefaults(d, r.params);
    const missing = d.requires(params).filter(rec => !ENGINE_RECORDS.has(rec) && !produced.has(rec));
    const severity: CheckSeverity = source === 'flow' && (r.severity === 'warn' || r.severity === 'block') ? r.severity : d.defaultSeverity;
    // A flow extra identical to a built-in runs once; a different one (a
    // stricter mode, a different severity) runs as well. Named by the flow, it
    // is the flow's: a built-in that could not apply is then a save-time error.
    const same = out.find(c => c.id === r.id && c.severity === severity && JSON.stringify(c.params) === JSON.stringify(params));
    if (same) { same.source = source === 'flow' ? 'flow' : same.source; return; }
    out.push({ id: r.id, params, severity, source, step: name, applicable: missing.length === 0, ...(missing.length ? { missing } : {}) });
  };
  if (isRole(s.role)) for (const r of ROLE_BUILTINS[s.role]) push(r, 'role');
  for (const r of refsOf(s)) push(r, 'flow');
  return out;
}

/** Records a step's applicable checks produce. */
const producedBy = (checks: readonly ResolvedCheck[]): RecordName[] =>
  checks.filter(c => c.applicable).flatMap(c => CHECK_CATALOGUE[c.id].produces(c.params));

/**
 * The checks that run when a card LEAVES `stepName`: the universal ones, the
 * step's role built-ins and its flow extras - and, when the next step is the
 * flow's terminal step, that step's checks too, since a terminal step is never
 * left. Empty for a step the flow does not have.
 *
 * Universal: `tree-clean` on leaving the first step (work starts from a known
 * commit - the close commit needs uncommitted work later, so not on every
 * step), and `on-card-branch` on every step. On a flow with no roles or
 * checks at all they only warn: an upgrade must not start blocking cards.
 */
export function resolveStepChecks(steps: readonly AnyStep[], stepName: string): ResolvedCheck[] {
  const list = ordered(steps);
  const index = list.findIndex(s => s.name === stepName);
  if (index === -1) return [];
  const universalSeverity: CheckSeverity = hasStepContracts(list) ? 'block' : 'warn';

  // Each step is resolved against what the steps BEFORE it produce: `produced`
  // only grows after a step's own contract is built.
  const produced = new Set<RecordName>();
  const contracts: ResolvedCheck[][] = [];
  for (const s of list) {
    const c = contractOf(s, produced);
    contracts.push(c);
    for (const r of producedBy(c)) produced.add(r);
  }

  const universal: ResolvedCheck[] = [];
  const u = (id: string) => universal.push({ id, params: {}, severity: universalSeverity, source: 'universal', step: stepName, applicable: true });
  if (index === 0) u('tree-clean');
  u('on-card-branch');

  const out = [...universal, ...contracts[index]];
  const next = list[index + 1];
  if (next && index + 1 === list.length - 1 && (next.isAnchor || next.isSpecial)) {
    for (const c of contracts[index + 1]) if (!out.some(o => o.id === c.id && JSON.stringify(o.params) === JSON.stringify(c.params))) out.push(c);
  }
  return out;
}

/**
 * Save-time validation. Every error names the step and the check, and a
 * missing record names who could produce it. An empty list means valid.
 * Role built-ins are never errors: one that cannot apply simply does not run.
 */
export function flowChecksErrors(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const errors: string[] = [];
  const list = ordered(steps.filter((s): s is AnyStep => !!s && typeof s === 'object'));
  const produced = new Set<RecordName>();
  const producersOf = (rec: RecordName) => Object.values(CHECK_CATALOGUE)
    .filter(d => d.produces(withDefaults(d, {})).includes(rec)).map(d => d.id);

  // The project verify command runs only on the transition that ends the
  // flow: from the last step before a terminal step, or into that terminal
  // step. Anywhere else a check deferred to it would never run.
  const last = list[list.length - 1];
  const endsHere = (i: number) => i === list.length - 1 || (i === list.length - 2 && !!last && !!(last.isAnchor || last.isSpecial));
  for (const [i, s] of list.entries()) {
    const name = String(s.name);
    if (!endsHere(i)) {
      if (s.role === 'closing') errors.push(`Step ${name}: role 'closing' belongs to the step that ends the flow, where the project's verify command runs; here nothing would run it.`);
      if (refsOf(s).some(c => c.id === 'server-owned-verify')) errors.push(`Step ${name}: check 'server-owned-verify' only runs on the transition that ends the flow; here it would never run. Use 'suite-green' to require a green suite on this step.`);
    }
    // CGLAB-388: the step commit flags.
    const flags = s as AnyStep & { autoCommit?: unknown; requireCommit?: unknown };
    for (const k of ['autoCommit', 'requireCommit'] as const) {
      if (flags[k] !== undefined && flags[k] !== null && typeof flags[k] !== 'boolean') errors.push(`Step ${name}: ${k} must be true or false.`);
    }
    if (flags.requireCommit === true && flags.autoCommit !== true) {
      errors.push(`Step ${name}: requireCommit needs autoCommit on: a step can only require the commit it makes.`);
    }
    if (s.role !== undefined && s.role !== null && !isRole(s.role)) {
      errors.push(`Step ${name}: unknown role ${JSON.stringify(s.role)}. Roles: ${STEP_ROLES.join(', ')}.`);
    }
    if (s.checks !== undefined && s.checks !== null) {
      if (!Array.isArray(s.checks)) {
        errors.push(`Step ${name}: checks must be a list of { id, params?, severity? }.`);
      } else {
        for (const c of s.checks as unknown[]) {
          if (!c || typeof c !== 'object' || typeof (c as any).id !== 'string') {
            errors.push(`Step ${name}: each check must be an object with an id, e.g. { "id": "suite-green" }.`);
            continue;
          }
          const r = c as StepCheckRef;
          const d = CHECK_CATALOGUE[r.id];
          if (!d) { errors.push(`Step ${name}: unknown check '${r.id}'.`); continue; }
          if (d.unavailable) { errors.push(`Step ${name}: check '${r.id}' is not available on this server yet (${d.unavailable}).`); continue; }
          if (r.severity !== undefined && r.severity !== 'block' && r.severity !== 'warn') {
            errors.push(`Step ${name}: check '${r.id}' has severity ${JSON.stringify(r.severity)}; use block or warn.`);
          }
          if (r.params !== undefined) {
            if (!r.params || typeof r.params !== 'object' || Array.isArray(r.params)) {
              errors.push(`Step ${name}: check '${r.id}' params must be an object.`);
            } else {
              for (const [k, v] of Object.entries(r.params)) {
                const p = d.params[k];
                if (!p) errors.push(`Step ${name}: check '${r.id}' has no param '${k}'${Object.keys(d.params).length ? ` (params: ${Object.keys(d.params).join(', ')})` : ''}.`);
                else if (typeof v !== 'string' || !p.values.includes(v)) errors.push(`Step ${name}: check '${r.id}' param '${k}' must be one of ${p.values.join(', ')}.`);
              }
            }
          }
        }
      }
    }
    const contract = contractOf(s, produced);
    for (const c of contract) {
      if (c.source !== 'flow' || c.applicable) continue;
      for (const rec of c.missing ?? []) {
        errors.push(`Step ${name}: check '${c.id}' needs the record '${rec}', which no earlier step produces. Add an earlier step that runs ${producersOf(rec).map(p => `'${p}'`).join(' or ')} (a 'test-authoring' step does), or remove the check.`);
      }
    }
    for (const r of producedBy(contract)) produced.add(r);
  }
  return errors;
}

/**
 * PUT semantics for step contracts: a step that OMITS `role` or `checks` keeps
 * the stored value for the step with the same id; an explicit `null` (or an
 * empty list) clears it. An older editor that knows nothing about contracts
 * therefore never wipes one. A step with a new id starts empty.
 */
export function mergeStepContracts<T extends Record<string, any>>(incoming: T[], stored: readonly Record<string, any>[] | undefined): Array<T & { role?: any; checks?: any; autoCommit?: any; requireCommit?: any }> {
  if (!Array.isArray(incoming)) return incoming;
  const byId = new Map((stored ?? []).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  return incoming.map(step => {
    if (!step || typeof step !== 'object') return step;
    const prev = typeof step.id === 'string' ? byId.get(step.id) : undefined;
    const out: Record<string, any> = { ...step };
    for (const k of ['role', 'checks', 'autoCommit', 'requireCommit'] as const) {
      if (!Object.prototype.hasOwnProperty.call(step, k)) {
        if (prev && prev[k] !== undefined && prev[k] !== null) out[k] = prev[k];
      } else if (step[k] === null || (k === 'checks' && Array.isArray(step[k]) && step[k].length === 0)) {
        delete out[k];
      }
    }
    return out as T & { role?: any; checks?: any; autoCommit?: any; requireCommit?: any };
  });
}
