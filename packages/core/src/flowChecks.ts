/**
 * CGLAB-380 — step roles, the check catalogue, and which checks a step runs.
 *
 * A step's NAME says nothing the server can use: a step called WRITE_SPECS may
 * be where tests are written, or not. So a step may carry a ROLE, which brings
 * built-in checks, and extra CHECKS, which a flow adds. A flow can add
 * requirements; it can never take a role's built-ins away. Only the org's hub
 * may switch a check off (`disabledChecks`, CGLAB-428).
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
import { leavingEndsFlow } from './gatekeeper';

/** One vocabulary with the gatekeeper's advisory `--role`, extended. */
export const STEP_ROLES = ['backlog', 'planning', 'test-authoring', 'coding', 'refactoring', 'review', 'testing', 'closing'] as const;
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
  /**
   * What the param holds (efcacdeb): one of `values` (enum, the default), a
   * name slug, an argv list (carried to the engine as its JSON), or free text.
   */
  kind?: 'enum' | 'name' | 'argv' | 'text';
  /** Must be given: there is no sensible default (a custom check's name, argv or instruction). */
  required?: boolean;
}

export interface CheckDef {
  id: string;
  group: 'git' | 'tests' | 'review' | 'approvals' | 'custom';
  /** What the check requires, in words the flow editor shows. */
  description: string;
  defaultSeverity: CheckSeverity;
  params: Record<string, CheckParamDef>;
  produces: (params: Record<string, string>) => RecordName[];
  requires: (params: Record<string, string>) => RecordName[];
  /** Needs per-test results (a capture of the test report). */
  needsCapture: boolean;
  /** Talks to a remote (1049ce52): slow, so it waits behind a person's approval like a capture. */
  network?: boolean;
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
  'tree-in-sync': def({ id: 'tree-in-sync', group: 'git', defaultSeverity: 'block', network: true,
    description: "The card's tree is in sync with its remote when work starts - not behind it, not diverged from it - so work is never built on stale code. Ahead (unpushed work) is fine; a tree with no remote passes; an unreachable remote only warns." }),
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
    description: 'At least one new test fails before the code exists. Those tests become the red set that must pass later; the test files as written are recorded, for a step that freezes them (test-surface-frozen).' }),
  'new-tests-born-green': def({ id: 'new-tests-born-green', group: 'tests', defaultSeverity: 'warn', needsCapture: true,
    requires: () => ['stepEntryTests'],
    description: 'Warns about new tests that already pass: they prove nothing about code not yet written.' }),
  // d26832d6 #21: no capture, so no suite run - it reads git against the head the tests were frozen at.
  'tests-added-late': def({ id: 'tests-added-late', group: 'tests', defaultSeverity: 'warn', needsCapture: false,
    requires: () => ['testSurface'],
    description: 'Warns about test files added after the step that writes tests froze them: nothing has shown they fail without the change. Runs no suite.' }),
  // CGLAB-420: the fixes to a review's findings, written after the reviewer read the diff. No suite.
  'fixes-reviewed': def({ id: 'fixes-reviewed', group: 'review', defaultSeverity: 'warn', needsCapture: false,
    description: 'Warns when the card changed more than a few lines after its reviewer began: the fixes to its findings, which the review cannot have read. Judged from file times when the review is recorded. Runs no suite.' }),
  // CGLAB-420: a child's warning never reached the parent's reviewer. No suite: it reads the tree's exit records.
  'tree-warnings': def({ id: 'tree-warnings', group: 'review', defaultSeverity: 'warn', needsCapture: false,
    description: "Lists the warnings the card and its children left their steps with, and each answer, so the reviewer sees them. Runs no suite." }),
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
  // efcacdeb — custom checks, named so a step can carry several.
  'command-check': def({ id: 'command-check', group: 'custom', defaultSeverity: 'block',
    params: {
      name: { kind: 'name', required: true, values: [], default: '', description: 'A short name for the check (lint, types): it tells two custom checks on one step apart.' },
      argv: { kind: 'argv', required: true, values: [], default: '', description: 'The command, as a list: the program and each argument, run without a shell in the card\'s tree. It passes on exit code 0.' },
      approval: { values: ['none', 'person'], default: 'none', description: "none: it runs as the flow defines it; person: this exact command runs only after a person approves it on the board with a passkey, and any change to it asks again." },
      share: { values: ['tree', 'none'], default: 'tree', description: "tree: a pass is shared, for ten minutes, by the project's cards that reach it at the same HEAD, index and file content, so the command runs once; none: it runs for every card - for a command that reads something outside the tree (a remote, a PR, the network, the clock)." },
    },
    description: "A command the flow defines, which the server runs in the card's tree: it passes when the command exits 0. Only flows from the org's hub or made on this machine may carry one." }),
  'agent-check': def({ id: 'agent-check', group: 'custom', defaultSeverity: 'block',
    params: {
      name: { kind: 'name', required: true, values: [], default: '', description: 'A short name for the check (docs, changelog): it tells two custom checks on one step apart.' },
      instruction: { kind: 'text', required: true, values: [], default: '', description: 'What the coding agent must do or check before the card may leave the step.' },
    },
    description: 'An instruction the coding agent carries out and reports as passed or failed when it verifies. Its result is labelled agent-reported: the server did not check it.' }),
  'server-owned-verify': def({ id: 'server-owned-verify', group: 'tests', defaultSeverity: 'block',
    description: "The project's own verify command passes. The server runs it; a caller cannot substitute another." }),
};

const ref = (id: string, params?: Record<string, string>): StepCheckRef => (params ? { id, params } : { id });

/** What each role brings. A built-in whose record no earlier step produces is not applicable. */
export const ROLE_BUILTINS: Record<StepRole, StepCheckRef[]> = {
  // 1049ce52: a card leaves the backlog only from a tree in sync with its remote.
  backlog: [ref('tree-in-sync')],
  planning: [],
  'test-authoring': [
    ref('only-test-files-changed'), ref('no-broken-test-files'), ref('new-tests-exist'), ref('some-new-test-red'),
    ref('existing-tests-still-green'), ref('new-tests-born-green'), ref('red-is-assertion'),
  ],
  coding: [
    // No test-surface-frozen here (user 2026-09-25): implementing a behaviour change may rightly change the
    // existing tests that pin the old behaviour. Refactoring keeps it - behaviour must not change there.
    ref('suite-green'), ref('red-set-passes-by-name'),
    ref('test-count-not-lower', { since: 'test-authoring' }),
  ],
  refactoring: [ref('suite-green'), ref('test-set-identical'), ref('test-surface-frozen', { mode: 'strict', since: 'step-entry' })],
  review: [ref('review-record'), ref('fixes-reviewed'), ref('tests-added-late'), ref('tree-warnings')],
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

type AnyStep = { name?: unknown; order?: unknown; role?: unknown; checks?: unknown; disabledChecks?: unknown; isAnchor?: unknown; isSpecial?: unknown };

/**
 * CGLAB-428: checks `disabledChecks` can never switch off, refused at save time
 * and ignored should a flow carry them anyway. A human approval gate has its
 * own setting on the step. The project's verify command runs on the move that
 * ends the flow whatever the step lists (review: switching it off changed
 * nothing, while the record said it had not run).
 */
export const NEVER_DISABLED: ReadonlySet<string> = new Set(['human-approval', 'server-owned-verify']);

/** The resolved check ids a step switches off (CGLAB-428): only a hub-delivered flow can carry any. */
const disabledOf = (s: AnyStep | undefined): Set<string> =>
  new Set(s && Array.isArray(s.disabledChecks) ? (s.disabledChecks as unknown[]).filter((x): x is string => typeof x === 'string' && !NEVER_DISABLED.has(x)) : []);

const ordered = <T extends AnyStep>(steps: readonly T[]): T[] =>
  [...steps].sort((a, b) => Number(a.order) - Number(b.order));

const isRole = (r: unknown): r is StepRole => typeof r === 'string' && (STEP_ROLES as readonly string[]).includes(r);

/** Does any step carry a role or a check? A flow with none keeps today's behaviour. */
export function hasStepContracts(steps: readonly AnyStep[]): boolean {
  return steps.some(s => (s.role !== undefined && s.role !== null) || (Array.isArray(s.checks) && s.checks.length > 0));
}

/** The catalogue entry behind a resolved check id: a custom check resolves as `<id>:<name>`. */
export function checkDef(id: string): CheckDef | undefined {
  if (Object.prototype.hasOwnProperty.call(CHECK_CATALOGUE, id)) return CHECK_CATALOGUE[id];
  const base = id.split(':')[0];
  return base !== id && Object.prototype.hasOwnProperty.call(CHECK_CATALOGUE, base) ? CHECK_CATALOGUE[base] : undefined;
}

/** Params as the engine reads them: strings, an argv list as its JSON. */
function withDefaults(d: CheckDef, params: unknown): Record<string, string> {
  const given = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(d.params)) {
    const v = given[k];
    out[k] = p.kind === 'argv' ? (Array.isArray(v) ? JSON.stringify(v) : p.default) : typeof v === 'string' ? v : p.default;
  }
  return out;
}

/** A custom check resolves under its name, so two on one step - and their overrides - stay apart. */
const resolvedId = (d: CheckDef, params: Record<string, string>) => (d.params.name?.kind === 'name' && params.name ? `${d.id}:${params.name}` : d.id);

/** Why a param's value is refused, or null. */
function paramError(p: CheckParamDef, v: unknown): string | null {
  switch (p.kind ?? 'enum') {
    case 'name':
      return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? null : 'must be a short name: lowercase letters, digits and dashes (e.g. lint)';
    case 'argv':
      return Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(a => typeof a === 'string' && a.length > 0 && a.length <= 4096)
        ? null : 'must be a list: the program and each argument as a string, e.g. ["npm", "run", "lint"] (no shell line)';
    case 'text':
      return typeof v === 'string' && v.trim().length > 0 && v.length <= 4000 ? null : 'must be a non-empty text of at most 4000 characters';
    default:
      return typeof v === 'string' && p.values.includes(v) ? null : `must be one of ${p.values.join(', ')}`;
  }
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
    const id = resolvedId(d, params);
    const missing = d.requires(params).filter(rec => !ENGINE_RECORDS.has(rec) && !produced.has(rec));
    const severity: CheckSeverity = source === 'flow' && (r.severity === 'warn' || r.severity === 'block') ? r.severity : d.defaultSeverity;
    // A flow extra identical to a built-in runs once; a different one (a
    // stricter mode, a different severity) runs as well. Named by the flow, it
    // is the flow's: a built-in that could not apply is then a save-time error.
    const same = out.find(c => c.id === id && c.severity === severity && JSON.stringify(c.params) === JSON.stringify(params));
    if (same) { same.source = source === 'flow' ? 'flow' : same.source; return; }
    out.push({ id, params, severity, source, step: name, applicable: missing.length === 0, ...(missing.length ? { missing } : {}) });
  };
  if (isRole(s.role)) for (const r of ROLE_BUILTINS[s.role]) push(r, 'role');
  for (const r of refsOf(s)) push(r, 'flow');
  return out;
}

/** Records a step's applicable checks produce. */
const producedBy = (checks: readonly ResolvedCheck[]): RecordName[] =>
  checks.filter(c => c.applicable).flatMap(c => checkDef(c.id)?.produces(c.params) ?? []);

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
  return splitStepChecks(steps, stepName).on;
}

/**
 * CGLAB-428: the checks leaving `stepName` would run but the flow switched off
 * (`disabledChecks`), so they can be shown rather than silently vanish.
 * Together with resolveStepChecks, every check the step would otherwise run.
 */
export function disabledStepChecks(steps: readonly AnyStep[], stepName: string): ResolvedCheck[] {
  return splitStepChecks(steps, stepName).off;
}

function splitStepChecks(steps: readonly AnyStep[], stepName: string): { on: ResolvedCheck[]; off: ResolvedCheck[] } {
  const list = ordered(steps);
  const index = list.findIndex(s => s.name === stepName);
  if (index === -1) return { on: [], off: [] };
  const universalSeverity: CheckSeverity = hasStepContracts(list) ? 'block' : 'warn';

  // Each step is resolved against what the steps BEFORE it produce: `produced`
  // only grows after a step's own contract is built. A disabled check does not
  // run, so it produces nothing.
  const produced = new Set<RecordName>();
  const contracts: Array<{ on: ResolvedCheck[]; off: ResolvedCheck[] }> = [];
  for (const s of list) {
    const off = disabledOf(s);
    const c = contractOf(s, produced);
    const split = { on: c.filter(x => !off.has(x.id)), off: c.filter(x => off.has(x.id)) };
    contracts.push(split);
    for (const r of producedBy(split.on)) produced.add(r);
  }

  const universal: ResolvedCheck[] = [];
  const u = (id: string) => universal.push({ id, params: {}, severity: universalSeverity, source: 'universal', step: stepName, applicable: true });
  if (index === 0) u('tree-clean');
  u('on-card-branch');
  const offHere = disabledOf(list[index]);

  const on = [...universal.filter(c => !offHere.has(c.id)), ...contracts[index].on];
  const off = [...universal.filter(c => offHere.has(c.id)), ...contracts[index].off];
  const next = list[index + 1];
  if (next && index + 1 === list.length - 1 && (next.isAnchor || next.isSpecial)) {
    const same = (a: ResolvedCheck, b: ResolvedCheck) => a.id === b.id && JSON.stringify(a.params) === JSON.stringify(b.params);
    for (const c of contracts[index + 1].on) if (!on.some(o => same(o, c))) on.push(c);
    for (const c of contracts[index + 1].off) if (!on.some(o => same(o, c)) && !off.some(o => same(o, c))) off.push(c);
  }
  // Review: a check the terminal step runs as well is not "switched off" here, since it runs.
  return { on, off: off.filter(c => !on.some(o => o.id === c.id && JSON.stringify(o.params) === JSON.stringify(c.params))) };
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
    // Leaving this step ends the flow, and the close commit takes the card's
    // work: a step commit here would never run, so the flag would do nothing.
    if ((endsHere(i) || leavingEndsFlow(list as Array<{ name: string; isAnchor?: boolean; isSpecial?: boolean }>, i)) && (flags.autoCommit === true || flags.requireCommit === true)) {
      errors.push(`Step ${name}: auto commit has no effect here: leaving this step ends the flow, and the close commit covers its work. Turn it off, or set it on an earlier step.`);
    }
    if (s.role !== undefined && s.role !== null && !isRole(s.role)) {
      errors.push(`Step ${name}: unknown role ${JSON.stringify(s.role)}. Roles: ${STEP_ROLES.join(', ')}.`);
    }
    if (s.checks !== undefined && s.checks !== null) {
      if (!Array.isArray(s.checks)) {
        errors.push(`Step ${name}: checks must be a list of { id, params?, severity? }.`);
      } else {
        const named = new Set<string>();
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
                if (!p) { errors.push(`Step ${name}: check '${r.id}' has no param '${k}'${Object.keys(d.params).length ? ` (params: ${Object.keys(d.params).join(', ')})` : ''}.`); continue; }
                const why = paramError(p, v);
                if (why) errors.push(`Step ${name}: check '${r.id}' param '${k}' ${why}.`);
              }
            }
          }
          // efcacdeb: a custom check's name, argv or instruction has no default.
          const given = r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? (r.params as Record<string, unknown>) : {};
          for (const [k, p] of Object.entries(d.params)) {
            if (p.required && given[k] === undefined) errors.push(`Step ${name}: check '${r.id}' needs the param '${k}': ${p.description}`);
          }
          if (d.params.name?.kind === 'name' && typeof given.name === 'string') {
            const key = `${r.id}:${given.name}`;
            if (named.has(key)) errors.push(`Step ${name}: check '${r.id}' named '${given.name}' is there more than once; give each its own name.`);
            named.add(key);
          }
        }
      }
    }
    const full = contractOf(s, produced);
    // CGLAB-428: what the step switches off must be a check it runs.
    // A terminal step is never left, so the universal checks never run on it (review).
    const terminal = i === list.length - 1 && !!(s.isAnchor || s.isSpecial);
    const runs = new Set([...(terminal ? [] : [...(i === 0 ? ['tree-clean'] : []), 'on-card-branch']), ...full.map(c => c.id)]);
    if (s.disabledChecks !== undefined && s.disabledChecks !== null) {
      if (!Array.isArray(s.disabledChecks) || !(s.disabledChecks as unknown[]).every(x => typeof x === 'string')) {
        errors.push(`Step ${name}: disabledChecks must be a list of check ids, e.g. ["new-tests-born-green"].`);
      } else {
        for (const id of s.disabledChecks as string[]) {
          if (NEVER_DISABLED.has(id)) errors.push(id === 'human-approval'
            ? `Step ${name}: check '${id}' cannot be disabled; a human approval is switched on or off by the step's own approval setting.`
            : `Step ${name}: check '${id}' cannot be disabled; the project's verify command always runs on the move that ends the flow.`);
          else if (!checkDef(id)) errors.push(`Step ${name}: disabledChecks names an unknown check '${id}'.`);
          else if (!runs.has(id)) errors.push(`Step ${name}: disabledChecks names '${id}', which this step does not run.`);
        }
      }
    }
    const off = disabledOf(s);
    const contract = full.filter(c => !off.has(c.id));
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

/** A step whose words ask for something its checks do not enforce (CGLAB-457). */
export interface FlowContractWarning {
  /** The step; null for a warning about the whole flow. */
  step: string | null;
  kind: 'review' | 'approval' | 'no-contracts';
  message: string;
}

// An independent review, however a flow words it - "review it in a separate adversarial agent", "an
// independent reviewer", "reviewed independently", "a second pair of eyes" - within one clause, and naming
// a review: "a separate agent per task" is not one, nor is "a separate test step".
const QUALIFIER = String.raw`\b(?:independent|independently|adversarial|separate|outside|peer|second[- ]pair)\b`;
const REVIEW_NOUN = String.raw`\b(?:review|reviews|reviewed|reviewer|reviewers)\b`;
// "Review ... in a separate agent" counts only when the qualifier names who reviews - not "a separate test step".
const REVIEWER = String.raw`\b(?:agent|agents|reviewer|reviewers|model|models|session|engineer|engineers|person|people|party|parties|someone|somebody)\b`;
const ASKS_REVIEW = new RegExp([
  `${QUALIFIER}[^.,;]{0,60}${REVIEW_NOUN}`, // "an independent review", "a separate reviewer"
  `${REVIEW_NOUN}[^.,;]{0,60}${QUALIFIER}[^.,;]{0,30}${REVIEWER}`, // "review it in a separate agent"
  `${REVIEW_NOUN}[^.,;]{0,40}${REVIEWER}[^.,;]{0,20}${QUALIFIER}`, // "reviewed by someone independent"
  `${REVIEW_NOUN}[^.,;]{0,15}\\bindependently\\b`, // "reviewed independently"
  `\\bindependently\\b[^.,;]{0,40}${REVIEW_NOUN}`, // "independently review"
  `${REVIEW_NOUN}\\s+(?:must|should|needs?\\s+to|has\\s+to|is|are|be)\\s+(?:be\\s+)?(?:an?\\s+)?${QUALIFIER}`, // "the reviewer must be independent"
  String.raw`\bsecond\s+pair\s+of\s+eyes\b`, // the idiom, not naming a review
].join('|'), 'i');
// A step named for review: REVIEW, CODE_REVIEW, CodeReview, PeerReview - not PREVIEW or OVERVIEW (the 'p' before it).
const REVIEW_NAME = /(?<![Pp])review/i;
// A person's go-ahead: "the user must give you the go-ahead", "a human signs off" - not "developer-approved", and
// not "ask the user to confirm the key", which asks for information.
const ASKS_APPROVAL = /\b(?:user|person|human|developer)(?:'s)?\s[^.,;]{0,60}\b(?:go-ahead|approv\w*|sign(?:s|ed)?[- ]off)\b|\bgo-ahead\b/i;
// ...and not where the sentence says none is needed - "no approval is needed", "approval is not required",
// "without waiting for approval". A demand worded with a negation ("do not proceed until...") still asks.
const APPROVAL_WORD = String.raw`(?:approv\w*|go-ahead|sign[- ]off)`;
const DENIES_APPROVAL = new RegExp([
  String.raw`\bno\b[^.,;]{0,30}\b${APPROVAL_WORD}[^.,;]{0,20}\b(?:is|are)\s+(?:needed|required|necessary)\b`,
  String.raw`\b${APPROVAL_WORD}\s+(?:is|are)\s+not\s+(?:needed|required|necessary)\b`,
  // "without waiting for approval" - not "without the user's approval", which demands it.
  String.raw`\bwithout\s+(?:needing|waiting\s+for|asking\s+for|requiring)\s+(?:an?\s+|any\s+)?${APPROVAL_WORD}`,
].join('|'), 'i');
const asksApproval = (criteria: string) => criteria.split(/(?<=[.!?;])\s+|\n+/).some(s => ASKS_APPROVAL.test(s) && !DENIES_APPROVAL.test(s));

/**
 * CGLAB-457: what a flow's exit criteria ask for and its checks do not
 * enforce. The criteria are prose an agent honours; the role and checks are
 * what the server holds a card to. A hub-delivered TDD Flow asked for an
 * independent review and a person's go-ahead in prose alone, and every card
 * left those steps on the agent's word with nothing saying so.
 *
 * Warnings only: a flow is never refused for them and nothing is switched on.
 * A check the org's hub switched off (`disabledChecks`) counts as present -
 * that is the org's decision, not a gap.
 */
export function flowContractWarnings(steps: unknown): FlowContractWarning[] {
  if (!Array.isArray(steps)) return [];
  const list = ordered(steps.filter((s): s is AnyStep => !!s && typeof s === 'object' && typeof (s as AnyStep).name === 'string'));
  if (!list.length) return [];
  if (!hasStepContracts(list)) {
    return [{ step: null, kind: 'no-contracts', message: 'No step carries a role or a check: the server enforces nothing beyond the branch check, and that only warns. Give each step the role that matches its work.' }];
  }
  const out: FlowContractWarning[] = [];
  const last = list[list.length - 1];
  for (const s of list) {
    // A terminal step is never left, so nothing it asks for is checked on leaving it.
    if (s === last && (last.isAnchor || last.isSpecial)) continue;
    const name = String(s.name);
    const criteria = typeof (s as { exitCriteria?: unknown }).exitCriteria === 'string' ? (s as { exitCriteria: string }).exitCriteria : '';
    const carries = (id: string) => [...resolveStepChecks(list, name), ...disabledStepChecks(list, name)].some(c => c.id === id);
    if ((REVIEW_NAME.test(name) || ASKS_REVIEW.test(criteria)) && !carries('review-record')) {
      // A step has one role: swapping a coding step's for 'review' would drop its own checks.
      const fix = isRole(s.role) ? `add the review-record check to it (its '${s.role}' role stays)` : "give the step role 'review'";
      out.push({ step: name, kind: 'review', message: `Step ${name} reads as a review step (its name or its exit criteria), but it has no 'review' role or review-record check, so no review is recorded or checked and an agent can leave it on its word alone: ${fix}.` });
    }
    if (asksApproval(criteria) && !carries('human-approval')) {
      out.push({ step: name, kind: 'approval', message: `Step ${name}: its exit criteria ask for a person's go-ahead, but the step has no human-approval check, so an agent can leave it without one. Add the human-approval check to the step.` });
    }
  }
  return out;
}

/**
 * PUT semantics for step contracts: a step that OMITS `role` or `checks` keeps
 * the stored value for the step with the same id; an explicit `null` (or an
 * empty list) clears it. An older editor that knows nothing about contracts
 * therefore never wipes one. A step with a new id starts empty.
 */
export function mergeStepContracts<T extends Record<string, any>>(incoming: T[], stored: readonly Record<string, any>[] | undefined): Array<T & { role?: any; checks?: any; disabledChecks?: any; autoCommit?: any; requireCommit?: any }> {
  if (!Array.isArray(incoming)) return incoming;
  const byId = new Map((stored ?? []).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  return incoming.map(step => {
    if (!step || typeof step !== 'object') return step;
    const prev = typeof step.id === 'string' ? byId.get(step.id) : undefined;
    const out: Record<string, any> = { ...step };
    for (const k of ['role', 'checks', 'disabledChecks', 'autoCommit', 'requireCommit'] as const) {
      if (!Object.prototype.hasOwnProperty.call(step, k)) {
        if (prev && prev[k] !== undefined && prev[k] !== null) out[k] = prev[k];
      } else if (step[k] === null || ((k === 'checks' || k === 'disabledChecks') && Array.isArray(step[k]) && step[k].length === 0)) {
        delete out[k];
      }
    }
    return out as T & { role?: any; checks?: any; disabledChecks?: any; autoCommit?: any; requireCommit?: any };
  });
}
