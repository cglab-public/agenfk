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
import * as fs from 'fs';
import * as path from 'path';
import { insideRoot, isTestPath, loadFailureFileOf } from './stepRecords';
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
  /** An agent check: the coding agent reported it, the server did not check it (efcacdeb). */
  agentReported?: boolean;
  /** What a custom check actually did, stamped when it was judged (C3b). */
  meta?: CheckMeta;
  /** CGLAB-420: the agent's answer to this failing warning, given on verify. */
  answer?: string;
}

/**
 * Facts about a custom check's run that its words must not be parsed for (C3b):
 * whether the command RAN, whose approval let it, that it is WAITING for a
 * person's command approval (and for which command), whether the agent really
 * reported an agent check, and what it said.
 */
export interface CheckMeta {
  ran?: boolean;
  approval?: { by: string; at: string; authority?: string };
  waiting?: { kind: 'command-approval'; hash: string; command: string };
  reported?: boolean;
  note?: string;
  /** 5a8d22e6: a cause the refusal names once, with its fix, for every check it holds up. */
  code?: 'NO_TEST_REPORT';
  /** e2ab4ced (red-set-passes-by-name): red tests renamed or removed - answerable - and ones still not passing - never. */
  missing?: string[];
  notPassing?: string[];
}

/** A failing warning a card left a step with (CGLAB-420). */
export interface TreeWarning { itemId: string; title: string; step: string; check: string; detail: string; answer?: string }

/** One line per warning, for a reviewer's brief and the check that lists them. */
export function describeTreeWarnings(ws: readonly TreeWarning[]): string {
  return ws.map(w => `[${w.itemId.slice(0, 8)}] ${w.title} - ${w.step}: ${w.check} - ${w.detail}${w.answer ? ` (answered: ${w.answer})` : ' (not answered)'}`).join('\n');
}

/**
 * `checkAnswers` as verify receives it (CGLAB-420): [{ id, note }], the agent's
 * answer to a failing warning. Returns them by check id, or why it is refused.
 */
export function parseCheckAnswers(value: unknown): { answers: Record<string, string> } | { error: string } {
  if (value === undefined || value === null) return { answers: {} };
  if (!Array.isArray(value)) return { error: 'checkAnswers must be a list of { id, note }' };
  const answers: Record<string, string> = {};
  for (const a of value) {
    const { id, note } = (a ?? {}) as any;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9:-]{0,80}$/.test(id)) return { error: `checkAnswers: ${JSON.stringify(id)} is not a check id` };
    if (typeof note !== 'string' || !note.trim() || note.length > 2000) return { error: `checkAnswers: the answer to '${id}' must be a text of 1 to 2000 characters` };
    answers[id] = answers[id] ? `${answers[id]}\n${note.trim()}` : note.trim();
  }
  return { answers };
}

/** The coding agent's report of one agent check (efcacdeb). */
export interface AgentReport { outcome: 'pass' | 'fail'; note?: string }

/**
 * `agentChecks` as verify receives it: [{ name, outcome: pass|fail, note? }].
 * Returns the reports by name, or why the value is refused.
 */
export function parseAgentReports(value: unknown): { reports: Record<string, AgentReport> } | { error: string } {
  if (value === undefined || value === null) return { reports: {} };
  if (!Array.isArray(value)) return { error: 'agentChecks must be a list of { name, outcome: pass|fail, note? }' };
  const reports: Record<string, AgentReport> = {};
  for (const r of value) {
    const { name, outcome, note } = (r ?? {}) as any;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return { error: `agentChecks: ${JSON.stringify(name)} is not an agent check's name` };
    if (outcome !== 'pass' && outcome !== 'fail') return { error: `agentChecks: '${name}' must be reported as pass or fail, not ${JSON.stringify(outcome)}` };
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) return { error: `agentChecks: '${name}' note must be a text of at most 2000 characters` };
    reports[name] = { outcome, ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}) };
  }
  return { reports };
}

/** A person's pass of one blocked check, with the reason they wrote (CGLAB-382). */
export interface Override { id: string; by: string; at: string; reason: string; detail?: string }

type ReportedTest = { name: string; file: string; status: 'passed' | 'failed' | 'skipped'; failure?: 'assertion' | 'error' };

/** A capture step record (CGLAB-379), as far as checks read it. */
export interface CaptureRecord {
  step: string;
  /** The commit the run started at. */
  head?: string | null;
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
  /** Checks enforced by the project verify command on this transition, not judged here. */
  deferToCommand: string[];
  /**
   * 281adef0: the card closes without running the project's suite, because its
   * flow runs it once at the top-level card and this parent is still open. The
   * checks the suite would have settled say so, rather than claiming the verify
   * command enforced them.
   */
  deferredToParent?: { id: string; title: string };
  /**
   * 961f301d: slow checks (a capture, a command run) left for the verify after a
   * person's approval, which this one is still waiting for. Reported, never blocking.
   */
  deferToApproval?: string[];
  /** For review-record (CGLAB-381): the card's place and its review evidence. */
  review?: {
    hasParent: boolean;
    childCount: number;
    /** Children that carry a review record of their own. */
    childrenReviewed: number;
    records: Array<{ reviewer: { client: string; sessionId: string; agentId: string | null; edits?: string[]; advancedCards?: boolean }; range: { from: string; to: string }; tree?: string | null; unreviewed?: { lines: number; files: string[] }; unreviewedNotJudged?: string }>;
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
  /**
   * CGLAB-420: the failing warnings this card and its descendants left their
   * steps with, and the answer each was given. What a reviewer should see.
   */
  treeWarnings?: TreeWarning[];
  /**
   * CGLAB-420: the tests the card's descendants froze, for tests-added-late at a
   * parent, where no step of its own wrote tests. Oldest freeze first.
   */
  descendantSurfaces?: Array<{ itemId: string; files: Record<string, string>; head: string | null; complete: boolean }>;
  /** This verify's capture, when a check needed one. */
  capture: CaptureRecord | null;
  /** Why there is no usable capture, when there is none. */
  captureError?: string;
  /**
   * The tree's upstream as fetched on this verify (1049ce52): none, unreachable,
   * or how far HEAD is ahead of and behind it. Absent when no check asked.
   */
  upstream?: { none: true } | { name: string; fetchError: string } | { name: string; ahead: number; behind: number; noUpstream?: true };
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
  /** The step's command checks, already run by the server, by resolved id (efcacdeb). */
  commandResults?: Record<string, { outcome: 'pass' | 'fail' | 'unavailable'; detail: string }>;
  /** The coding agent's reports of the step's agent checks, by name (efcacdeb). */
  agentReports?: Record<string, AgentReport>;
  /** People's overrides of the current step's checks, by check id (CGLAB-382). */
  overrides?: Record<string, Override>;
}

interface Verdict {
  outcome: 'pass' | 'fail' | 'unavailable';
  detail: string;
  /** Unavailable only because the card predates checks: warn, never block. */
  soft?: boolean;
  produces?: Partial<Record<RecordName, unknown>>;
  meta?: CheckMeta;
}
type Evaluator = (ctx: EngineContext, params: Record<string, string>) => Verdict;

/** A file named as a test file itself (the server's lazy capture reads the same shape). */
export const TEST_FILE_PATTERN = /(\.(test|spec)\.[cm]?[jt]sx?$)|(-test\.[cm]?[jt]s$)|((^|\/)test(-[^/]+)?\.[cm]?[jt]s$)|((^|\/)test_[^/]+\.py$)|(_test\.py$)/;
/**
 * A test file in any language this names by convention: the JS/TS/Python
 * shapes above (the ones a lazy run can run alone), plus Go's `_test.go`,
 * RSpec's `_spec.rb`, Maven/Gradle test source sets, C# `*.Tests` /
 * `*.UnitTests` / `*.IntegrationTests` projects and Rust's `tests/*.rs`.
 */
export const ANY_TEST_FILE_PATTERN = new RegExp(`${TEST_FILE_PATTERN.source}|(_test\\.go$)|(_spec\\.rb$)|((^|/)src/(test|integrationTest|androidTest|testFixtures)/.+\\.(java|kt)$)|((^|/)[^/]*\\.(Unit|Integration)?Tests?/.+\\.cs$)|((^|/)tests/[^/]+\\.rs$)`);

const LISTED = 5;
const list = (xs: readonly string[]) => xs.slice(0, LISTED).join(' | ') + (xs.length > LISTED ? ` | …and ${xs.length - LISTED} more` : '');

/** The no-report detail before 5a8d22e6, which overrides given earlier were matched against. */
const LEGACY_NO_REPORT_DETAIL = 'per-test results are unavailable: this project has no test report set (agenfk update-project <id> --test-report-format vitest-json|junit-xml ...), so only the exit code is known';

/** Per-test results of this verify's capture, or why there are none. */
function currentTests(ctx: EngineContext): { tests: ReportedTest[]; capture: CaptureRecord } | Verdict {
  const c = ctx.capture;
  if (!c) return { outcome: 'unavailable', detail: ctx.captureError ?? 'no test report was captured' };
  if (!c.available || !c.tests) {
    if (c.parseError) return { outcome: 'unavailable', detail: c.parseError };
    // The fix is named once, in the refusal (5a8d22e6), not in every check it holds up.
    return { outcome: 'unavailable', detail: 'no per-test results: this project has no test report set, so only the exit code is known', meta: { code: 'NO_TEST_REPORT' } };
  }
  return { tests: c.tests, capture: c };
}

/** The entry record's per-test results, or a SOFT unavailable for a card that predates checks. */
function entryTests(ctx: EngineContext): ReportedTest[] | Verdict {
  const e = ctx.entry;
  if (!e) return { outcome: 'unavailable', soft: true, detail: 'no entry record: the card entered this step before checks recorded one (it predates checks). Re-enter the step to record it.' };
  // A capture that RAN and could not be used is not a card predating checks
  // (d26832d6 #1): marketing-lab's first run dirtied its own tree, and every
  // red/green check on the next step passed soft on nothing. Only a project
  // that records no per-test results at all stays soft - its hold is entry-baseline's.
  if (!e.available || !e.tests) return { outcome: 'unavailable', soft: !e.parseError, detail: `the entry record has no per-test results${e.parseError ? ` (${e.parseError}). Fix what the capture reports and re-enter the step to record a usable one` : ''}` };
  return e.tests;
}

/** The test names recorded when the tests were written, as tests. */
function authoredTests(ctx: EngineContext): ReportedTest[] | Verdict {
  const names = ctx.records.authoredTests as unknown;
  // ec325925: stored by reference to a capture whose results cannot be read. The card did write its
  // tests - the record says so - so this is not a card that predates checks: it holds, never passes soft.
  if ((names as { unreadable?: boolean } | undefined)?.unreadable) return { outcome: 'unavailable', soft: false, detail: "the 'authoredTests' record points at test results that can no longer be read, so the tests as written cannot be counted. Move the card back to the step that writes tests to record them again, or a person can pass this check on the board" };
  if (!Array.isArray(names)) return { outcome: 'unavailable', soft: true, detail: "no 'authoredTests' record: the step that writes tests did not produce one for this card (it entered that step before checks, or its tests could not be judged there)" };
  return names.map(name => ({ name: String(name), file: '', status: 'passed' as const }));
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** The tests this step added: named now, not at the step's entry. */
function newTests(ctx: EngineContext): { added: ReportedTest[]; now: ReportedTest[]; was: Set<string>; capture: CaptureRecord } | Verdict {
  const now = currentTests(ctx);
  if (isVerdict(now)) return now;
  const before = entryTests(ctx);
  if (isVerdict(before)) return before;
  const was = new Set(before.map(t => t.name));
  return { added: now.tests.filter(t => !was.has(t.name)), now: now.tests, was, capture: now.capture };
}

/** A path inside an ignored path (a directory or an exact file), at a segment boundary. */
const within = (file: string, dir: string) => {
  const c = dir.replace(/^\.\//, '').replace(/\/+$/, '');
  return file === c || file.startsWith(`${c}/`);
};
/**
 * Changes that are this card's: everything changed in its tree except the test
 * report the capture writes.
 */
function cardsOwn(ctx: EngineContext, files: string[]): string[] {
  return files.filter(f => !ctx.ignoredPaths.some(p => within(f, p)));
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

/**
 * CGLAB-420: with no branch recorded, on-card-branch used to pass without
 * looking, while the agent worked on a branch it had made itself. A branch
 * named for a JIRA key (feat/KEY_..., fix/KEY_...) that is none of the card's
 * is another card's; that is the one thing a key can tell. A branch that
 * names no key (main, develop, release/..., a descriptive name) is not judged.
 */
// Another card's key is written as a JIRA key is - upper case, two letters at least - and leads the name
// (feat/KEY_..., fix/KEY-..., KEY_...). Words and standards that look like keys are not (CVE-2024, UTF-8, SHA-256).
const LEADING_KEY = /^(?:[A-Za-z]+\/)?([A-Za-z]{2,}[A-Za-z0-9]*-\d+)(?=$|[/_-])/;
const NOT_KEYS = new Set(['CVE', 'CWE', 'GHSA', 'UTF', 'HTTP', 'HTTPS', 'SHA', 'MD', 'ISO', 'RFC', 'TLS', 'SSL', 'AES', 'RSA', 'IPV', 'OAUTH', 'NODE', 'PYTHON', 'JAVA', 'ES', 'V']);
const OWN_KEY = (k: string) => new RegExp(`(?:^|[/_-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/_-])`, 'i');
function branchByKey(ctx: EngineContext): Verdict {
  const keys = ctx.cardKeys.filter(k => JIRA_KEY.test(k)).map(k => k.toUpperCase());
  if (!keys.length) return { outcome: 'pass', detail: 'no branch is recorded for this card or its parents, and no JIRA key to check the branch against' };
  if (!ctx.root) return { outcome: 'unavailable', soft: true, detail: 'the card has no tree (no project root, no worktree)' };
  let current: string;
  try { current = ctx.git(['-C', ctx.root, 'branch', '--show-current']).trim(); } catch (e: any) { return { outcome: 'unavailable', soft: true, detail: `git branch failed: ${e?.message ?? e}` }; }
  if (!current) return { outcome: 'pass', detail: 'a detached HEAD, and no branch is recorded for this card to check it against' };
  // The key that leads the name is the branch's own: a key further along (feat/ABC-2_...-abc-1) is only a mention.
  const lead = LEADING_KEY.exec(current)?.[1];
  const leadIsKey = !!lead && (keys.includes(lead.toUpperCase()) || (/^[A-Z]{2,}[A-Z0-9]*-\d+$/.test(lead) && !NOT_KEYS.has(lead.split('-')[0])));
  if (lead && leadIsKey) {
    return keys.includes(lead.toUpperCase())
      ? { outcome: 'pass', detail: `on '${current}', which carries ${lead.toUpperCase()}` }
      : { outcome: 'fail', detail: `the tree is on '${current}', named for ${lead}, which is not this card's (${keys.join(', ')}): that is another card's branch. Switch to this card's branch (feat/${keys[0]}_<description> or fix/${keys[0]}_<description>), creating it if it does not exist yet.` };
  }
  const mine = keys.find(k => OWN_KEY(k).test(current));
  if (mine) return { outcome: 'pass', detail: `on '${current}', which carries ${mine}` };
  return { outcome: 'pass', detail: `on '${current}', which names no JIRA key: not judged (no branch is recorded for this card)` };
}

/** CGLAB-420: follow-up fixes up to this many lines pass on the review that asked for them. */
export const MAX_UNREVIEWED_LINES = 20;

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

  'tree-in-sync': ctx => {
    const u = ctx.upstream;
    if (!ctx.root) return { outcome: 'unavailable', detail: 'the card has no tree (no project root, no worktree)' };
    if (!u) return { outcome: 'unavailable', detail: 'the upstream was not read on this verify' };
    if ('none' in u) return { outcome: 'pass', detail: 'no upstream: this branch tracks no remote branch, so there is nothing to be in sync with' };
    // Offline or refused: whether the tree is behind is unknown - a warning, never a block (offline work is allowed).
    if ('fetchError' in u) return { outcome: 'unavailable', soft: true, detail: `could not fetch ${u.name} (${u.fetchError}): whether the tree is behind it is unknown` };
    const n = (k: number) => `${k} commit${k === 1 ? '' : 's'}`;
    // No upstream (a fresh card branch): judged only as a base - strictly behind the remote's default branch.
    if (u.noUpstream) {
      if (u.behind && !u.ahead) return { outcome: 'fail', detail: `this branch tracks no remote branch and sits ${n(u.behind)} behind ${u.name}: work would start from a stale base. Bring it up to date first (git merge --ff-only ${u.name}, or re-create the branch from ${u.name}), then verify again.` };
      return { outcome: 'pass', detail: u.ahead ? `no upstream; the branch has ${n(u.ahead)} of its own, so its base is not judged` : `no upstream; up to date with ${u.name}` };
    }
    if (u.behind && u.ahead) return { outcome: 'fail', detail: `the tree has diverged from ${u.name}: ${n(u.ahead)} ahead and ${n(u.behind)} behind. Bring it up to date first (git pull --rebase, or git pull), then verify again.` };
    if (u.behind) return { outcome: 'fail', detail: `the tree is ${n(u.behind)} behind ${u.name}: work would be built on stale code. Update it first: git pull --ff-only` };
    return { outcome: 'pass', detail: `in sync with ${u.name}${u.ahead ? ` (${n(u.ahead)} ahead, not pushed yet)` : ''}` };
  },

  'on-card-branch': ctx => {
    if (!ctx.cardBranch) return branchByKey(ctx);
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
      // CGLAB-418: most often a test importing code not written yet - which a tests-only step cannot write.
      ? { outcome: 'fail', detail: `${broken.length} test file(s) failed to load, so their tests have no names: ${list(broken.map(b => `${b.file}: ${b.message}`))}. If a file imports code that does not exist yet, import it inside the test instead (in JavaScript, \`await import(...)\`), so a missing module fails that test rather than the whole file; red-is-assertion then warns that it is red on an error, which is expected until the code exists.` }
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
      produces: { redSet: red, testSurface: { files: d.capture.surface?.files ?? {}, scope: d.capture.surfaceScope ?? null, complete: d.capture.surfaceComplete !== false, declared: d.capture.surfaceDeclared ?? [], head: d.capture.head ?? null }, authoredTests: d.now.map(t => t.name) },
    };
  },

  'new-tests-born-green': ctx => {
    const d = newTests(ctx);
    if (isVerdict(d)) return d;
    // Sorted: a runner's report order must not make the same failure read as a different one.
    const green = d.added.filter(t => t.status === 'passed').map(t => t.name).sort();
    return green.length
      // d26832d6 #21: it now runs after the tests are written too, where "red set" means nothing.
      ? { outcome: 'fail', detail: `new test(s) passing on arrival, never seen failing without the change: ${list(green)}. Show each one fails with the change it covers reverted (on the step that writes tests, it is also left out of the red set).` }
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
    // d26832d6: the field agent had edited an existing test's fixture for the
    // new behaviour here. The refusal says where that edit belongs.
    return broke.length ? { outcome: 'fail', detail: `passed when the step began, not now: ${list(broke)}. If an existing test's expectation changes with the behaviour being built, change it on the step that writes the code, not here; otherwise put it back.` } : { outcome: 'pass', detail: 'ok' };
  },

  'red-set-passes-by-name': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const red = ctx.records.redSet;
    if (!Array.isArray(red)) return { outcome: 'unavailable', soft: true, detail: "no 'redSet' record: the step that writes tests did not produce one for this card (it entered that step before checks, or its tests could not be judged there)" };
    const status = new Map(now.tests.map(t => [t.name, t.status]));
    /*
     * CGLAB-418: a reader older than this recorded a file that failed to load
     * as a test named after itself, a name that never returns once the file
     * loads. It stands for that file's tests: open until the file reports
     * tests and every one of them passes.
     */
    const openBecause = (n: string): string | null => {
      if (status.has(n)) return status.get(n) === 'passed' ? null : String(status.get(n));
      const file = loadFailureFileOf(n);
      if (!file) return 'missing';
      const inFile = now.tests.filter(t => t.file === file);
      if (!inFile.length) return `${file} reports no tests`;
      return inFile.every(t => t.status === 'passed') ? null : `a test in ${file} is not passing`;
    };
    const whys = red.map(String).flatMap(n => { const why = openBecause(n); return why ? [{ n, why }] : []; });
    const open = whys.map(o => `${o.n} [${o.why}]`);
    return open.length
      // e2ab4ced: which were renamed or removed (answerable) and which still fail (never).
      ? { outcome: 'fail', detail: `not passing yet: ${list(open)}`, meta: { missing: whys.filter(o => o.why === 'missing').map(o => o.n), notPassing: whys.filter(o => o.why !== 'missing').map(o => o.n) } }
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
    // Only the report the capture writes is left out: a NEW file can load on
    // its own (a conftest.py, an init()) and mask the tests, where the final
    // verify would not see it (5b48b96b re-review).
    for (const f of [...new Set([...Object.keys(base), ...Object.keys(cur)])].filter(f => !ctx.ignoredPaths.some(ig => within(f, ig)))) {
      if (!(f in cur)) changes.push(`deleted ${f}`);
      else if (!(f in base)) { if (p.mode === 'strict') changes.push(`added ${f}`); }
      else if (base[f] !== cur[f]) changes.push(`edited ${f}`);
    }
    return changes.length
      ? { outcome: 'fail', detail: `the tests changed: ${list(changes)}. Put them back; ${p.mode === 'strict' ? 'nothing may change here' : 'only new test files may be added'}.` }
      : { outcome: 'pass', detail: p.mode === 'strict' ? 'unchanged' : 'unchanged (new files allowed)' };
  },

  /*
   * d26832d6 #21 — test files added after the tests were frozen: no suite runs
   * for this (a per-test run on leaving review would cost one on most cards),
   * so it cannot tell whether they pass. It names them, and asks for the proof.
   */
  'tests-added-late': ctx => {
    /*
     * CGLAB-420: at a parent the tests were frozen by its children, one freeze
     * each, each of the WHOLE tree's test files. A file a child committed is
     * late unless that child's own freeze has it (a later sibling's freeze
     * must not launder it); anything else, unless some freeze has it.
     */
    const kids = ctx.records.testSurface ? [] : (ctx.descendantSurfaces ?? []).filter(k => k.head);
    const frozen = (ctx.records.testSurface ?? (kids.length ? {
      files: Object.assign({}, ...kids.map(k => k.files)), head: kids[0].head, complete: kids.every(k => k.complete),
    } : undefined)) as { files?: unknown; head?: unknown; complete?: unknown } | undefined;
    const descendants = new Set(kids.map(k => k.itemId));
    const freezeOf = new Map(kids.map(k => [k.itemId, k.files]));
    /** Files a descendant committed, by that descendant: judged against its own freeze. */
    const addedBy = new Map<string, string>();
    if (!frozen || typeof frozen !== 'object') return { outcome: 'unavailable', soft: true, detail: "no 'testSurface' record: no step wrote tests for this card" };
    if (typeof frozen.head !== 'string' || !frozen.head) return { outcome: 'unavailable', soft: true, detail: 'the tests were frozen before agenfk recorded the commit they were frozen at, so what came after cannot be told apart' };
    // An incomplete freeze does not know every test that existed then: anything could read as late.
    if (frozen.complete === false || !frozen.files || typeof frozen.files !== 'object') return { outcome: 'unavailable', soft: true, detail: 'the tests were frozen with an incomplete surface, so a late test cannot be told from one that was there' };
    if (!ctx.root) return { outcome: 'unavailable', soft: true, detail: 'the card has no tree (no project root, no worktree)' };
    const base = frozen.files as Record<string, string>;
    const own = new Set<string>();
    try {
      // Paths relative to the card's tree, whatever the repository's shape; NUL-separated,
      // no rename detection (a user's diff.renames must not decide this).
      const z = (args: string[]) => ctx.git(['-C', ctx.root!, ...args]).split('\0').filter(Boolean);
      // What is left out, and nothing more (review): commits already on a remote's
      // DEFAULT branch - main's work, however it came in (merge, fast-forward,
      // rebase) - and the server's own close/step commits for ANOTHER card. The
      // card's own branch being pushed hides nothing. Known limits: another
      // agent's untagged commit fast-forwarded from a LOCAL branch, and another
      // agent's file in a shared tree, still count; so does a default branch not
      // named main/master when refs/remotes/<r>/HEAD is absent (a clone sets it,
      // `git remote add` does not); a hand-written close() subject naming another
      // real card would hide a test (a warning, not a gate).
      const defaults = ctx.git(['-C', ctx.root, 'for-each-ref', '--format=%(refname)', 'refs/remotes/*/HEAD', 'refs/remotes/*/main', 'refs/remotes/*/master'])
        .split('\n').map(r => r.trim()).filter(Boolean);
      const log = ctx.git(['-C', ctx.root, 'log', '--first-parent', '--no-merges', '--no-renames', '--diff-filter=A', '--name-only', '--relative', '-z', '--format=%x01%s', `${frozen.head}..HEAD`, ...(defaults.length ? ['--not', ...defaults] : [])]);
      for (const block of log.split('\x01').filter(Boolean)) {
        const [subject, ...names] = block.split(/\n|\0/).filter(Boolean);
        const other = /^(close|step)\([^)]*\):.*\[([0-9a-f]{8}-[0-9a-f-]{27,})\]\s*$/.exec(subject ?? '')?.[2];
        if (other && other !== ctx.item.id && !descendants.has(other)) continue;
        for (const n of names) { own.add(n); if (other && descendants.has(other)) addedBy.set(n, other); }
      }
      for (const f of z(['diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '--relative', '-z'])) own.add(f);
      for (const f of z(['ls-files', '--others', '--exclude-standard', '-z'])) own.add(f);
    } catch (e: any) {
      return { outcome: 'unavailable', soft: true, detail: `git could not list what was added since ${frozen.head.slice(0, 12)}: ${e?.message ?? e}` };
    }
    const late = [...own]
      // Still there: added then deleted is no late test.
      .filter(f => fs.existsSync(path.join(ctx.root!, f)))
      .filter(f => !ctx.ignoredPaths.some(p => within(f, p)))
      .filter(f => ANY_TEST_FILE_PATTERN.test(f) && (addedBy.has(f) ? !(f in (freezeOf.get(addedBy.get(f)!) ?? {})) : !(f in base)));
    return late.length
      ? { outcome: 'fail', detail: `test file(s) added after the tests were frozen: ${list(late)}. Nothing has shown they do anything: show each one fails without the change it covers.` }
      : { outcome: 'pass', detail: 'no new test file since the tests were frozen (tests added inside existing test files are not looked at)' };
  },

  'test-set-identical': ctx => {
    const now = currentTests(ctx);
    if (isVerdict(now)) return now;
    const before = entryTests(ctx);
    if (isVerdict(before)) return before;
    // d26832d6 #19: tests are named by what the report says; a different report
    // setting names them differently, and every test then reads as removed and re-added.
    const e = ctx.entry as any, c = now.capture as any;
    const reportsDiffer = Array.isArray(e?.reportPaths) && Array.isArray(c?.reportPaths) && JSON.stringify(e.reportPaths) !== JSON.stringify(c.reportPaths);
    if (e && (e.command !== c.command || e.format !== c.format || reportsDiffer)) {
      return { outcome: 'fail', detail: "the project's test report setting changed since this step's baseline was taken (its command or format), (its command, format or reports), so the test names cannot be compared. Re-enter the step to take a baseline under the new setting: the change is on the card's record." };
    }
    const was = new Set(before.map(t => t.name));
    const is = new Set(now.tests.map(t => t.name));
    const diff = [...[...was].filter(n => !is.has(n)).map(n => `-${n}`), ...[...is].filter(n => !was.has(n)).map(n => `+${n}`)];
    return diff.length ? { outcome: 'fail', detail: `the tests changed: ${list(diff)}` } : { outcome: 'pass', detail: `${is.size} tests, identical` };
  },

  // CGLAB-420: a child's warning never reached the parent's reviewer.
  'tree-warnings': ctx => {
    const ws = ctx.treeWarnings ?? [];
    return ws.length
      ? { outcome: 'fail', detail: `${ws.length} warning(s) raised in this card's tree; the reviewer should see each: ${list(describeTreeWarnings(ws).split('\n'))}` }
      : { outcome: 'pass', detail: 'no warning was raised in this card\'s tree' };
  },

  /*
   * CGLAB-420: the fixes to a review's findings are written after the reviewer
   * read the diff. Judged when the review is recorded, from the card's changes
   * in files written after the reviewer began. File times are evidence enough
   * to tell a reviewer and the PR, not to refuse an honest card: a warning.
   */
  'fixes-reviewed': ctx => {
    const r = ctx.review;
    if (!r) return { outcome: 'unavailable', soft: true, detail: 'no review evidence was gathered' };
    const rec: any = r.records[r.records.length - 1];
    if (!rec) return { outcome: 'pass', detail: r.childCount > 0 || !r.hasParent ? 'no review is recorded yet (review-record judges that)' : 'reviewed with its parent' };
    if (rec.unreviewedNotJudged) return { outcome: 'unavailable', soft: true, detail: `whether anything changed after the reviewer began was not judged: ${rec.unreviewedNotJudged}` };
    const after = rec.unreviewed;
    if (!after) return { outcome: 'unavailable', soft: true, detail: 'the review was recorded by an older agenfk, which did not note what changed after the reviewer began' };
    return after.lines > MAX_UNREVIEWED_LINES
      ? { outcome: 'fail', detail: `${after.lines} lines changed after the reviewer began, which it cannot have read: ${list(after.files)}. Have a reviewer read them (a new one, or the same one given a new message), then record that review.` }
      : { outcome: 'pass', detail: after.lines ? `${after.lines} line(s) of follow-up after the reviewer began (up to ${MAX_UNREVIEWED_LINES} pass as follow-up)` : 'nothing changed after the reviewer began' };
  },

  'review-record': (ctx, p) => {
    const r = ctx.review;
    if (!r) return { outcome: 'unavailable', detail: 'no review evidence was gathered' };
    const isParent = r.childCount > 0 || !r.hasParent;
    if (p.appliesTo !== 'every-card' && !isParent) return { outcome: 'pass', detail: 'reviewed with its parent: reviews happen at the parent card' };
    const verdict = judgeReview(r, ctx.root, ctx.git, { bindTree: true });
    const rec = r.records[r.records.length - 1];
    if (verdict.outcome !== 'pass' || !rec) return verdict;
    return verdict;
  },

  'human-approval': (ctx, p) => {
    const { own: a, up } = countedApproval(p, ctx.approvals, ctx.inheritedApprovals);
    if (a) return { outcome: 'pass', detail: `approved on the board at ${a.at}${a.note ? `: ${a.note}` : ''}` };
    if (up) return { outcome: 'pass', detail: `approved with its parent ${up.from.slice(0, 8)} on the board at ${up.at}` };
    const how = p.signature === 'passkey' ? ', signed with a passkey' : '';
    return { outcome: 'fail', detail: `waiting for a person to approve this step on the board${how} (agenfk ui --open ${ctx.item.id} --details). An agent cannot approve.` };
  },

  // efcacdeb: carried out by the coding agent and reported on verify; the server takes its word, labelled.
  'agent-check': (ctx, p) => {
    const r = ctx.agentReports?.[p.name];
    if (!r) return { outcome: 'fail', detail: `not reported yet. The step asks: ${p.instruction} When it is done, report it: agenfk verify ${ctx.item.id} --check ${p.name}=pass (or =fail) --check-note ${p.name}="<what you found>" --evidence "<evidence>" (MCP: validate_progress with agentChecks).` };
    const meta = { reported: true, ...(r.note ? { note: r.note } : {}) };
    if (r.outcome === 'fail') return { outcome: 'fail', detail: `the agent reported it failed${r.note ? `: ${r.note}` : ''}`, meta };
    return { outcome: 'pass', detail: `agent-reported${r.note ? `: ${r.note}` : ''}`, meta };
  },

  // efcacdeb: run by the server before the engine (commandChecks.ts); judged here.
  'command-check': (ctx, p) => ctx.commandResults?.[`command-check:${p.name}`] ?? { outcome: 'unavailable', detail: 'the command did not run on this verify' },

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
    if (c.exitCode === 0 && !failed.length && !broken.length) {
      return { outcome: 'pass', detail: `${(c.tests ?? []).length} tests, exit code ${c.exitCode}` };
    }
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
    const present = new Set(now.tests.map(t => t.name));
    return n >= before.length
      ? { outcome: 'pass', detail: `${before.length} → ${n} tests` }
      : { outcome: 'fail', detail: `${before.length} → ${n} tests: fewer than when the step began. Missing: ${list(before.map(t => t.name).filter(x => !present.has(x)))}` };
  },
};

type Approval = NonNullable<EngineContext['approvals']>[number];
type InheritedApproval = NonNullable<EngineContext['inheritedApprovals']>[number];
/**
 * The approval that satisfies a human-approval check: the step's latest own
 * one, else (unless it applies to every card) the nearest ancestor's. A step
 * that asks for a passkey counts only approvals signed with one (CGLAB-383).
 */
export function countedApproval(p: Record<string, string>, approvals: readonly Approval[] | undefined, inherited: readonly InheritedApproval[] | undefined): { own?: Approval; up?: InheritedApproval } {
  const counts = (x: { authority?: string }) => p.signature !== 'passkey' || x.authority === 'passkey';
  const own = (approvals ?? []).filter(counts);
  if (own.length) return { own: own[own.length - 1] };
  const up = p.appliesTo === 'every-card' ? undefined : (inherited ?? []).filter(counts)[0];
  return up ? { up } : {};
}

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
    if (ctx.deferToApproval?.includes(c.id)) {
      results.push({ ...base, outcome: 'deferred', blocking: false, detail: "judged once a person approves: nothing it finds could let the card go before that, so the verify after the approval runs it" });
      continue;
    }
    if (c.id === 'server-owned-verify' || ctx.deferToCommand.includes(c.id)) {
      const detail = ctx.deferredToParent
        ? `not run on this card: the flow runs the project's suite once, at the top-level card, and [${ctx.deferredToParent.id.substring(0, 8)}] "${ctx.deferredToParent.title}" is still open`
        : "enforced on this transition by the project's verify command";
      results.push({ ...base, outcome: 'deferred', blocking: false, detail });
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
    // 5a8d22e6 changed the no-report detail: an override given against the old wording still covers it.
    const overridden = o && (o.detail === undefined || o.detail === verdict.detail || (verdict.meta?.code === 'NO_TEST_REPORT' && o.detail === LEGACY_NO_REPORT_DETAIL)) ? o : undefined;
    results.push({ ...base, outcome: verdict.outcome, detail: verdict.detail, blocking: blocks && !overridden, ...(overridden ? { overridden } : {}), ...(c.id.startsWith('agent-check:') ? { agentReported: true } : {}), ...(verdict.meta ? { meta: verdict.meta } : {}) });
    if (verdict.outcome === 'pass' && verdict.produces) Object.assign(produced, verdict.produces);
  }
  return { results, blocked: results.some(r => r.blocking), produced };
}

/** Does any applicable check need a test-report capture? */
export function needsCapture(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && c.id !== 'server-owned-verify' && checkDef(c.id)?.needsCapture);
}

/** Is this check slow because it talks to a remote (1049ce52)? */
export const needsNetwork = (c: ResolvedCheck): boolean => !!checkDef(c.id)?.network;

/** Does any applicable check read the step's entry record? */
export function needsEntryRecord(resolved: readonly ResolvedCheck[]): boolean {
  return resolved.some(c => c.applicable && checkDef(c.id)?.requires(c.params).includes('stepEntryTests'));
}

const MARK: Record<CheckOutcome, string> = { pass: '✅', fail: '❌', unavailable: '⛔', 'n/a': '➖', deferred: '⏩' };

/**
 * One line per result, blocking ones LAST (d26832d6 #8): the reason a card is
 * held sits right above the verdict, where `tail` and a reader's eye land, not
 * above a screen of passes and suite output.
 */
export function formatCheckResults(results: readonly CheckResult[]): string {
  const rank = (r: CheckResult) => (r.blocking ? 2 : r.outcome === 'fail' || r.outcome === 'unavailable' ? 1 : 0);
  return [...results].sort((a, b) => rank(a) - rank(b)).map(r => {
    const mark = r.overridden ? '🔓' : !r.blocking && (r.outcome === 'fail' || r.outcome === 'unavailable') ? '⚠️' : MARK[r.outcome];
    // A non-blocking unavailable is said to be one: it judged nothing (d26832d6 #9).
    const soft = !r.blocking && !r.overridden && r.outcome === 'unavailable' ? ' (not judged, not blocking)' : '';
    const why = r.overridden ? ` (overridden by a person: ${r.overridden.reason})` : r.answer ? ` (answered: ${r.answer})` : '';
    return `${mark} ${r.id} [${r.severity}${r.source === 'flow' ? ', added by the flow' : ''}]: ${r.outcome}${soft}${r.detail ? ` — ${r.detail}` : ''}${why}`;
  }).join('\n');
}

/**
 * What this verify did with the suite, in one line (d26832d6 #0/#15): ran it,
 * reused a green of exactly this content (and whose), or ran only the test
 * files that changed. A reused run must never read as a measured one.
 */
/**
 * 001aed1e: a capture is green only when its REPORT says so. A command that
 * joins suites with `;` exits with the last suite's code, so an exit of 0
 * alone once let a run with failures stand as the tree's green, replayed by
 * every later verify at the same content. With no per-test report, the exit
 * code is all there is.
 */
export function capturedGreen(capture: any): boolean {
  if (!capture || capture.exitCode !== 0) return false;
  // de5e5a03: results that could not be read back say nothing - never a green.
  if (capture.testsMissing) return false;
  if (capture.available !== true) return true;
  return !(capture.tests ?? []).some((t: any) => t?.status === 'failed') && !(capture.brokenFiles ?? []).length;
}

export function describeCapture(capture: any): string | null {
  if (!capture || capture.kind !== 'capture') return null;
  if (capture.surfaceRereadFrom) return `🔁 suite not re-run: the report it wrote at ${capture.surfaceRereadFrom.at} was read again for the new declared test paths`;
  if (capture.reusedFrom) {
    const from = capture.reusedFrom;
    return `🔁 suite not re-run: this tree's content was already tested${capturedGreen(capture) ? ' green' : ''} at ${from.at ?? '?'} (${from.step ?? 'a close'} of card ${String(from.itemId ?? '').slice(0, 8)})`;
  }
  // a36047ea: the tests the changed code affects, not the whole suite.
  if (capture.lazy && capture.related) return `▶ ran the ${capture.ranFiles?.length ?? 0} test file(s) affected by ${capture.changedFiles?.length ?? 0} changed file(s), over its entry results`;
  if (capture.lazy) return `▶ ran only the ${capture.ranFiles?.length ?? 0} test file(s) changed since this step began, over its entry results`;
  return `▶ ran the suite (exit ${capture.exitCode})${capture.available === false && capture.parseError ? ` — its report could not be used: ${capture.parseError}` : ''}${typeof capture.relatedHint === 'string' ? `\n${capture.relatedHint}` : ''}`;
}
