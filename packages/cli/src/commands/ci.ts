import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * `agenfk ci check` (RFC-002, task bf07b5ef): may this CI step be skipped
 * because a receipt already certifies what it would do?
 *
 * The answer is the exit code — 0 reuse, 10 run the step, 1 the policy
 * requires a receipt and none qualifies — plus GITHUB_OUTPUT lines, a step
 * summary and the original report or findings on disk. The call is the
 * mapping: `--kind verification` stands for the repository's verify command,
 * `--kind review --lens <name>` for an independent review that performed that
 * lens. There is no mapping file and no hub setting for it.
 *
 * What CI compares is its OWN checkout: the tree of HEAD, which on a GitHub
 * `pull_request` run is the PR's merge result. A receipt's tree is the tree its
 * producer tested, so a match means byte-identical content — including CI
 * workflows, lockfiles and test configuration, which is why a PR that changes
 * any of them can never reuse a receipt taken before the change.
 *
 * The step is skipped only in Enforce, and only when a candidate qualifies on
 * every count. Anything the check cannot establish — a hub error, a timeout, a
 * report it cannot download — runs the step, or blocks under `--policy
 * require`. It is never 0.
 */

export class CiCheckUsageError extends Error {}

export type CiKind = 'verification' | 'review';
export type CiPolicy = 'run' | 'require';
type Env = Record<string, string | undefined>;

export const EXIT_REUSE = 0;
export const EXIT_RUN = 10;
export const EXIT_BLOCK = 1;

const KINDS: readonly CiKind[] = ['verification', 'review'];
const POLICIES: readonly CiPolicy[] = ['run', 'require'];
/** Same rule the server applies to a recorded review's lenses. */
const LENS_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REPORT_DIR = '.agenfk-ci';

// ── context ─────────────────────────────────────────────────────────────────

export interface CiContext {
  repo: string;
  pr: number | null;
  tree: string;
}

function parsePr(value: unknown): number {
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) {
    throw new CiCheckUsageError(`--pr must be a positive whole number, not "${text}"`);
  }
  return Number(text);
}

const gitOut = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
};

/** The PR a GitHub run is for: the event payload, else a refs/pull/N/... ref. */
function githubPr(env: Env): number | null {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      const n = event?.pull_request?.number ?? event?.number;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
    } catch { /* no readable event: the ref may still say */ }
  }
  const m = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Repository, PR and content tree for this run. Flags win; then the GitHub
 * environment; then the checkout's own origin remote (GitLab, Jenkins, ...).
 * The tree is always computed here, from the checkout, unless a flag names it.
 */
export function resolveCiContext(input: {
  cwd: string;
  env: Env;
  repo?: string;
  pr?: string | number;
  tree?: string;
}): CiContext {
  const { cwd, env } = input;
  const tree = input.tree?.trim() || gitOut(cwd, ['rev-parse', 'HEAD^{tree}']);
  if (!tree) throw new CiCheckUsageError(`${cwd} is not a git checkout with a commit: run the check inside the checked-out repository`);

  let repo = input.repo?.trim() || null;
  if (!repo && env.GITHUB_REPOSITORY) {
    repo = `${(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')}/${env.GITHUB_REPOSITORY}.git`;
  }
  if (!repo) repo = gitOut(cwd, ['remote', 'get-url', 'origin']);
  if (!repo) throw new CiCheckUsageError('no repository: pass --repo, or run in a checkout with an origin remote');

  const pr = input.pr !== undefined && input.pr !== null && String(input.pr).trim() !== ''
    ? parsePr(input.pr)
    : githubPr(env);
  return { repo, pr, tree };
}

// ── the hub ─────────────────────────────────────────────────────────────────

/** A candidate as GET /v1/ci/receipts summarises it. */
interface Candidate {
  id: string;
  kind: CiKind;
  cardId: string | null;
  contentTree: string | null;
  commit: string | null;
  commandRevision: number | null;
  reusable: boolean;
  notReusableReason: string | null;
  installationId: string;
  producerAllowed: boolean;
  receivedAt: string;
  /** When the evidence was made (the run's finish, the review's record); null when the receipt cannot say. */
  evidenceAt?: string | null;
  lenses?: string[];
  report: { available: boolean; bytes: number | null };
}

interface Lookup {
  repo: string;
  settings: { verifyCommand: string; revision: number | null; receiptsMode: string };
  lookup: { by: string | null; pr: number | null; cardId: string | null; tree: string | null };
  receipts: Candidate[];
}

class HubError extends Error {}

/**
 * GET one hub path and read its WHOLE body under one deadline. The deadline
 * covers the body as well as the headers: a hub that answers 200 and then
 * stalls would otherwise hold CI forever (Codex review).
 */
async function hubGet<T>(hubUrl: string, token: string, pathAndQuery: string, timeoutMs: number, read: (res: Response) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const where = pathAndQuery.split('?')[0];
  try {
    const res = await fetch(`${hubUrl.replace(/\/+$/, '')}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new HubError(`the hub answered ${res.status} for ${where}`);
    try {
      return await read(res);
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      throw new HubError(`the hub's answer for ${where} could not be read`);
    }
  } catch (e) {
    if (e instanceof HubError) throw e;
    throw new HubError(ctl.signal.aborted ? `the hub did not answer within ${timeoutMs} ms` : `the hub could not be reached: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const hubJson = <T>(hubUrl: string, token: string, p: string, timeoutMs: number): Promise<T> =>
  hubGet(hubUrl, token, p, timeoutMs, async (res) => (await res.json()) as T);

const isLookup = (v: any): v is Lookup =>
  !!v && typeof v === 'object' && !!v.settings && typeof v.settings.receiptsMode === 'string' && Array.isArray(v.receipts);

// ── the decision ────────────────────────────────────────────────────────────

export type CiReason =
  | 'matched' | 'shadow_mode' | 'receipts_off' | 'hub_unavailable' | 'no_receipt' | 'tree_mismatch'
  | 'command_revision_changed' | 'lens_not_covered' | 'not_reusable' | 'producer_not_allowed'
  | 'stale' | 'report_unavailable';

const REASON_TEXT: Record<CiReason, string> = {
  matched: 'a receipt certifies this exact content',
  shadow_mode: 'the repository is in Shadow: every step runs, and this one would have been reused',
  receipts_off: 'receipts are off for this repository',
  hub_unavailable: 'the hub could not answer, so nothing can be reused',
  no_receipt: 'no receipt for this pull request or content',
  tree_mismatch: 'no receipt was taken on this exact content (the merge result differs from what was tested)',
  command_revision_changed: "the repository's verify command was revised after the receipt was taken",
  lens_not_covered: 'no recorded review performed the lens this step stands for',
  not_reusable: 'the hub ruled the receipt not reusable',
  producer_not_allowed: 'the machine that produced the receipt is no longer an allowed producer',
  stale: 'the receipt is older than --max-age allows',
  report_unavailable: "the receipt's report could not be downloaded",
};

export interface CiCheckResult {
  outcome: 'reuse' | 'run' | 'block';
  reason: CiReason;
  detail: string;
  mode: string | null;
  wouldReuse: boolean;
  receiptId: string | null;
  kind: CiKind;
  lens: string | null;
  repo: string;
  pr: number | null;
  tree: string;
  files: string[];
}

export interface CiCheckOptions extends CiContext {
  kind: CiKind;
  lens?: string | null;
  policy: CiPolicy;
  hubUrl: string;
  token: string;
  maxAgeDays?: number | null;
  reportDir: string;
  timeoutMs: number;
  githubOutput?: string | null;
  stepSummary?: string | null;
  now?: Date;
}

const isRevision = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Why `c` cannot stand in for this step, or null when it can. Checked in this order. */
function disqualify(c: Candidate, opts: CiCheckOptions, settings: Lookup['settings'], now: Date): CiReason | null {
  if (c.kind !== opts.kind || c.contentTree !== opts.tree) return 'tree_mismatch';
  // Both revisions must BE revisions: two missing ones are not equal (Codex review).
  if (opts.kind === 'verification'
    && !(isRevision(c.commandRevision) && isRevision(settings.revision) && c.commandRevision === settings.revision)) return 'command_revision_changed';
  if (opts.kind === 'review' && !(c.lenses ?? []).includes(opts.lens as string)) return 'lens_not_covered';
  if (c.reusable !== true) return 'not_reusable';
  if (c.producerAllowed !== true) return 'producer_not_allowed';
  if (opts.maxAgeDays != null) {
    // From when the evidence was MADE: a receipt that waited offline for weeks
    // reaches the hub "new" and is still weeks old (Codex review).
    const age = now.getTime() - Date.parse(c.evidenceAt ?? '');
    if (!Number.isFinite(age) || age > opts.maxAgeDays * 864e5) return 'stale';
  }
  if (opts.kind === 'verification' && !c.report?.available) return 'report_unavailable';
  return null;
}

/** The first qualifying candidate (newest first), or the most telling reason none does. */
function choose(candidates: Candidate[], opts: CiCheckOptions, settings: Lookup['settings'], now: Date): { match: Candidate | null; reason: CiReason } {
  if (!candidates.length) return { match: null, reason: 'no_receipt' };
  let reason: CiReason | null = null;
  for (const c of candidates) {
    const why = disqualify(c, opts, settings, now);
    if (!why) return { match: c, reason: 'matched' };
    // The reason of the newest candidate on this content says most; a tree
    // mismatch only when no candidate had the content at all.
    if (why !== 'tree_mismatch' && reason === null) reason = why;
  }
  return { match: null, reason: reason ?? 'tree_mismatch' };
}

/**
 * Download what the skipped step would have produced, so the job can publish
 * it: the run's log for a verification, the findings for a review. Returns the
 * files written and the full receipt.
 */
async function fetchEvidence(c: Candidate, opts: CiCheckOptions): Promise<{ files: string[]; receipt: any }> {
  const id = encodeURIComponent(c.id);
  const full = await hubJson<any>(opts.hubUrl, opts.token, `/v1/ci/receipts/${id}`, opts.timeoutMs);
  // The detail must BE this receipt, of this kind, and a review must carry its
  // findings: a 200 with anything else is evidence nobody downloaded (Codex review).
  const receipt = full?.receipt;
  if (!receipt || receipt.id !== c.id || receipt.kind !== opts.kind) throw new EvidenceError();
  if (opts.kind === 'review' && !Array.isArray(receipt.review?.findings)) throw new EvidenceError();
  fs.mkdirSync(opts.reportDir, { recursive: true });
  const safe = c.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const files: string[] = [];
  if (opts.kind === 'verification') {
    let log: string;
    try {
      log = await hubGet(opts.hubUrl, opts.token, `/v1/ci/receipts/${id}/report`, opts.timeoutMs, (res) => res.text());
    } catch {
      throw new EvidenceError();
    }
    const file = path.join(opts.reportDir, `${safe}.log`);
    fs.writeFileSync(file, log);
    files.push(file);
  } else {
    const file = path.join(opts.reportDir, `${safe}.findings.json`);
    fs.writeFileSync(file, JSON.stringify(receipt.review.findings, null, 2));
    files.push(file);
  }
  return { files, receipt };
}

class EvidenceError extends Error {}

// ── outputs ─────────────────────────────────────────────────────────────────

const code = (s: unknown) => `\`${String(s ?? '').replace(/`/g, "'")}\``;
// Backslashes first: `\|` would otherwise come out as an escaped backslash and
// a live pipe that ends the cell (CodeQL 169).
const cell = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function summaryMarkdown(r: CiCheckResult, match: Candidate | null, receipt: any): string {
  const what = r.kind === 'review' ? `review (${r.lens})` : 'verification';
  if (r.outcome === 'reuse' && match) {
    const rows: Array<[string, string]> = [
      ['Receipt', code(match.id)],
      ['Card', `${code(match.cardId)} ${cell(receipt?.card?.title ?? '')}`.trim()],
    ];
    if (r.kind === 'verification') {
      rows.push(['Execution', `${code(receipt?.execution?.id)} ${code(receipt?.execution?.command)} (revision ${cell(match.commandRevision)})`]);
    } else {
      const reviewer = receipt?.review?.reviewer ?? {};
      rows.push(['Review', `${code(receipt?.review?.recordId)} by ${cell(reviewer.client)} (session ${cell(reviewer.sessionId)})`]);
      rows.push(['Lenses', cell((match.lenses ?? []).join(', '))]);
    }
    rows.push(['Producer', code(match.installationId)]);
    rows.push(['Content', `tree ${code(match.contentTree)} commit ${code(match.commit)}`]);
    for (const f of r.files) rows.push([r.kind === 'review' ? 'Findings' : 'Report', code(f)]);
    return [
      `### ♻️ Reused result: ${what}`,
      '',
      `This step was not run. Receipt ${code(match.id)} certifies this exact content (${r.mode}).`,
      '',
      '| | |',
      '|---|---|',
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      '',
    ].join('\n');
  }
  if (r.mode === 'shadow') {
    return [
      `### 🌗 Shadow: ${what}`,
      '',
      r.wouldReuse
        ? `The step runs (Shadow). In Enforce it would have reused receipt ${code(r.receiptId)}.`
        : `The step runs (Shadow). In Enforce it would also run: ${r.detail}.`,
      '',
    ].join('\n');
  }
  const head = r.outcome === 'block' ? `### ⛔ No qualifying receipt: ${what}` : `### ▶️ Running: ${what}`;
  return [head, '', `${r.detail} (\`${r.reason}\`).`, ''].join('\n');
}

function writeOutputs(r: CiCheckResult, opts: CiCheckOptions, markdown: string): void {
  if (opts.githubOutput) {
    // One line per output: a value carrying a newline (a receipt id from the
    // hub, say) would otherwise start a line of its own and forge another
    // output, `run=false` included (Codex review).
    const oneLine = (v: unknown) => String(v ?? '').replace(/[\r\n]+/g, ' ');
    const lines = [
      `run=${r.outcome === 'reuse' ? 'false' : 'true'}`,
      `decision=${r.outcome}`,
      `reason=${r.reason}`,
      `receipt-id=${oneLine(r.receiptId)}`,
      `would-reuse=${r.wouldReuse}`,
      `mode=${oneLine(r.mode)}`,
    ];
    fs.appendFileSync(opts.githubOutput, lines.join('\n') + '\n');
  }
  if (opts.stepSummary) fs.appendFileSync(opts.stepSummary, markdown + '\n');
}

// ── the check ───────────────────────────────────────────────────────────────

export async function runCiCheck(opts: CiCheckOptions): Promise<{ exitCode: number; result: CiCheckResult }> {
  if (!KINDS.includes(opts.kind)) throw new CiCheckUsageError(`--kind must be one of ${KINDS.join(', ')}`);
  if (!POLICIES.includes(opts.policy)) throw new CiCheckUsageError(`--policy must be one of ${POLICIES.join(', ')}`);
  const lens = opts.lens?.trim() || null;
  if (opts.kind === 'review' && !lens) {
    throw new CiCheckUsageError('a review step must name the lens it stands for (--lens general, --lens security, ...)');
  }
  if (lens && !LENS_NAME.test(lens)) throw new CiCheckUsageError(`--lens "${lens}" is not a lens name`);
  const o: CiCheckOptions = { ...opts, lens };
  const now = opts.now ?? new Date();

  const base = { kind: o.kind, lens, repo: o.repo, pr: o.pr, tree: o.tree, files: [] as string[] };
  const finish = (r: CiCheckResult, match: Candidate | null = null, receipt: any = null) => {
    writeOutputs(r, o, summaryMarkdown(r, match, receipt));
    const exitCode = r.outcome === 'reuse' ? EXIT_REUSE : r.outcome === 'block' ? EXIT_BLOCK : EXIT_RUN;
    return { exitCode, result: r };
  };
  const notReused = (mode: string | null, reason: CiReason, detail = REASON_TEXT[reason]) => finish({
    ...base,
    // Off and Shadow never block: they change nothing about what CI runs.
    outcome: o.policy === 'require' && (mode === null || mode === 'enforce') ? 'block' : 'run',
    reason, detail, mode, wouldReuse: false, receiptId: null,
  });

  const qs = new URLSearchParams({ repo: o.repo, kind: o.kind, tree: o.tree });
  if (o.pr !== null) qs.set('pr', String(o.pr));
  if (lens) qs.set('lens', lens);

  let lookup: Lookup;
  try {
    const body = await hubJson<unknown>(o.hubUrl, o.token, `/v1/ci/receipts?${qs}`, o.timeoutMs);
    if (!isLookup(body)) throw new HubError("the hub's answer is not a receipt lookup");
    lookup = body;
  } catch (e) {
    return notReused(null, 'hub_unavailable', `${REASON_TEXT.hub_unavailable}: ${(e as Error).message}`);
  }

  const mode = lookup.settings.receiptsMode;
  if (mode !== 'shadow' && mode !== 'enforce') return notReused(mode, 'receipts_off');

  const { match, reason } = choose(lookup.receipts, o, lookup.settings, now);
  if (!match) return notReused(mode, reason);

  if (mode === 'shadow') {
    return finish({ ...base, outcome: 'run', reason: 'shadow_mode', detail: REASON_TEXT.shadow_mode, mode, wouldReuse: true, receiptId: match.id });
  }

  let evidence: { files: string[]; receipt: any };
  try {
    evidence = await fetchEvidence(match, o);
  } catch (e) {
    return notReused(mode, e instanceof EvidenceError ? 'report_unavailable' : 'hub_unavailable');
  }
  return finish(
    { ...base, files: evidence.files, outcome: 'reuse', reason: 'matched', detail: REASON_TEXT.matched, mode, wouldReuse: true, receiptId: match.id },
    match,
    evidence.receipt,
  );
}

// ── the command ─────────────────────────────────────────────────────────────

export interface CiCheckRawOptions {
  kind?: string;
  lens?: string;
  policy?: string;
  hub?: string;
  repo?: string;
  pr?: string;
  tree?: string;
  maxAge?: string;
  reportDir?: string;
  timeout?: string;
  json?: boolean;
}

/** Everything but process.exit: resolves the run's context and options, runs the check, returns the exit code. */
export async function runCiCheckCommand(
  raw: CiCheckRawOptions,
  io: { cwd: string; env: Env; log?: (line: string) => void },
): Promise<number> {
  const log = io.log ?? ((l: string) => console.error(l));
  try {
    const hubUrl = raw.hub?.trim() || io.env.AGENFK_HUB_URL?.trim();
    const token = io.env.AGENFK_CI_TOKEN?.trim();
    if (!hubUrl) throw new CiCheckUsageError('no hub: pass --hub or set AGENFK_HUB_URL');
    if (!token) throw new CiCheckUsageError('no CI token: set AGENFK_CI_TOKEN to a ci_ token an org admin minted on the hub');
    const kind = (raw.kind ?? '') as CiKind;
    if (!KINDS.includes(kind)) throw new CiCheckUsageError(`--kind must be one of ${KINDS.join(', ')}`);
    const policy = (raw.policy ?? 'run') as CiPolicy;
    if (!POLICIES.includes(policy)) throw new CiCheckUsageError(`--policy must be one of ${POLICIES.join(', ')}`);
    let maxAgeDays: number | null = null;
    if (raw.maxAge !== undefined) {
      maxAgeDays = Number(raw.maxAge);
      if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new CiCheckUsageError('--max-age must be a positive number of days');
    }
    const timeoutMs = raw.timeout !== undefined ? Number(raw.timeout) : DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CiCheckUsageError('--timeout must be a positive number of milliseconds');

    const ctx = resolveCiContext({ cwd: io.cwd, env: io.env, repo: raw.repo, pr: raw.pr, tree: raw.tree });
    const { exitCode, result } = await runCiCheck({
      ...ctx,
      kind, policy, lens: raw.lens ?? null, hubUrl, token, maxAgeDays, timeoutMs,
      reportDir: path.resolve(io.cwd, raw.reportDir ?? DEFAULT_REPORT_DIR),
      githubOutput: io.env.GITHUB_OUTPUT || null,
      stepSummary: io.env.GITHUB_STEP_SUMMARY || null,
    });
    if (raw.json) console.log(JSON.stringify({ exitCode, ...result }, null, 2));
    else log(`agenfk ci check: ${result.outcome} (${result.reason}) - ${result.detail}`);
    return exitCode;
  } catch (e) {
    if (!(e instanceof CiCheckUsageError)) throw e;
    log(`agenfk ci check: ${e.message}`);
    return EXIT_BLOCK;
  }
}

export function registerCiCommands(program: Command): void {
  const ci = program.command('ci').description('CI side of AgEnFK receipts: reuse a verification or review CI would repeat');
  ci
    .command('check')
    .description('Exit 0 when a receipt lets this CI step be skipped, 10 when the step must run, 1 when the policy requires a receipt and none qualifies')
    .requiredOption('--kind <kind>', 'what the step stands for: verification or review')
    .option('--lens <lens>', 'for a review step: the lens it performs (general, security, ...)')
    .option('--policy <policy>', 'run (default): run the step when nothing qualifies; require: fail instead', 'run')
    .option('--hub <url>', 'the hub URL (default: AGENFK_HUB_URL)')
    .option('--repo <remote>', 'the repository (default: GitHub env, else the origin remote)')
    .option('--pr <number>', 'the pull request number (default: GitHub env)')
    .option('--tree <sha>', 'the content tree (default: HEAD^{tree} of this checkout)')
    .option('--max-age <days>', 'only reuse a receipt younger than this')
    .option('--report-dir <dir>', `where to write the reused report or findings (default: ${DEFAULT_REPORT_DIR})`)
    .option('--timeout <ms>', `how long to wait for the hub (default: ${DEFAULT_TIMEOUT_MS})`)
    .option('--json', 'print the decision as JSON')
    .action(async (opts: CiCheckRawOptions) => {
      const exitCode = await runCiCheckCommand(opts, { cwd: process.cwd(), env: process.env });
      process.exit(exitCode);
    });
}
