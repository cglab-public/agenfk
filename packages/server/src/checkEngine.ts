/**
 * CGLAB-380 — evaluating a step's checks.
 *
 * The server resolves WHICH checks run (core's resolveStepChecks), gathers the
 * evidence (the tree, a test-report capture, the step's entry record and the
 * records earlier steps produced), and hands both to `evaluateChecks`. Nothing
 * here spawns a suite or writes storage: a check reads what it is given, so
 * the same check behaves identically on any flow, whatever its steps are called.
 *
 * Outcomes:
 * - pass / fail: the check could be judged.
 * - unavailable: it could not (no tree, no test report, no entry record). A
 *   blocking check that cannot be judged BLOCKS - unavailable is never passed -
 *   except when the only thing missing is the entry record of a card that
 *   entered its step before checks existed: that warns until the card re-enters.
 * - n/a: a role built-in whose record no earlier step produces.
 * - deferred: enforced elsewhere on this transition (the project verify command).
 */
import { CHECK_CATALOGUE, type CheckSeverity, type RecordName, type ResolvedCheck } from '@agenfk/core';

export type CheckOutcome = 'pass' | 'fail' | 'unavailable' | 'n/a' | 'deferred';

export interface CheckResult {
  id: string;
  step: string;
  source: ResolvedCheck['source'];
  severity: CheckSeverity;
  params: Record<string, string>;
  outcome: CheckOutcome;
  detail: string;
  /** True when this result refuses the transition. */
  blocking: boolean;
}

type ReportedTest = { name: string; file: string; status: 'passed' | 'failed' | 'skipped'; failure?: 'assertion' | 'error' };

/** A capture step record (CGLAB-379), as far as checks read it. */
export interface CaptureRecord {
  step: string;
  exitCode?: number | null;
  format?: string;
  available?: boolean;
  tests?: ReportedTest[];
  brokenFiles?: Array<{ file: string; message: string }>;
  surface?: { files: Record<string, string> };
  surfaceComplete?: boolean;
  parseError?: string;
}

export interface EngineContext {
  /** The tree the card's commands run in; null when it has none. */
  root: string | null;
  /** `git <args>`; throws on failure. */
  git: (args: string[]) => string;
  item: { id: string; type: string; externalId?: string | null };
  /** The card's branch: its own, else its nearest ancestor's. */
  cardBranch: string | null;
  children: Array<{ id: string; type: string; status: string }>;
  /** This verify's capture, when a check needed one. */
  capture: CaptureRecord | null;
  /** Why there is no usable capture, when there is none. */
  captureError?: string;
  /** Per-test results as the card entered this step (`stepEntryTests`). */
  entry: CaptureRecord | null;
  /** HEAD when the card entered this step, from the previous step's exit record. */
  entryHead: string | null;
  /** Records earlier steps produced. */
  records: Partial<Record<RecordName, unknown>>;
}

interface Verdict {
  outcome: 'pass' | 'fail' | 'unavailable';
  detail: string;
  /** Unavailable only because the card predates checks: warn, never block. */
  soft?: boolean;
  produces?: Partial<Record<RecordName, unknown>>;
}
type Evaluator = (ctx: EngineContext, params: Record<string, string>) => Verdict;

const LISTED = 5;
const list = (xs: readonly string[]) => xs.slice(0, LISTED).join(' | ') + (xs.length > LISTED ? ` | …and ${xs.length - LISTED} more` : '');

/** Per-test results of this verify's capture, or why there are none. */
function currentTests(ctx: EngineContext): { tests: ReportedTest[]; capture: CaptureRecord } | Verdict {
  const c = ctx.capture;
  if (!c) return { outcome: 'unavailable', detail: ctx.captureError ?? 'no test report was captured' };
  if (!c.available || !c.tests) {
    return {
      outcome: 'unavailable',
      detail: c.parseError
        ?? 'per-test results are unavailable: this project has no test report set (agenfk update-project <id> --test-report-format vitest-json|junit-xml ...), so only the exit code is known',
    };
  }
  return { tests: c.tests, capture: c };
}

/** The entry record's per-test results, or a SOFT unavailable for a card that predates checks. */
function entryTests(ctx: EngineContext): ReportedTest[] | Verdict {
  const e = ctx.entry;
  if (!e) return { outcome: 'unavailable', soft: true, detail: 'no entry record: the card entered this step before checks recorded one (it predates checks). Re-enter the step to record it.' };
  if (!e.available || !e.tests) return { outcome: 'unavailable', soft: true, detail: `the entry record has no per-test results${e.parseError ? ` (${e.parseError})` : ''}` };
  return e.tests;
}

/** The test names recorded when the tests were written, as tests. */
function authoredTests(ctx: EngineContext): ReportedTest[] | Verdict {
  const names = ctx.records.authoredTests;
  if (!Array.isArray(names)) return { outcome: 'unavailable', detail: "no 'authoredTests' record: the step that writes tests has not recorded one" };
  return names.map(name => ({ name: String(name), file: '', status: 'passed' as const }));
}

const isVerdict = (x: unknown): x is Verdict => !!x && typeof x === 'object' && 'outcome' in (x as any);

export const EVALUATORS: Record<string, Evaluator> = {
  'tree-clean': ctx => {
    if (!ctx.root) return { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree)' };
    let porcelain: string;
    try { porcelain = ctx.git(['-C', ctx.root, 'status', '--porcelain']); } catch (e: any) { return { outcome: 'unavailable', detail: `git status failed: ${e?.message ?? e}` }; }
    const dirty = porcelain.split('\n').map(l => l.trim()).filter(Boolean);
    return dirty.length
      ? { outcome: 'fail', detail: `uncommitted changes: ${list(dirty)}. Commit or stash them before starting.` }
      : { outcome: 'pass', detail: 'clean' };
  },

  'on-card-branch': ctx => {
    if (!ctx.cardBranch) return { outcome: 'pass', detail: 'no branch is recorded for this card or its parents' };
    if (!ctx.root) return { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree)' };
    let current: string;
    try { current = ctx.git(['-C', ctx.root, 'branch', '--show-current']).trim(); } catch (e: any) { return { outcome: 'unavailable', detail: `git branch failed: ${e?.message ?? e}` }; }
    return current === ctx.cardBranch
      ? { outcome: 'pass', detail: current }
      : { outcome: 'fail', detail: `the tree is on ${current ? `'${current}'` : 'a detached HEAD'}, but the card's branch is '${ctx.cardBranch}'. Run: git checkout ${ctx.cardBranch}` };
  },

  'suite-green': ctx => {
    const c = ctx.capture;
    if (!c) return { outcome: 'unavailable', detail: ctx.captureError ?? 'no test run was captured' };
    if (c.parseError) return { outcome: 'unavailable', detail: c.parseError };
    if (!c.available) {
      return c.exitCode === 0
        ? { outcome: 'pass', detail: 'exit code 0 (no per-test report is set, so only the exit code was read)' }
        : { outcome: 'fail', detail: `the test command exited ${c.exitCode ?? 'without a code (killed)'}` };
    }
    const failed = (c.tests ?? []).filter(t => t.status === 'failed').map(t => t.name);
    const broken = (c.brokenFiles ?? []).map(b => `${b.file}: ${b.message}`);
    if (c.exitCode === 0 && !failed.length && !broken.length) return { outcome: 'pass', detail: `${(c.tests ?? []).length} tests, exit code 0` };
    const why = [
      c.exitCode !== 0 ? `exit code ${c.exitCode ?? 'none (killed)'}` : '',
      failed.length ? `${failed.length} failing: ${list(failed)}` : '',
      broken.length ? `${broken.length} test file(s) failed to load: ${list(broken)}` : '',
    ].filter(Boolean).join('; ');
    return { outcome: 'fail', detail: why };
  },

  'test-count-not-lower': (ctx, p) => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const before = p.since === 'test-authoring' ? authoredTests(ctx) : entryTests(ctx);
    if (isVerdict(before)) return before;
    const n = now.tests.length;
    return n >= before.length
      ? { outcome: 'pass', detail: `${before.length} → ${n} tests` }
      : { outcome: 'fail', detail: `${before.length} → ${n} tests: fewer than when the step began. Missing: ${list(before.map(t => t.name).filter(x => !now.tests.some(t => t.name === x)))}` };
  },
};

/**
 * Evaluate resolved checks. Blocking: a `block` check that failed, or that
 * could not be judged for any reason other than a card predating checks.
 * Records are produced only by checks that pass.
 */
export function evaluateChecks(resolved: readonly ResolvedCheck[], ctx: EngineContext): {
  results: CheckResult[];
  blocked: boolean;
  produced: Partial<Record<RecordName, unknown>>;
} {
  const results: CheckResult[] = [];
  const produced: Partial<Record<RecordName, unknown>> = {};
  for (const c of resolved) {
    const base = { id: c.id, step: c.step, source: c.source, severity: c.severity, params: c.params };
    if (!c.applicable) {
      results.push({ ...base, outcome: 'n/a', blocking: false, detail: `needs ${(c.missing ?? []).map(m => `'${m}'`).join(', ')}, which no earlier step produces` });
      continue;
    }
    if (c.id === 'server-owned-verify') {
      results.push({ ...base, outcome: 'deferred', blocking: false, detail: "enforced on this transition by the project's verify command" });
      continue;
    }
    const evaluate = EVALUATORS[c.id];
    const verdict: Verdict = evaluate
      ? (() => { try { return evaluate(ctx, c.params); } catch (e: any) { return { outcome: 'unavailable' as const, detail: `the check itself failed: ${e?.message ?? e}` }; } })()
      : { outcome: 'unavailable', detail: `'${c.id}' is not implemented on this server` };
    const blocking = c.severity === 'block' && (verdict.outcome === 'fail' || (verdict.outcome === 'unavailable' && !verdict.soft));
    results.push({ ...base, outcome: verdict.outcome, detail: verdict.detail, blocking });
    if (verdict.outcome === 'pass' && verdict.produces) Object.assign(produced, verdict.produces);
  }
  return { results, blocked: results.some(r => r.blocking), produced };
}

/** Does any applicable check need a test-report capture? */
export function needsCapture(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && c.id !== 'server-owned-verify' && CHECK_CATALOGUE[c.id]?.needsCapture);
}

/** Does any applicable check read the step's entry record? */
export function needsEntryRecord(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && CHECK_CATALOGUE[c.id]?.requires(c.params).includes('stepEntryTests'));
}

const MARK: Record<CheckOutcome, string> = { pass: '✅', fail: '❌', unavailable: '⛔', 'n/a': '➖', deferred: '⏩' };

/** One line per result, blocking ones first. */
export function formatCheckResults(results: readonly CheckResult[]): string {
  const rank = (r: CheckResult) => (r.blocking ? 0 : r.outcome === 'fail' || r.outcome === 'unavailable' ? 1 : 2);
  return [...results].sort((a, b) => rank(a) - rank(b)).map(r => {
    const mark = !r.blocking && (r.outcome === 'fail' || r.outcome === 'unavailable') ? '⚠️' : MARK[r.outcome];
    return `${mark} ${r.id} [${r.severity}${r.source === 'flow' ? ', added by the flow' : ''}]: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`;
  }).join('\n');
}
