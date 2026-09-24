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
import * as path from 'path';
import { insideRoot, isTestPath } from './stepRecords';
import { CHECK_CATALOGUE, checkDef, type CheckSeverity, type RecordName, type ResolvedCheck } from '@agenfk/core';

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
  /** A person passed this blocked check with a reason (CGLAB-382): it no longer blocks. */
  overridden?: Override;
}

/** A person's pass of one blocked check, with the reason they wrote (CGLAB-382). */
export interface Override { id: string; by: string; at: string; reason: string; detail?: string }

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
  surfaceMissing?: string[];
  /** 'declared' when built from the project's declared test paths (9afdba7d); absent on older captures. */
  surfaceScope?: string;
  /** The declared test paths the surface was built from. */
  surfaceDeclared?: string[];
  /** Directories that look like tests, when a name is no file and none are declared. */
  surfaceSuggested?: string[];
  parseError?: string;
}

export interface EngineContext {
  /** The tree the card's commands run in; null when it has none. */
  root: string | null;
  /** `git <args>`; throws on failure. */
  git: (args: string[]) => string;
  item: { id: string; type: string; externalId?: string | null; projectId?: string };
  /** The card's branch: its own, else its nearest ancestor's. */
  cardBranch: string | null;
  /** JIRA keys on the card and its ancestors, nearest first. */
  cardKeys: string[];
  /** Extra paths that count as test files (the test report's surface). */
  testPaths: string[];
  /** Paths the checks never count as the card's changes (the test report the capture writes). */
  ignoredPaths: string[];
  /** Paths other active cards claim: their changes are theirs, in a shared tree. */
  foreignClaims: string[];
  /** Checks enforced by the project verify command on this transition, not judged here. */
  deferToCommand: string[];
  /** For review-record (CGLAB-381): the card's place and its review evidence. */
  review?: {
    hasParent: boolean;
    childCount: number;
    /** Children that carry a review record of their own. */
    childrenReviewed: number;
    records: Array<{ reviewer: { client: string; sessionId: string; agentId: string | null; edits?: string[]; advancedCards?: boolean }; range: { from: string; to: string }; tree?: string | null }>;
    /** The tree's content state now (null when unreadable or not the card being verified). */
    currentTree?: string | null;
    /** Every author identity recorded on the card and its descendants. */
    authors: Array<{ client: string; sessionId: string; agentId: string | null }>;
    /** HEAD when the card's work began (its first step's exit record). */
    startHead: string | null;
    /** Close commits of the card's descendants. */
    descendantCommits: string[];
    /** This server's version: the CLI that can record a review (CGLAB-385). */
    agenfkVersion?: string;
  };
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
  /** People's approvals of the card's current step, made from the board (CGLAB-382). */
  approvals?: Array<{ by: string; at: string; note?: string; authority?: string }>;
  /** Approvals of the same step on the card's ancestors, nearest first: a breakdown approved at its parent. */
  inheritedApprovals?: Array<{ by: string; at: string; note?: string; authority?: string; from: string }>;
  /** People's overrides of the current step's checks, by check id (CGLAB-382). */
  overrides?: Record<string, Override>;
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
  if (!Array.isArray(names)) return { outcome: 'unavailable', soft: true, detail: "no 'authoredTests' record: the step that writes tests did not produce one for this card (it entered that step before checks, or its tests could not be judged there)" };
  return names.map(name => ({ name: String(name), file: '', status: 'passed' as const }));
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** The tests this step added: named now, not at the step's entry. */
function newTests(ctx: EngineContext): { added: ReportedTest[]; now: ReportedTest[]; capture: CaptureRecord } | Verdict {
  const now = currentTests(ctx);
  if (isVerdict(now)) return now;
  const before = entryTests(ctx);
  if (isVerdict(before)) return before;
  const was = new Set(before.map(t => t.name));
  return { added: now.tests.filter(t => !was.has(t.name)), now: now.tests, capture: now.capture };
}

/** A path inside a claim (a directory or an exact file), at a segment boundary. */
const within = (file: string, claim: string) => {
  const c = claim.replace(/^\.\//, '').replace(/\/+$/, '');
  return file === c || file.startsWith(`${c}/`);
};
/**
 * Changes that are this card's: not the test report the capture writes, and
 * not files another active card has claimed. Unclaimed files stay the card's,
 * so a card cannot hide an edit by claiming narrowly.
 */
function cardsOwn(ctx: EngineContext, files: string[]): string[] {
  return files.filter(f => !ctx.ignoredPaths.some(p => within(f, p)) && !ctx.foreignClaims.some(c => within(f, c)));
}

const isVerdict = (x: unknown): x is Verdict => !!x && typeof x === 'object' && 'outcome' in (x as any);

type ReviewEvidence = NonNullable<EngineContext['review']>;

/**
 * Is the card's latest review an independent review of its work? Also used,
 * without the tree comparison, to decide whether a CHILD's review counts.
 */
export function judgeReview(r: ReviewEvidence, root: string | null, git: (args: string[]) => string, opts: { bindTree: boolean }): Verdict {
  const rec = r.records[r.records.length - 1];
  if (!rec) {
    if (r.childCount > 0 && r.childrenReviewed === r.childCount) return { outcome: 'pass', detail: `each of its ${r.childCount} child cards carries an independent review` };
    // Nobody who advanced this card used a harness whose transcripts the
    // server reads (Cursor, Gemini, OpenCode, an older agenfk): there is no
    // way to record a checkable review, so it warns rather than strands it.
    // An agenfk older than the review checks sends no actor either (S9 row A4),
    // so say what makes the check real, not only that it cannot run.
    if (!r.authors.length) return { outcome: 'unavailable', soft: true, detail: `no independent review is recorded, and no author identity either: this harness, or an agenfk older than ${r.agenfkVersion ?? 'this server'}, cannot record a checkable review. Review the change independently all the same. With Claude Code, Codex or pi, upgrade (agenfk upgrade) and record it with agenfk review record; otherwise a person can override this check on the board.` };
    return { outcome: 'fail', detail: `no independent review is recorded. Have a separate agent review the diff, then: agenfk review record <id> --transcript <reviewer session log> --range <from>..<to> --findings <json>. That command needs agenfk ${r.agenfkVersion ?? 'of this server\'s version'} or later (agenfk upgrade); otherwise a person can override this check on the board.` };
  }
  const who = `${rec.reviewer.client} session ${rec.reviewer.sessionId}${rec.reviewer.agentId ? `, agent ${rec.reviewer.agentId}` : ''}`;
  const same = (a: { sessionId: string; agentId: string | null }, b: { sessionId: string; agentId: string | null }) => a.sessionId === b.sessionId && (a.agentId ?? null) === (b.agentId ?? null);
  if (r.authors.some(a => same(a, rec.reviewer))) return { outcome: 'fail', detail: `not independent: the reviewer (${who}) is an author of this card` };
  if (!root) return { outcome: 'unavailable', detail: 'the card has no tree to check the review against' };
  if (rec.reviewer.advancedCards) return { outcome: 'fail', detail: `not independent: the reviewer (${who}) ran agenfk verify, so it is an author, not a reviewer` };
  // Resolved through symlinks, even for a file that no longer exists.
  const inTree = (rec.reviewer.edits ?? []).filter(f => insideRoot(root, path.resolve(root, f)) !== null);
  if (inTree.length) return { outcome: 'fail', detail: `not independent: the reviewer (${who}) edited the card's tree (${list(inTree)}), so it is an author, not a reviewer` };
  const isAncestor = (a: string, b: string) => { try { git(['-C', root, 'merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  if (r.startHead && !isAncestor(rec.range.from, r.startHead)) {
    return { outcome: 'fail', detail: `the review starts at ${rec.range.from.slice(0, 12)}, after the card's work began at ${r.startHead.slice(0, 12)}: it does not cover all of it` };
  }
  const missed = r.descendantCommits.filter(c => !isAncestor(c, rec.range.to));
  if (missed.length) return { outcome: 'fail', detail: `the review ends at ${rec.range.to.slice(0, 12)} and misses work committed later: ${list(missed.map(c => c.slice(0, 12)))}. Review again over the whole range.` };
  if (opts.bindTree && rec.tree && r.currentTree && rec.tree !== r.currentTree) {
    return { outcome: 'fail', detail: 'the tree changed after the review was recorded: fix the findings first, then record the review of the final tree' };
  }
  if (!r.authors.length) return { outcome: 'unavailable', soft: true, detail: 'no author identity is recorded for this card (advanced by an older agenfk or an unknown harness), so independence cannot be shown. Upgrade agenfk (agenfk upgrade) so verify records who advanced it, or a person can override this check on the board.' };
  return { outcome: 'pass', detail: `reviewed by ${who} over ${rec.range.from.slice(0, 12)}..${rec.range.to.slice(0, 12)}` };
}

export const EVALUATORS: Record<string, Evaluator> = {
  'tree-clean': ctx => {
    if (!ctx.root) return { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree)' };
    let porcelain: string;
    try { porcelain = ctx.git(['-C', ctx.root, 'status', '--porcelain']); } catch (e: any) { return { outcome: 'unavailable', detail: `git status failed: ${e?.message ?? e}` }; }
    // `XY path` (or `XY old -> new`): the path is what follows the status.
    const entries = porcelain.split('\n').filter(l => l.trim()).map(l => ({ line: l.trim(), file: l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '') }));
    const mine = new Set(cardsOwn(ctx, entries.map(e => e.file)));
    const dirty = entries.filter(e => mine.has(e.file)).map(e => e.line);
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

  'jira-key-valid': ctx => {
    const key = ctx.cardKeys[0];
    if (!key) return { outcome: 'fail', detail: 'no JIRA key on this card or its parents. Link one: agenfk update <id> --jira-item <KEY>' };
    if (!JIRA_KEY.test(key)) return { outcome: 'fail', detail: `'${key}' is not a JIRA key (PROJ-123)` };
    if (ctx.cardBranch && !ctx.cardKeys.some(k => ctx.cardBranch!.includes(k))) {
      return { outcome: 'fail', detail: `the branch '${ctx.cardBranch}' carries none of the card's keys (${ctx.cardKeys.join(', ')}). Name it feat/${key}_<description> or fix/${key}_<description>` };
    }
    return { outcome: 'pass', detail: ctx.cardBranch ? `${key}, carried by '${ctx.cardBranch}'` : key };
  },

  'has-children': (ctx, p) => {
    const types = (p.types || 'EPIC').split(',');
    if (!types.includes(ctx.item.type)) return { outcome: 'pass', detail: `applies only to ${types.join(', ')} cards` };
    return ctx.children.length
      ? { outcome: 'pass', detail: `${ctx.children.length} child card(s)` }
      : { outcome: 'fail', detail: `this ${ctx.item.type} has no child cards yet. Break it down first.` };
  },

  'only-test-files-changed': ctx => {
    if (!ctx.root) return { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree)' };
    if (!ctx.entryHead) return { outcome: 'unavailable', soft: true, detail: 'no entry commit: the card entered this step before checks recorded one (it predates checks)' };
    let changed: string[];
    try {
      const diff = ctx.git(['-C', ctx.root, 'diff', '--name-only', ctx.entryHead]);
      const untracked = ctx.git(['-C', ctx.root, 'ls-files', '--others', '--exclude-standard']);
      changed = cardsOwn(ctx, [...new Set([...diff.split('\n'), ...untracked.split('\n')].map(l => l.trim()).filter(Boolean))]);
    } catch (e: any) {
      return { outcome: 'unavailable', detail: `git could not list the changes since ${ctx.entryHead.slice(0, 12)}: ${e?.message ?? e}` };
    }
    if (!changed.length) return { outcome: 'fail', detail: 'nothing changed in this step: no test was written' };
    const other = changed.filter(f => !isTestPath(f, ctx.testPaths));
    return other.length
      ? { outcome: 'fail', detail: `non-test files changed: ${list(other)}. This step writes tests only; the code comes in the next step.` }
      : { outcome: 'pass', detail: `${changed.length} test file(s) changed` };
  },

  'no-broken-test-files': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const broken = now.capture.brokenFiles ?? [];
    return broken.length
      ? { outcome: 'fail', detail: `${broken.length} test file(s) failed to load, so their tests have no names: ${list(broken.map(b => `${b.file}: ${b.message}`))}` }
      : { outcome: 'pass', detail: 'every test file loads' };
  },

  'new-tests-exist': ctx => {
    const d = newTests(ctx);
    if (isVerdict(d)) return d;
    return d.added.length ? { outcome: 'pass', detail: `${d.added.length} new test(s)` } : { outcome: 'fail', detail: 'no test was added in this step' };
  },

  'some-new-test-red': ctx => {
    const d = newTests(ctx);
    if (isVerdict(d)) return d;
    const red = d.added.filter(t => t.status === 'failed').map(t => t.name);
    if (!red.length) return { outcome: 'fail', detail: d.added.length ? `none of the ${d.added.length} new test(s) fails: a test that passes before the code exists proves nothing about it` : 'no new test was added' };
    return {
      outcome: 'pass',
      detail: `${red.length} of ${d.added.length} new test(s) red: ${list(red)}`,
      produces: { redSet: red, testSurface: { files: d.capture.surface?.files ?? {}, scope: d.capture.surfaceScope ?? null, complete: d.capture.surfaceComplete !== false, declared: d.capture.surfaceDeclared ?? [] }, authoredTests: d.now.map(t => t.name) },
    };
  },

  'new-tests-born-green': ctx => {
    const d = newTests(ctx);
    if (isVerdict(d)) return d;
    const green = d.added.filter(t => t.status === 'passed').map(t => t.name);
    return green.length
      ? { outcome: 'fail', detail: `already passing, so left out of the red set: ${list(green)}` }
      : { outcome: 'pass', detail: 'none' };
  },

  'red-is-assertion': ctx => {
    const d = newTests(ctx);
    if (isVerdict(d)) return d;
    const errored = d.added.filter(t => t.status === 'failed' && t.failure === 'error').map(t => t.name);
    return errored.length
      ? { outcome: 'fail', detail: `red because of an error, not a failed assertion: ${list(errored)}` }
      : { outcome: 'pass', detail: 'every red test fails on an assertion' };
  },

  'existing-tests-still-green': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const before = entryTests(ctx);
    if (isVerdict(before)) return before;
    const status = new Map(now.tests.map(t => [t.name, t.status]));
    const broke = before.filter(t => t.status === 'passed' && status.get(t.name) !== 'passed').map(t => `${t.name} [${status.get(t.name) ?? 'missing'}]`);
    return broke.length ? { outcome: 'fail', detail: `passed when the step began, not now: ${list(broke)}` } : { outcome: 'pass', detail: 'ok' };
  },

  'red-set-passes-by-name': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const red = ctx.records.redSet;
    if (!Array.isArray(red)) return { outcome: 'unavailable', soft: true, detail: "no 'redSet' record: the step that writes tests did not produce one for this card (it entered that step before checks, or its tests could not be judged there)" };
    const status = new Map(now.tests.map(t => [t.name, t.status]));
    const open = red.map(String).filter(n => status.get(n) !== 'passed').map(n => `${n} [${status.get(n) ?? 'missing'}]`);
    return open.length
      ? { outcome: 'fail', detail: `not passing yet: ${list(open)}` }
      : { outcome: 'pass', detail: `${red.length} red test(s) now pass` };
  },

  'test-surface-frozen': (ctx, p) => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    // An incomplete surface cannot show that nothing changed: the files it
    // could not find are exactly the ones an edit would hide in (9afdba7d).
    const pid = ctx.item.projectId ?? '<projectId>';
    const suggested = now.capture.surfaceSuggested ?? [];
    if (now.capture.surfaceComplete === false) {
      const missing = now.capture.surfaceMissing ?? [];
      return { outcome: 'unavailable', detail: `the test surface is incomplete, so a change to the tests cannot be seen: ${list(missing)}. The report names tests by something that is no file, and the project declares no test paths. Declare where its tests live: agenfk update-project ${pid} --test-report-surface ${suggested.length ? `${suggested.join(',')} (suggested from the directories that look like tests - check them)` : '<path>[,<path>]'} - or a person can override this check on the board.` };
    }
    const incompleteBase = `the tests were recorded with an incomplete surface, so there is nothing to compare this run against. Declare the test paths (agenfk update-project ${pid} --test-report-surface <path>[,<path>]) and then re-enter the step where the record was taken, or a person can override this check on the board.`;
    const sameDeclared = (a: unknown) => JSON.stringify([...(Array.isArray(a) ? a : [])].sort()) === JSON.stringify([...(now.capture.surfaceDeclared ?? [])].sort());
    const declaredChanged = "the project's declared test paths changed since the tests were recorded, so the two surfaces hold different files and cannot be compared. Re-enter the step where the record was taken to record it again.";
    let base: Record<string, string>;
    if (p.since === 'step-entry') {
      const e = ctx.entry;
      if (!e?.surface) return { outcome: 'unavailable', soft: true, detail: 'no entry record with a test surface: the card entered this step before checks recorded one (it predates checks)' };
      if (e.surfaceScope !== now.capture.surfaceScope) return { outcome: 'unavailable', soft: true, detail: "the entry record's test surface was recorded by an older server, so it cannot be compared with this one. Re-enter the step to record a new one." };
      if (e.surfaceComplete === false) return { outcome: 'unavailable', detail: incompleteBase };
      if (!sameDeclared(e.surfaceDeclared)) return { outcome: 'unavailable', soft: true, detail: declaredChanged };
      base = e.surface.files;
    } else {
      const frozen = ctx.records.testSurface as { files?: unknown; scope?: unknown; complete?: unknown; declared?: unknown } | undefined;
      if (!frozen || typeof frozen !== 'object') return { outcome: 'unavailable', soft: true, detail: "no 'testSurface' record: the step that writes tests did not produce one for this card (it entered that step before checks, or its tests could not be judged there)" };
      // An older server froze a bare map of what the report named (9afdba7d).
      if (typeof frozen.scope !== 'string' || !frozen.files || typeof frozen.files !== 'object' || frozen.scope !== now.capture.surfaceScope) {
        return { outcome: 'unavailable', soft: true, detail: 'the tests were frozen by an older server, so the freeze cannot be compared with this run. Re-enter the step that writes tests to freeze them again.' };
      }
      if (frozen.complete === false) return { outcome: 'unavailable', detail: incompleteBase };
      if (!sameDeclared(frozen.declared)) return { outcome: 'unavailable', soft: true, detail: declaredChanged };
      base = frozen.files as Record<string, string>;
    }
    const cur = now.capture.surface?.files ?? {};
    const changes: string[] = [];
    // Only the report the capture writes is left out. Other cards' claims are
    // not: a claim on the tests would otherwise hide an edit to them.
    for (const f of [...new Set([...Object.keys(base), ...Object.keys(cur)])].filter(f => !ctx.ignoredPaths.some(ig => within(f, ig)))) {
      if (!(f in cur)) changes.push(`deleted ${f}`);
      else if (!(f in base)) { if (p.mode === 'strict') changes.push(`added ${f}`); }
      else if (base[f] !== cur[f]) changes.push(`edited ${f}`);
    }
    return changes.length
      ? { outcome: 'fail', detail: `the tests changed: ${list(changes)}. Put them back; ${p.mode === 'strict' ? 'nothing may change here' : 'only new test files may be added'}.` }
      : { outcome: 'pass', detail: p.mode === 'strict' ? 'unchanged' : 'unchanged (new files allowed)' };
  },

  'test-set-identical': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const before = entryTests(ctx);
    if (isVerdict(before)) return before;
    const was = new Set(before.map(t => t.name));
    const is = new Set(now.tests.map(t => t.name));
    const diff = [...[...was].filter(n => !is.has(n)).map(n => `-${n}`), ...[...is].filter(n => !was.has(n)).map(n => `+${n}`)];
    return diff.length ? { outcome: 'fail', detail: `the tests changed: ${list(diff)}` } : { outcome: 'pass', detail: `${is.size} tests, identical` };
  },

  'review-record': (ctx, p) => {
    const r = ctx.review;
    if (!r) return { outcome: 'unavailable', detail: 'no review evidence was gathered' };
    const isParent = r.childCount > 0 || !r.hasParent;
    if (p.appliesTo !== 'every-card' && !isParent) return { outcome: 'pass', detail: 'reviewed with its parent: reviews happen at the parent card' };
    return judgeReview(r, ctx.root, ctx.git, { bindTree: true });
  },

  'human-approval': (ctx, p) => {
    // A step that asks for a passkey counts only approvals signed with one (CGLAB-383).
    const counts = (x: { authority?: string }) => p.signature !== 'passkey' || x.authority === 'passkey';
    const own = (ctx.approvals ?? []).filter(counts);
    const a = own[own.length - 1];
    if (a) return { outcome: 'pass', detail: `approved on the board at ${a.at}${a.note ? `: ${a.note}` : ''}` };
    const up = p.appliesTo === 'every-card' ? undefined : (ctx.inheritedApprovals ?? []).filter(counts)[0];
    if (up) return { outcome: 'pass', detail: `approved with its parent ${up.from.slice(0, 8)} on the board at ${up.at}` };
    const how = p.signature === 'passkey' ? ', signed with a passkey' : '';
    return { outcome: 'fail', detail: `waiting for a person to approve this step on the board${how} (agenfk ui --open ${ctx.item.id}). An agent cannot approve.` };
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
    if (c.id === 'server-owned-verify' || ctx.deferToCommand.includes(c.id)) {
      results.push({ ...base, outcome: 'deferred', blocking: false, detail: "enforced on this transition by the project's verify command" });
      continue;
    }
    const evaluate = EVALUATORS[c.id] ?? EVALUATORS[c.id.split(':')[0]];
    const verdict: Verdict = evaluate
      ? (() => { try { return evaluate(ctx, c.params); } catch (e: any) { return { outcome: 'unavailable' as const, detail: `the check itself failed: ${e?.message ?? e}` }; } })()
      : { outcome: 'unavailable', detail: `'${c.id}' is not implemented on this server` };
    const blocks = c.severity === 'block' && (verdict.outcome === 'fail' || (verdict.outcome === 'unavailable' && !verdict.soft));
    // A person's override lifts the block; the verdict itself stays on record.
    // It covers the verdict it was given against: a different failure needs its own.
    const o = blocks ? ctx.overrides?.[c.id] : undefined;
    const overridden = o && (o.detail === undefined || o.detail === verdict.detail) ? o : undefined;
    results.push({ ...base, outcome: verdict.outcome, detail: verdict.detail, blocking: blocks && !overridden, ...(overridden ? { overridden } : {}) });
    if (verdict.outcome === 'pass' && verdict.produces) Object.assign(produced, verdict.produces);
  }
  return { results, blocked: results.some(r => r.blocking), produced };
}

/** Does any applicable check need a test-report capture? */
export function needsCapture(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && c.id !== 'server-owned-verify' && checkDef(c.id)?.needsCapture);
}

/** Does any applicable check read the step's entry record? */
export function needsEntryRecord(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && checkDef(c.id)?.requires(c.params).includes('stepEntryTests'));
}

const MARK: Record<CheckOutcome, string> = { pass: '✅', fail: '❌', unavailable: '⛔', 'n/a': '➖', deferred: '⏩' };

/** One line per result, blocking ones first. */
export function formatCheckResults(results: readonly CheckResult[]): string {
  const rank = (r: CheckResult) => (r.blocking ? 0 : r.outcome === 'fail' || r.outcome === 'unavailable' ? 1 : 2);
  return [...results].sort((a, b) => rank(a) - rank(b)).map(r => {
    const mark = r.overridden ? '🔓' : !r.blocking && (r.outcome === 'fail' || r.outcome === 'unavailable') ? '⚠️' : MARK[r.outcome];
    const why = r.overridden ? ` (overridden by a person: ${r.overridden.reason})` : '';
    return `${mark} ${r.id} [${r.severity}${r.source === 'flow' ? ', added by the flow' : ''}]: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}${why}`;
  }).join('\n');
}
