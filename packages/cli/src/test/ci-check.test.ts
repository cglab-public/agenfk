/**
 * `agenfk ci check` and its GitHub Action (RFC-002, task bf07b5ef).
 *
 * CI asks one question per expensive step: may this step be skipped because a
 * receipt already certifies what it would do? The answer is an exit code —
 * 0 reuse, 10 run the step, 1 the policy requires a receipt and none qualifies
 * — and the promises pinned here are the ones that keep a skip honest:
 *
 *  - **CI recomputes the content itself**: the tree of its own checkout (the
 *    PR's merge result), never one a producer reports. Repository and PR come
 *    from the GitHub environment, or flags elsewhere.
 *  - **Only Enforce skips.** Off and Shadow always run the step; Shadow still
 *    says whether it would have reused, which is what Shadow measures.
 *  - **A candidate qualifies only on every count**: same tree, current command
 *    revision (verification) or the lens the call names (review), reusable by
 *    the hub, producer still on the allowlist, fresh where --max-age asks, and
 *    its report or findings actually downloaded.
 *  - **Never a silent pass**: a hub error or timeout runs the step, or blocks
 *    under --policy require. It is never 0.
 *  - **The call is the mapping**: --kind and --lens name the receipt the step
 *    stands for; a review call without a lens is refused.
 *
 * The hub here is a local HTTP stand-in (the real hub API is pinned by the
 * hub's own hub-ci-receipts-read spec), and the checkout is a real git repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync, spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { resolveCiContext, runCiCheck, runCiCheckCommand, CiCheckUsageError } from '../commands/ci';

const REPO = 'git@github.com:acme/app.git';
const TOKEN = 'ci_' + '1'.repeat(64);
const LOG = 'PASS everything\n';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

let tmp: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** A real checkout with one commit; its HEAD tree is what CI compares. */
function makeCheckout(): { dir: string; tree: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'co-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ci@acme.test');
  git(dir, 'config', 'user.name', 'CI');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  return { dir, tree: git(dir, 'rev-parse', 'HEAD^{tree}'), commit: git(dir, 'rev-parse', 'HEAD') };
}

// ── the hub stand-in ─────────────────────────────────────────────────────────

interface FakeHub {
  url: string;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function fakeHub(handler: Handler): Promise<FakeHub> {
  const requests: FakeHub['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A candidate as GET /v1/ci/receipts summarises it. */
const candidate = (tree: string, over: Record<string, any> = {}) => ({
  id: over.id ?? 'rcpt-1',
  kind: 'verification',
  cardId: 'card-root',
  contentTree: tree,
  commit: 'b'.repeat(40),
  commandRevision: 1,
  reusable: true,
  notReusableReason: null,
  installationId: 'inst-alice',
  producerAllowed: true,
  receivedAt: new Date().toISOString(),
  evidenceAt: new Date().toISOString(),
  report: { available: true, bytes: LOG.length },
  ...over,
});

const lookupBody = (mode: string, receipts: any[], over: Record<string, any> = {}) => ({
  repo: REPO,
  settings: { verifyCommand: 'npm test', revision: 1, receiptsMode: mode },
  lookup: { by: receipts.length ? 'pr' : null, pr: 42, cardId: 'card-root', tree: null },
  receipts,
  ...over,
});

/** The full receipt for GET /v1/ci/receipts/:id. */
const fullReceipt = (c: any) => ({
  ...c,
  receipt: c.kind === 'review'
    ? {
        id: c.id, kind: 'review', card: { id: 'card-root', title: 'Root story' },
        review: { recordId: 'rec-9', reviewer: { client: 'codex', sessionId: 'sess-9' }, lenses: c.lenses, findings: [{ title: 'Off by one', state: 'fixed', reason: 'fixed in abc' }] },
      }
    : {
        id: c.id, kind: 'verification', card: { id: 'card-root', title: c.cardTitle ?? 'Root story', closedBy: { name: 'Dev', email: 'dev@acme.test' } },
        execution: { id: 'exec-7', command: 'npm test', commandRevision: c.commandRevision },
      },
});

/** A hub that answers the lookup with `body`, and the receipt + report routes from it. */
function hubAnswering(body: any, opts: { reportStatus?: number } = {}): Handler {
  return (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/v1/ci/receipts') return json(res, 200, body);
    const m = u.pathname.match(/^\/v1\/ci\/receipts\/([^/]+)(\/report)?$/);
    const c = m && body.receipts.find((r: any) => r.id === decodeURIComponent(m[1]));
    if (!c) return json(res, 404, { code: 'receipt_not_found' });
    if (m![2]) {
      if (opts.reportStatus && opts.reportStatus !== 200) return json(res, opts.reportStatus, { code: 'report_unavailable' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(LOG);
    }
    return json(res, 200, fullReceipt(c));
  };
}

describe('agenfk ci check', () => {
  let hub: FakeHub | null = null;
  let co: { dir: string; tree: string; commit: string };
  let outputFile: string;
  let summaryFile: string;
  let reportDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ci-check-'));
    co = makeCheckout();
    outputFile = path.join(tmp, 'github_output');
    summaryFile = path.join(tmp, 'step_summary.md');
    reportDir = path.join(tmp, 'reports');
    fs.writeFileSync(outputFile, '');
    fs.writeFileSync(summaryFile, '');
  });

  afterEach(async () => {
    if (hub) await hub.close();
    hub = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const outputs = () => Object.fromEntries(
    fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  const check = (over: Record<string, any> = {}) => runCiCheck({
    kind: 'verification',
    policy: 'run',
    hubUrl: hub!.url,
    token: TOKEN,
    repo: REPO,
    pr: 42,
    tree: co.tree,
    reportDir,
    timeoutMs: 2000,
    githubOutput: outputFile,
    stepSummary: summaryFile,
    ...over,
  });

  // ── context ────────────────────────────────────────────────────────────────
  describe('resolveCiContext', () => {
    it('takes the tree of the checkout, the repository and PR from the GitHub environment', () => {
      const event = path.join(tmp, 'event.json');
      fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
      const ctx = resolveCiContext({
        cwd: co.dir,
        env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_PATH: event },
      });
      expect(ctx).toEqual({ repo: 'https://github.com/acme/app.git', pr: 42, tree: co.tree });
    });

    it('reads the PR number from a pull request ref when there is no event file', () => {
      const ctx = resolveCiContext({ cwd: co.dir, env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_REF: 'refs/pull/17/merge' } });
      expect(ctx.pr).toBe(17);
    });

    it('falls back to the origin remote and to no PR outside GitHub', () => {
      git(co.dir, 'remote', 'add', 'origin', 'git@gitlab.example:acme/app.git');
      const ctx = resolveCiContext({ cwd: co.dir, env: {} });
      expect(ctx).toEqual({ repo: 'git@gitlab.example:acme/app.git', pr: null, tree: co.tree });
    });

    it('lets flags override what the environment says', () => {
      const ctx = resolveCiContext({
        cwd: co.dir, env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_REF: 'refs/pull/17/merge' },
        repo: 'git@github.com:acme/other.git', pr: '5',
      });
      expect(ctx).toMatchObject({ repo: 'git@github.com:acme/other.git', pr: 5, tree: co.tree });
    });

    it('refuses a directory that is not a git checkout', () => {
      const bare = fs.mkdtempSync(path.join(tmp, 'nogit-'));
      expect(() => resolveCiContext({ cwd: bare, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com' } }))
        .toThrow(CiCheckUsageError);
    });

    it('refuses a PR that is not a positive whole number', () => {
      expect(() => resolveCiContext({ cwd: co.dir, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com' }, pr: 'abc' }))
        .toThrow(CiCheckUsageError);
    });
  });

  // ── reuse ────────────────────────────────────────────────────────────────
  describe('in Enforce', () => {
    // CodeQL 169: escaping the pipe but not the backslash let `\|` in a card
    // title end the summary's table cell.
    it('keeps a card title with a backslash-pipe inside its summary table cell', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [{ ...candidate(co.tree), cardTitle: 'a \\| b' }])));
      expect((await check()).exitCode).toBe(0);
      const row = fs.readFileSync(summaryFile, 'utf8').split('\n').find(l => l.includes('a \\'))!;
      expect(row).toContain('a \\\\\\| b');
    });

    it('reuses a matching verification receipt: exit 0, report downloaded, outputs and summary written', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)])));
      const r = await check();
      expect(r.exitCode).toBe(0);
      expect(r.result).toMatchObject({ outcome: 'reuse', reason: 'matched', mode: 'enforce', wouldReuse: true, receiptId: 'rcpt-1' });
      // The lookup carried the token and everything CI computed itself.
      const lookup = hub.requests.find(q => q.url.startsWith('/v1/ci/receipts?'))!;
      expect(lookup.auth).toBe(`Bearer ${TOKEN}`);
      const qs = new URL(lookup.url, 'http://x').searchParams;
      expect(Object.fromEntries(qs)).toMatchObject({ repo: REPO, kind: 'verification', pr: '42', tree: co.tree });
      // The original log, downloaded where the job can publish it.
      expect(fs.readFileSync(path.join(reportDir, 'rcpt-1.log'), 'utf8')).toBe(LOG);
      expect(outputs()).toMatchObject({ run: 'false', decision: 'reuse', reason: 'matched', 'receipt-id': 'rcpt-1', 'would-reuse': 'true' });
      const summary = fs.readFileSync(summaryFile, 'utf8');
      expect(summary).toContain('Reused result');
      expect(summary).toContain('rcpt-1');
      expect(summary).toContain('exec-7');
      expect(summary).toContain('npm test');
      expect(summary).toContain('card-root');
    });

    it('takes an older candidate that qualifies when the newest does not', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [
        candidate('c'.repeat(40), { id: 'newest' }),
        candidate(co.tree, { id: 'older' }),
      ])));
      const r = await check();
      expect(r.exitCode).toBe(0);
      expect(r.result.receiptId).toBe('older');
    });

    const runsBecause = async (receipts: any[], reason: string, over: Record<string, any> = {}, body: Record<string, any> = {}) => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', receipts, body)));
      const r = await check(over);
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason, wouldReuse: false });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'run', reason });
      expect(fs.readFileSync(summaryFile, 'utf8')).not.toContain('Reused result');
      return r;
    };

    it('runs the step when there is no receipt', () => runsBecause([], 'no_receipt'));
    it('runs the step when no receipt has this checkout\'s tree', () => runsBecause([candidate('c'.repeat(40))], 'tree_mismatch'));
    it('runs the step when the command was revised since', () =>
      runsBecause([candidate('TREE', { commandRevision: 1 })].map(c => ({ ...c, contentTree: co.tree })), 'command_revision_changed', {},
        { settings: { verifyCommand: 'npm run verify', revision: 2, receiptsMode: 'enforce' } }));
    it('runs the step when the hub ruled the receipt not reusable', () =>
      runsBecause([candidate('x', { reusable: false, notReusableReason: 'report_over_cap' })].map(c => ({ ...c, contentTree: co.tree })), 'not_reusable'));
    it('runs the step when the producer is no longer on the allowlist', () =>
      runsBecause([candidate('x', { producerAllowed: false })].map(c => ({ ...c, contentTree: co.tree })), 'producer_not_allowed'));
    it('runs the step when the receipt is older than --max-age allows', () =>
      runsBecause([candidate('x', { evidenceAt: new Date(Date.now() - 30 * 864e5).toISOString() })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    // Codex review: a receipt that waited offline arrives "fresh"; its evidence is not.
    it('measures --max-age from when the evidence was made, not when the hub received it', () =>
      runsBecause([candidate('x', { receivedAt: new Date().toISOString(), evidenceAt: new Date(Date.now() - 30 * 864e5).toISOString() })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    it('counts a receipt that cannot say when its evidence was made as stale under --max-age', () =>
      runsBecause([candidate('x', { evidenceAt: null })].map(c => ({ ...c, contentTree: co.tree })), 'stale', { maxAgeDays: 7 }));
    it('never matches a command revision neither side states', () =>
      // Absent on both sides (JSON drops undefined): undefined === undefined must not be a match.
      runsBecause([candidate('x', { commandRevision: undefined })].map(c => ({ ...c, contentTree: co.tree })), 'command_revision_changed', {},
        { settings: { verifyCommand: 'npm test', receiptsMode: 'enforce' } }));
    it('runs the step when the receipt kept no report', () =>
      runsBecause([candidate('x', { report: { available: false, bytes: 99_000_000 } })].map(c => ({ ...c, contentTree: co.tree })), 'report_unavailable'));

    it('reuses an old receipt when no --max-age is asked for', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree, { receivedAt: '2020-01-01T00:00:00.000Z' })])));
      expect((await check()).exitCode).toBe(0);
    });

    it('runs the step when the report cannot be downloaded', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)]), { reportStatus: 404 }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('blocks under --policy require when nothing qualifies', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate('c'.repeat(40))])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(1);
      expect(r.result).toMatchObject({ outcome: 'block', reason: 'tree_mismatch' });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'block' });
    });
  });

  // ── Codex review: what comes back from the hub is checked, not trusted ────
  describe('evidence and outputs from a hub that misbehaves', () => {
    it('a receipt id cannot forge another GITHUB_OUTPUT line', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate(co.tree, { id: 'r\nrun=false' })])));
      const r = await check();
      expect(r.exitCode).toBe(10);
      const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
      expect(lines.filter(l => l.startsWith('run=')), lines.join(' | ')).toEqual(['run=true']);
      expect(lines.every(l => /^[a-z-]+=/.test(l)), lines.join(' | ')).toBe(true);
    });

    it('a review whose findings did not come back is not reused', async () => {
      const c = candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses: ['general'], report: { available: false, bytes: null } });
      hub = await fakeHub((req, res) => {
        if ((req.url ?? '').startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        return json(res, 200, {}); // the detail: 200, but no receipt in it
      });
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('a review detail that is the right receipt but carries no findings list is not reused', async () => {
      const c = candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses: ['general'], report: { available: false, bytes: null } });
      hub = await fakeHub((req, res) => {
        if ((req.url ?? '').startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        const full = fullReceipt(c);
        return json(res, 200, { ...full, receipt: { ...full.receipt, review: { ...full.receipt.review, findings: 'none' } } });
      });
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('a detail naming another receipt is not this receipt\'s evidence', async () => {
      const c = candidate(co.tree);
      hub = await fakeHub((req, res) => {
        const u = req.url ?? '';
        if (u.startsWith('/v1/ci/receipts?')) return json(res, 200, lookupBody('enforce', [c]));
        if (u.endsWith('/report')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(LOG); }
        return json(res, 200, fullReceipt({ ...c, id: 'someone-else' }));
      });
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('report_unavailable');
    });

    it('the timeout covers the body too: a hub that sends headers and stalls is not waited on', async () => {
      hub = await fakeHub((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"repo":'); });
      const started = Date.now();
      const r = await check({ timeoutMs: 200 });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  // ── reviews ──────────────────────────────────────────────────────────────
  describe('a review step', () => {
    const reviewCandidate = (lenses: string[], over: Record<string, any> = {}) =>
      candidate(co.tree, { id: 'rv-1', kind: 'review', commandRevision: null, lenses, report: { available: false, bytes: null }, ...over });

    it('reuses a review that covered the lens the call names, and downloads its findings', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general', 'security'])])));
      const r = await check({ kind: 'review', lens: 'security' });
      expect(r.exitCode, JSON.stringify(r.result)).toBe(0);
      const lookup = hub.requests.find(q => q.url.startsWith('/v1/ci/receipts?'))!;
      expect(new URL(lookup.url, 'http://x').searchParams.get('lens')).toBe('security');
      const findings = JSON.parse(fs.readFileSync(path.join(reportDir, 'rv-1.findings.json'), 'utf8'));
      expect(findings).toEqual([{ title: 'Off by one', state: 'fixed', reason: 'fixed in abc' }]);
      const summary = fs.readFileSync(summaryFile, 'utf8');
      expect(summary).toContain('Reused result');
      expect(summary).toContain('rec-9');
      expect(summary).toContain('security');
    });

    it('does not let a review stand in for a lens it did not perform', async () => {
      // A hub that ignored the lens filter must still not produce a skip.
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])])));
      const r = await check({ kind: 'review', lens: 'security' });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('lens_not_covered');
    });

    it('needs no command revision to match', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])]), {}));
      const r = await check({ kind: 'review', lens: 'general' });
      expect(r.exitCode).toBe(0);
    });

    it('refuses a review call that names no lens', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [reviewCandidate(['general'])])));
      await expect(check({ kind: 'review' })).rejects.toThrow(CiCheckUsageError);
      expect(hub.requests).toHaveLength(0);
    });
  });

  // ── modes ────────────────────────────────────────────────────────────────
  describe('Off and Shadow', () => {
    it('Shadow always runs the step but says it would have reused', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate(co.tree)])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', mode: 'shadow', wouldReuse: true, reason: 'shadow_mode', receiptId: 'rcpt-1' });
      expect(outputs()).toMatchObject({ run: 'true', 'would-reuse': 'true' });
      expect(fs.readFileSync(summaryFile, 'utf8')).toMatch(/shadow/i);
    });

    it('Shadow says when it would not have reused, and why', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('shadow', [candidate('c'.repeat(40))])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ wouldReuse: false, reason: 'tree_mismatch' });
    });

    it('Off runs the step, even under --policy require', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('off', [candidate(co.tree)])));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason: 'receipts_off', wouldReuse: false });
    });
  });

  // ── the hub failing ──────────────────────────────────────────────────────
  describe('never a silent pass', () => {
    it('runs the step when the hub answers with an error', async () => {
      hub = await fakeHub((_req, res) => json(res, 500, { error: 'boom' }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result).toMatchObject({ outcome: 'run', reason: 'hub_unavailable' });
      expect(outputs()).toMatchObject({ run: 'true', decision: 'run' });
    });

    it('blocks on a hub error under --policy require', async () => {
      hub = await fakeHub((_req, res) => json(res, 401, { error: 'Invalid or revoked token' }));
      const r = await check({ policy: 'require' });
      expect(r.exitCode).toBe(1);
      expect(r.result).toMatchObject({ outcome: 'block', reason: 'hub_unavailable' });
    });

    it('runs the step when the hub does not answer in time', async () => {
      hub = await fakeHub(() => { /* never answers */ });
      const started = Date.now();
      const r = await check({ timeoutMs: 200 });
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('runs the step when the hub answers something that is not a lookup', async () => {
      hub = await fakeHub((_req, res) => json(res, 200, { hello: 'world' }));
      const r = await check();
      expect(r.exitCode).toBe(10);
      expect(r.result.reason).toBe('hub_unavailable');
    });
  });

  // ── the command around it ────────────────────────────────────────────────
  describe('runCiCheckCommand', () => {
    it('reads the hub and token from the environment and the context from the checkout', async () => {
      hub = await fakeHub(hubAnswering(lookupBody('enforce', [candidate(co.tree)])));
      const code = await runCiCheckCommand(
        { kind: 'verification', reportDir, pr: '42', repo: REPO },
        { cwd: co.dir, env: { AGENFK_HUB_URL: hub.url, AGENFK_CI_TOKEN: TOKEN, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile } },
      );
      expect(code).toBe(0);
      expect(outputs().decision).toBe('reuse');
    });

    it('fails loudly without a token or a hub URL', async () => {
      const lines: string[] = [];
      const code = await runCiCheckCommand(
        { kind: 'verification', reportDir },
        { cwd: co.dir, env: { GITHUB_REPOSITORY: 'acme/app', GITHUB_SERVER_URL: 'https://github.com', GITHUB_OUTPUT: outputFile }, log: (l: string) => lines.push(l) },
      );
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/AGENFK_CI_TOKEN|AGENFK_HUB_URL/);
    });

    it('refuses an unknown kind or policy', async () => {
      const env = { AGENFK_HUB_URL: 'http://127.0.0.1:9', AGENFK_CI_TOKEN: TOKEN };
      expect(await runCiCheckCommand({ kind: 'build', reportDir }, { cwd: co.dir, env, log: () => undefined })).toBe(1);
      expect(await runCiCheckCommand({ kind: 'verification', policy: 'maybe', reportDir }, { cwd: co.dir, env, log: () => undefined })).toBe(1);
    });
  });
});

// ── the GitHub Action ──────────────────────────────────────────────────────
//
// GH-278: the action used to run `npx agenfk@<version>`, but agenfk is not on
// npm (E404), so it failed for everyone. It now installs the pinned release's
// agenfk-dist.tar.gz and calls the built CLI. Its steps run here for real under
// bash, with curl, npm and node stubbed: curl serves a fixture tarball, npm and
// node record what they were asked to do.
describe.skipIf(process.platform === 'win32')('the ci-check GitHub Action', () => {
  const actionPath = path.join(REPO_ROOT, 'actions', 'ci-check', 'action.yml');
  const RELEASES = 'https://github.com/cglab-public/agenfk/releases';

  /**
   * Run the action's steps in order with the given inputs. `cliExit` is the
   * CLI's exit code and `cliOutputs` what it writes to GITHUB_OUTPUT (as ci
   * check does); `download`, `tarOk`, `npmOk` say whether each install stage
   * works. An `agenfk-sha256` input of 'MATCH' stands for the tarball's real digest.
   */
  function runAction(inputs: Record<string, string>, {
    cliExit = 0, download = true, tarOk = true, npmOk = true,
    cliOutputs = {} as Record<string, string>, cliPrints = '',
  } = {}) {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    expect(action.runs.using).toBe('composite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-action-'));
    const bin = path.join(dir, 'bin');
    const temp = path.join(dir, 'runner-temp');
    fs.mkdirSync(bin);
    fs.mkdirSync(temp);
    // The release tarball: just the built CLI's entry point.
    const pkg = path.join(dir, 'pkg');
    fs.mkdirSync(path.join(pkg, 'packages/cli/dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'packages/cli/dist/index.js'), '');
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    const tarball = path.join(dir, 'agenfk-dist.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', pkg, '.']);
    const tarballSha = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(' ')[0];
    const log = (name: string) => path.join(dir, `${name}.argv`);
    // tar: the real one, unless this run plays an archive that will not unpack.
    if (!tarOk) fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    // curl: record the URL, then write the tarball where -o says (or fail like curl -f).
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
printf '%s\n' "$@" > "${log('curl')}"
${download ? '' : 'exit 22'}
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${tarball}" "$2"; fi; shift; done
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
printf '%s\n' "$PWD" "$@" > "${log('npm')}"
${npmOk ? '' : 'exit 1'}
`, { mode: 0o755 });
    // node plays the CLI: records its argv, writes its outputs, prints, exits.
    const outputLines = Object.entries(cliOutputs).map(([k, v]) => `echo '${k}=${v}' >> "$GITHUB_OUTPUT"`).join('\n');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
printf '%s\n' "$@" > "${log('node')}"
${outputLines}
${cliPrints ? `echo '${cliPrints}'` : ''}
exit ${cliExit}
`, { mode: 0o755 });

    const outputs: Record<string, Record<string, string>> = {};
    let status: number | null = 0;
    let stderr = '';
    let stdout = '';
    for (const step of action.runs.steps) {
      const out = path.join(dir, `${step.id}.out`);
      fs.writeFileSync(out, '');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.env ?? {})) {
        const input = String(v).match(/^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/);
        const prior = String(v).match(/^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/);
        const given = input ? (inputs[input[1]] ?? '') : '';
        env[k] = input ? (given === 'MATCH' ? tarballSha : given) : prior ? (outputs[prior[1]]?.[prior[2]] ?? '') : String(v);
      }
      const r = spawnSync('bash', ['-e', '-c', step.run], {
        env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: out, RUNNER_TEMP: temp, ...env },
        encoding: 'utf8',
      });
      outputs[step.id] = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      status = r.status;
      stderr += r.stderr;
      stdout += r.stdout;
      if (status !== 0) break;
    }
    const argv = (name: string) => fs.existsSync(log(name)) ? fs.readFileSync(log(name), 'utf8').split('\n').filter(Boolean) : [];
    const result = { status, stderr, stdout, outputs, curl: argv('curl'), npm: argv('npm'), node: argv('node'), temp };
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  it('downloads the pinned release, not a package from npm', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0-beta.1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.curl).toContain(`${RELEASES}/download/v2.1.0-beta.1/agenfk-dist.tar.gz`);
  });

  it('takes the version with or without its leading v', () => {
    expect(runAction({ kind: 'verification', 'agenfk-version': 'v2.1.0' }).curl).toContain(`${RELEASES}/download/v2.1.0/agenfk-dist.tar.gz`);
  });

  it('downloads the latest release when no version is pinned', () => {
    expect(runAction({ kind: 'verification', 'agenfk-version': '' }).curl).toContain(`${RELEASES}/latest/download/agenfk-dist.tar.gz`);
    expect(runAction({ kind: 'verification', 'agenfk-version': 'latest' }).curl).toContain(`${RELEASES}/latest/download/agenfk-dist.tar.gz`);
  });

  it('installs only the release\'s runtime dependencies, running none of their scripts', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0' });
    expect(r.npm[0].startsWith(r.temp)).toBe(true);
    expect(r.npm.slice(1)).toEqual(expect.arrayContaining(['ci', '--omit=dev', '--ignore-scripts']));
  });

  it('calls the built CLI, never the installer entry point', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0' });
    expect(r.node[0]).toMatch(/packages\/cli\/dist\/index\.js$/);
    expect(r.node.join(' ')).not.toMatch(/bin\/agenfk\.js/);
    expect(r.node.slice(1, 3)).toEqual(['ci', 'check']);
  });

  it('passes on exit 0 and exit 10, so only the steps it gates are skipped', () => {
    expect(runAction({ kind: 'verification' }, { cliExit: 0 }).status).toBe(0);
    expect(runAction({ kind: 'verification' }, { cliExit: 10 }).status).toBe(0);
  });

  it('fails the job on exit 1, when the policy requires a receipt', () => {
    expect(runAction({ kind: 'verification', policy: 'require' }, { cliExit: 1, cliOutputs: { run: 'true', decision: 'block' } }).status).toBe(1);
  });

  // Codex review (second pass): exit 1 is also what an unknown command or a
  // crash returns. Only a written `decision=block` makes it an answer.
  it('runs the gated steps when the CLI exits 1 without deciding (a release with no ci check)', () => {
    const r = runAction({ kind: 'verification' }, { cliExit: 1 });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('true');
  });

  it('never leaves run=false behind a CLI that failed after writing it', () => {
    const r = runAction({ kind: 'verification' }, { cliExit: 1, cliOutputs: { run: 'false', decision: 'reuse' } });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('true');
  });

  it('says a digest mismatch is one, so a caller that tolerates the check failing can still refuse it', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0', 'agenfk-sha256': 'a'.repeat(64) });
    expect(r.outputs.install.integrity).toBe('mismatch');
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    expect(action.outputs.integrity.value).toMatch(/steps\.install\.outputs\.integrity/);
  });

  it('runs the gated steps when the release cannot be downloaded', () => {
    const r = runAction({ kind: 'verification' }, { download: false });
    expect(r.status).toBe(0);
    expect(r.outputs.check?.run).toBe('true');
    expect(r.node).toEqual([]);
  });

  it('fails the job when the release cannot be downloaded and the policy requires a receipt', () => {
    expect(runAction({ kind: 'verification', policy: 'require' }, { download: false }).status).toBe(1);
  });

  it('passes the CLI\'s answer through, so a reuse reaches the gate as run=false', () => {
    const r = runAction({ kind: 'verification' }, { cliExit: 0, cliOutputs: { run: 'false', decision: 'reuse' } });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('false');
    expect(r.outputs.check.decision).toBe('reuse');
  });

  it('runs the gated steps when the archive cannot be unpacked', () => {
    const r = runAction({ kind: 'verification' }, { tarOk: false });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('true');
    expect(r.node).toEqual([]);
  });

  it('runs the gated steps when the release\'s dependencies cannot be installed', () => {
    const r = runAction({ kind: 'verification' }, { npmOk: false });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('true');
    expect(r.node).toEqual([]);
  });

  // Codex review: `latest` is the newest STABLE release, which can predate `ci check`.
  it('runs the gated steps when the CLI fails in a way that is not an answer', () => {
    const r = runAction({ kind: 'verification' }, { cliExit: 2 });
    expect(r.status).toBe(0);
    expect(r.outputs.check.run).toBe('true');
  });

  it('fails the job when the CLI fails that way and the policy requires a receipt', () => {
    expect(runAction({ kind: 'verification', policy: 'require' }, { cliExit: 2 }).status).not.toBe(0);
  });

  // Codex review: a version names a release; a digest pins its bytes.
  it('runs the release when its digest matches the one pinned', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0', 'agenfk-sha256': 'MATCH' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.node.slice(1, 3)).toEqual(['ci', 'check']);
  });

  it('fails the job, running nothing from it, when the release does not match its pinned digest', () => {
    const r = runAction({ kind: 'verification', 'agenfk-version': '2.1.0', 'agenfk-sha256': 'a'.repeat(64) });
    expect(r.status).not.toBe(0);
    expect(r.npm).toEqual([]);
    expect(r.node).toEqual([]);
  });

  // Codex review: GitHub reads workflow commands from a step's output, and the
  // CLI echoes inputs in its diagnostics.
  it('ignores workflow commands in what the CLI prints', () => {
    const r = runAction({ kind: 'verification' }, { cliPrints: '::warning::injected' });
    const lines = r.stdout.split('\n');
    const stop = lines.findIndex(l => /^::stop-commands::\S+$/.test(l));
    expect(stop, r.stdout).toBeGreaterThanOrEqual(0);
    const token = lines[stop].slice('::stop-commands::'.length);
    const injected = lines.indexOf('::warning::injected');
    expect(injected).toBeGreaterThan(stop);
    expect(lines.indexOf(`::${token}::`)).toBeGreaterThan(injected);
  });

  it('runs agenfk ci check with the kind, lens and policy it was given', () => {
    const { node } = runAction({ kind: 'review', lens: 'security', policy: 'require', 'agenfk-version': '2.1.0' });
    expect(node[node.indexOf('--kind') + 1]).toBe('review');
    expect(node[node.indexOf('--lens') + 1]).toBe('security');
    expect(node[node.indexOf('--policy') + 1]).toBe('require');
  });

  it('passes no --lens when none was given', () => {
    expect(runAction({ kind: 'verification' }).node).not.toContain('--lens');
  });

  it('never splices an input into the script, so an input cannot run code', () => {
    const { node, status } = runAction({ kind: 'verification', lens: '$(touch /tmp/agenfk-pwned)"; exit 3; "' });
    expect(status).toBe(0);
    expect(node[node.indexOf('--lens') + 1]).toBe('$(touch /tmp/agenfk-pwned)"; exit 3; "');
    const v = runAction({ kind: 'verification', 'agenfk-version': '1.0"; exit 3; "' });
    expect(v.status).not.toBe(3);
  });

  it('exposes the step\'s run and decision outputs as the action\'s', () => {
    const action: any = yaml.load(fs.readFileSync(actionPath, 'utf8'));
    expect(action.outputs.run.value).toMatch(/steps\.check\.outputs\.run/);
    expect(action.outputs.decision.value).toMatch(/steps\.check\.outputs\.decision/);
    expect(action.outputs['receipt-id'].value).toMatch(/steps\.check\.outputs\.receipt-id/);
  });
});
