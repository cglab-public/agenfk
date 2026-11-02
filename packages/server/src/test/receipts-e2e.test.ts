/**
 * @file RFC-002 end to end (task 84ad6d8c): a root card's fresh verify and its
 * independent review become receipts on the hub, and CI reuses them instead of
 * running the suite and the review agent again — with execution counts.
 *
 * Every piece is the real one: the local server closes the card and records the
 * review, the receipt publisher pushes both to a real hub (SQLite on disk), a
 * HubClient/Flusher delivers the pr.opened event that ties the PR to the card,
 * and `agenfk ci check` runs in a git clone standing for CI's checkout. A "CI
 * job" here is what the GitHub Action does: run the check, and run the step
 * only when it answers 10.
 *
 * The suite is a repo-relative script (`node scripts/suite.cjs`, the only kind
 * of command the hub accepts) that counts its runs in a log outside the tree,
 * so the producer's run and CI's runs land in one count. The review agent is a
 * counter.
 *
 * The negatives are the ways a skip would be a lie: the content CI holds is not
 * what was tested (a new commit, or a base that moved under the merge), the
 * command was revised, the producer is no longer trusted, the review did not
 * perform the lens or was not independent, the report never reached the hub,
 * the token is another org's, and the hub is down — at CI time, or at publish
 * time, where the receipt must stay pending rather than be called delivered.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('receipts-e2e-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { HubClient } from '../hub';
import { publishPendingReceipts } from '../hub/receiptPublisher';
import { posixShell } from './helpers/posixShell';
import { createHubApp } from '../../../hub/src/server';
import { issueApiKey } from '../../../hub/src/auth/apiKey';
import { createPasswordUser } from '../../../hub/src/auth/password';
import { loginAs } from '../../../hub/src/test/helpers/loginAs';
import { runCiCheck } from '../../../cli/src/commands/ci';

const REMOTE = 'git@github.com:acme/app.git';
const SUITE = 'node scripts/suite.cjs';
const ORG = 'org-e2e';
const PRODUCER = 'inst-e2e';
const ADMIN = 'admin@e2e.test';
const PASSWORD = 'longenough1';

let __server: http.Server;
const agent = () => request(__server);
const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
const cleanup: string[] = [];
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
let home: string;

// ── the hub ─────────────────────────────────────────────────────────────────
let hubServer: http.Server;
let hubCtx: any;
let hubUrl: string;
let producerKey: string;
let adminCookie: string;
let hubRevision: number;
const hubDbPath = path.join(os.tmpdir(), `agenfk-receipts-e2e-hub-${process.pid}-${Date.now()}.sqlite`);
const hubApi = () => supertest(hubServer);

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-home-'));
  cleanup.push(home);
  process.env.HOME = process.env.USERPROFILE = home;
  await initStorage();
  __server = app.listen(0);

  const out = await createHubApp({ dbPath: hubDbPath, secretKey: 'a'.repeat(64), sessionSecret: 'e2e-session', defaultOrgId: ORG } as any);
  hubCtx = out.ctx;
  hubServer = out.app.listen(0, '127.0.0.1');
  await new Promise<void>(r => hubServer.once('listening', () => r()));
  hubUrl = `http://127.0.0.1:${(hubServer.address() as any).port}`;
  producerKey = await issueApiKey(hubCtx.db, ORG, 'producer', { installationId: PRODUCER });
  await hubCtx.db.run(
    `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
     VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev', 'Dev', 'dev@e2e.test')`,
    [PRODUCER, ORG],
  );
  await createPasswordUser(hubCtx.db, ORG, ADMIN, PASSWORD, 'admin');
  adminCookie = await loginAs(hubServer, ADMIN, PASSWORD);

  // The repository: claimed by the producer, Enforce, the producer allowed.
  const init = await hubApi().post('/v1/repo-settings/init').set('Authorization', `Bearer ${producerKey}`).send({ repo: REMOTE, verifyCommand: SUITE });
  expect([200, 201], JSON.stringify(init.body)).toContain(init.status);
  hubRevision = Number(init.body.settings.revision);
  expect(hubRevision).toBeGreaterThan(0);
  await setProducer(true);
  const mode = await hubApi().put('/v1/admin/repos/mode').set('Cookie', adminCookie).send({ repo: REMOTE, mode: 'enforce', shadowThreshold: 3 });
  expect(mode.status, JSON.stringify(mode.body)).toBe(200);
});

afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  hubServer.closeAllConnections?.();
  await new Promise<void>(r => hubServer.close(() => r()));
  await hubCtx.db.close();
  process.env.HOME = savedHome; process.env.USERPROFILE = savedUserProfile;
  await removeTestDb(TEST_DB, closeStorage);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(hubDbPath + s, { force: true });
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setProducer(allowed: boolean) {
  const r = await hubApi().put('/v1/admin/repos/producers').set('Cookie', adminCookie).send({ repo: REMOTE, installationId: PRODUCER, allowed });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function mintCiToken(orgCookie = adminCookie): Promise<string> {
  const r = await hubApi().post('/v1/admin/ci-tokens').set('Cookie', orgCookie).send({ label: 'e2e', repo: REMOTE });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token;
}

const hubConfig = () => ({ url: hubUrl, token: producerKey, orgId: ORG });

// ── the producer's repository and card ─────────────────────────────────────
const git = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, shell: posixShell(), encoding: 'utf8' }).trim();

interface Producer {
  dir: string;
  base: string;
  tip: string;
  runs: () => number;
}

/**
 * A repository whose suite counts every run, wherever it runs, in one log
 * outside every tree. Two commits, so a review has a range to cover.
 */
function makeProducer(): Producer {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-repo-')));
  cleanup.push(dir);
  const log = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-log-'))), 'runs');
  cleanup.push(path.dirname(log));
  git(dir, 'git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'scripts/suite.cjs'),
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'run\\n');`
    + `fs.writeFileSync('report.xml','<testsuite><testcase file="tests/a.test.js" name="t0"/></testsuite>');`
    + `console.log('PASS tests/a.test.js');`);
  fs.writeFileSync(path.join(dir, 'tests/a.test.js'), 'test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'report.*\n');
  git(dir, 'git add . && git commit -qm one');
  const base = git(dir, 'git rev-parse HEAD');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 1;\n');
  git(dir, 'git add . && git commit -qm two');
  const tip = git(dir, 'git rev-parse HEAD');
  return { dir, base, tip, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0) };
}

let seq = 0;
const step = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A root card at its final working step, in a project that mirrors the hub's settings. */
async function rootCard(p: Producer): Promise<string> {
  const f = await agent().post('/flows').send({
    name: `receipts-e2e-${++seq}`,
    steps: [step('START', 0, { isAnchor: true }), step('WORK', 1), step('FINAL', 2), step('END', 3, { isAnchor: true, role: 'closing' })],
  });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const proj = await agent().post('/projects').send({ name: `receipts-e2e-${++seq}` });
  expect(proj.status, JSON.stringify(proj.body)).toBe(201);
  await storage.updateProject(proj.body.id, {
    flowId: f.body.id,
    projectRoot: p.dir,
    verifyCommand: SUITE,
    testReport: { format: 'junit-xml', reportPath: 'report.xml', command: SUITE },
    hubRepoSettings: {
      remoteUrl: REMOTE, verifyCommand: SUITE, revision: hubRevision, receiptsMode: 'enforce',
      shadowThreshold: 3, producers: [PRODUCER], syncedAt: new Date().toISOString(),
    },
  } as never);
  const c = await agent().post('/items').send({ type: 'STORY', title: `root-${++seq}`, projectId: proj.body.id });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  // Authored by one session, from the base: the review below is by another.
  await storage.updateItem(c.body.id, {
    status: 'FINAL',
    stepRecords: [{ kind: 'exit', step: 'WORK', at: '2026-01-01T00:00:00.000Z', head: p.base, actor: { client: 'claude-code', sessionId: 'author-session', agentId: 'agentSelf' } }],
  } as never);
  return c.body.id;
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
/** A Claude Code sub-agent transcript of its own session: an independent reviewer. */
function reviewerTranscript(session: string, agentId: string): string {
  const proj = path.join(home, '.claude', 'projects', '-repo');
  const dir = path.join(proj, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(proj, `${session}.jsonl`), line({ type: 'user', sessionId: session, timestamp: '2026-01-01T00:00:00.000Z' }));
  const f = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f,
    line({ type: 'user', isSidechain: true, agentId, sessionId: session, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'review' } })
    + line({ type: 'assistant', isSidechain: true, agentId, sessionId: session, timestamp: '2099-01-01T00:00:00.000Z', message: { role: 'assistant', content: 'findings' } }));
  return f;
}

const FINDINGS = [{ title: 'null deref in x', state: 'fixed' }, { title: 'rename y', state: 'rejected', reason: 'out of scope' }];

async function recordReview(id: string, p: Producer, opts: { session?: string; lenses?: string[] } = {}) {
  const session = opts.session ?? `reviewer-${++seq}`;
  // The author's own agent reviewing its own work is the one review that is not independent.
  const transcript = reviewerTranscript(session, session === 'author-session' ? 'agentSelf' : `r${seq}`);
  const r = await agent().post(`/items/${id}/review-records`).set(internal())
    .send({ transcript, range: `${p.base}..${p.tip}`, findings: FINDINGS, ...(opts.lenses ? { lenses: opts.lenses } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function closeCard(id: string) {
  const r = await agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'final' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const item = (await agent().get(`/items/${id}?records=1`)).body;
  expect(item.status, JSON.stringify(item.comments?.slice(-2))).toBe('END');
  return item;
}

async function publish() {
  return publishPendingReceipts({ storage: storage as any, hubConfig: hubConfig(), fetchImpl: globalThis.fetch as any });
}

/**
 * The pr.opened the producer's `agenfk pr create` sends: the envelope the real
 * HubClient writes to its outbox, posted to the hub's real ingest route as the
 * Flusher would (the Flusher itself speaks axios, which this server spec mocks).
 */
async function prOpened(cardId: string, prNumber: number) {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-outbox-')), 'outbox.sqlite');
  cleanup.push(path.dirname(dbFile));
  const sender = new SQLiteStorageProvider();
  await sender.init({ path: dbFile });
  try {
    const client = new HubClient(PRODUCER, hubConfig());
    client.attachStorage(sender);
    client.recordEvent({ type: 'pr.opened', itemId: cardId, payload: { prNumber, repo: 'acme/app' } });
    const events = sender.hubOutboxPeek().map(r => JSON.parse(r.payload));
    expect(events).toHaveLength(1);
    const r = await hubApi().post('/v1/events').set('Authorization', `Bearer ${producerKey}`).send({ events });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ ingested: 1, rejected: 0 });
  } finally {
    await sender.shutdown();
  }
}

// ── CI ──────────────────────────────────────────────────────────────────────

/** CI's checkout: a clone of the producer's repository at its tip. */
function ciCheckout(p: Producer): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-ci-')));
  cleanup.push(dir);
  git(dir, `git clone -q "${p.dir}" co`);
  const co = path.join(dir, 'co');
  git(co, 'git config user.email ci@e2e.test && git config user.name ci && git config commit.gpgsign false');
  return co;
}

const treeOf = (dir: string) => git(dir, 'git rev-parse HEAD^{tree}');

let reviewAgentRuns = 0;

/**
 * One CI job, as the Action runs it: the check, then the expensive step only
 * when the check says 10. Exit 1 fails the job before the step.
 */
async function ciJob(co: string, opts: { kind: 'verification' | 'review'; lens?: string; token: string; pr?: number | null; hub?: string; policy?: 'run' | 'require' }) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipts-e2e-reports-'));
  cleanup.push(reportDir);
  const { exitCode, result } = await runCiCheck({
    kind: opts.kind, lens: opts.lens ?? null, policy: opts.policy ?? 'run',
    hubUrl: opts.hub ?? hubUrl, token: opts.token,
    repo: REMOTE, pr: opts.pr ?? null, tree: treeOf(co),
    reportDir, timeoutMs: 3000,
  });
  if (exitCode === 10) {
    if (opts.kind === 'verification') execSync(SUITE, { cwd: co, shell: posixShell() });
    else reviewAgentRuns++;
  }
  return { exitCode, result, reportDir };
}

/** A card verified and reviewed on the producer, both receipts acked by the hub. */
async function certified(opts: { review?: { session?: string; lenses?: string[] } } = {}) {
  const p = makeProducer();
  const id = await rootCard(p);
  await recordReview(id, p, opts.review);
  const item = await closeCard(id);
  void item;
  const published = await publish();
  expect(published.pending, JSON.stringify(published)).toBe(0);
  const pr = 100 + ++seq;
  await prOpened(id, pr);
  // Read back after publishing: the publication state is written onto the card.
  return { p, id, pr, item: (await agent().get(`/items/${id}?records=1`)).body };
}

describe('RFC-002 end to end: local verify + review -> hub -> CI reuse (84ad6d8c)', () => {
  it('CI reuses the verification and the review: the suite ran once, on the producer, and the review agent never', async () => {
    const { p, pr, item } = await certified({ review: { lenses: ['general', 'security'] } });
    expect(p.runs(), 'the root card ran the suite fresh, once').toBe(1);
    expect(item.verificationReceipts).toHaveLength(1);
    expect(item.verificationReceipts[0].publication.state).toBe('acked');
    expect(item.reviewReceipts[0].publication.state).toBe('acked');

    const token = await mintCiToken();
    const co = ciCheckout(p);
    reviewAgentRuns = 0;

    const tests = await ciJob(co, { kind: 'verification', token, pr });
    expect(tests.exitCode, JSON.stringify(tests.result)).toBe(0);
    expect(tests.result).toMatchObject({ outcome: 'reuse', receiptId: item.verificationReceipts[0].id });
    // Found through the PR, and the original log is on CI's disk.
    expect(fs.readFileSync(tests.result.files[0], 'utf8')).toContain('PASS tests/a.test.js');

    const security = await ciJob(co, { kind: 'review', lens: 'security', token, pr });
    const general = await ciJob(co, { kind: 'review', lens: 'general', token, pr });
    expect(security.exitCode, JSON.stringify(security.result)).toBe(0);
    expect(general.exitCode).toBe(0);
    expect(security.result.receiptId).toBe(item.reviewReceipts[0].id);
    expect(JSON.parse(fs.readFileSync(security.result.files[0], 'utf8'))).toEqual(FINDINGS);

    expect(p.runs(), 'CI did not run the suite').toBe(1);
    expect(reviewAgentRuns, 'CI did not run the review agent').toBe(0);
  });

  it('identical content committed afterwards still matches through its tree, without the PR', async () => {
    const { p } = await certified();
    const token = await mintCiToken();
    const co = ciCheckout(p);
    // A new commit with the very same tree (a squash, a re-commit): same content.
    git(co, 'git commit -q --allow-empty -m "same content"');
    const job = await ciJob(co, { kind: 'verification', token });
    expect(job.exitCode, JSON.stringify(job.result)).toBe(0);
    expect(p.runs()).toBe(1);
  });

  describe('every way a skip would be a lie runs the step instead', () => {
    // Content that changed after the receipt is refused for its tree (tree_mismatch): "the base moved, so the merge result
    // is not the tree that was tested" below, and ci-check.test.ts "runs the step when no receipt has this checkout's tree".
    it('the base moved, so the merge result is not the tree that was tested', async () => {
      const { p, pr } = await certified();
      const token = await mintCiToken();
      const co = ciCheckout(p);
      // main gained a commit the card never saw; CI checks out the merge.
      git(co, `git checkout -q -b base ${p.base} && echo other > other.txt && git add other.txt && git commit -qm base-moved`);
      git(co, `git checkout -q --detach ${p.tip} && git merge -q --no-edit base`);
      const job = await ciJob(co, { kind: 'verification', token, pr });
      expect(job.result.reason).toBe('tree_mismatch');
      expect(p.runs()).toBe(2);
    });

    it('the command was revised on the hub after the run', async () => {
      const { p } = await certified();
      const token = await mintCiToken();
      const revised = await hubApi().put('/v1/admin/repos/command').set('Cookie', adminCookie).send({ repo: REMOTE, verifyCommand: `${SUITE} --all` });
      expect(revised.status, JSON.stringify(revised.body)).toBe(200);
      try {
        const job = await ciJob(ciCheckout(p), { kind: 'verification', token });
        expect(job.result.reason).toBe('command_revision_changed');
        expect(p.runs()).toBe(2);
      } finally {
        const back = await hubApi().put('/v1/admin/repos/command').set('Cookie', adminCookie).send({ repo: REMOTE, verifyCommand: SUITE });
        expect(back.status).toBe(200);
        // Reverting is a revision too: later cards run under the newest one.
        hubRevision = Number(back.body.revision);
        expect(hubRevision).toBeGreaterThan(1);
      }
    });

    it('the producer is no longer trusted', async () => {
      const { p } = await certified();
      const token = await mintCiToken();
      await setProducer(false);
      try {
        const job = await ciJob(ciCheckout(p), { kind: 'verification', token });
        expect(job.result.reason).toBe('producer_not_allowed');
        expect(p.runs()).toBe(2);
      } finally {
        await setProducer(true);
      }
    });

    // A review that did not perform the job's lens: ci-check.test.ts "does not let a review stand in for a lens it did not perform".
    it('the review was not independent: its receipt is published but cannot be reused', async () => {
      const { p, item } = await certified({ review: { session: 'author-session' } });
      expect(item.reviewReceipts[0].reusable).toBe(false);
      const token = await mintCiToken();
      reviewAgentRuns = 0;
      const job = await ciJob(ciCheckout(p), { kind: 'review', lens: 'general', token });
      expect(job.result.reason).toBe('not_reusable');
      expect(reviewAgentRuns).toBe(1);
    });

    it('the report never reached the hub', async () => {
      const p = makeProducer();
      const id = await rootCard(p);
      const item = await closeCard(id);
      fs.rmSync(item.verificationReceipts[0].execution.logPath, { force: true });
      expect((await publish()).pending).toBe(0);
      const token = await mintCiToken();
      const job = await ciJob(ciCheckout(p), { kind: 'verification', token });
      expect(job.result.reason).toBe('report_unavailable');
      expect(p.runs()).toBe(2);
    });

    it('a token of another organisation finds nothing, and blocks under --policy require', async () => {
      const { p } = await certified();
      await createPasswordUser(hubCtx.db, 'org-other', 'admin@other.test', PASSWORD, 'admin');
      const otherCookie = await loginAs(hubServer, 'admin@other.test', PASSWORD);
      const otherKey = await issueApiKey(hubCtx.db, 'org-other', 'other', { installationId: 'inst-other' });
      await hubCtx.db.run(
        `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_name, git_email)
         VALUES ('inst-other', 'org-other', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'o', 'O', 'o@other.test')`, [],
      );
      const init = await hubApi().post('/v1/repo-settings/init').set('Authorization', `Bearer ${otherKey}`).send({ repo: REMOTE, verifyCommand: SUITE });
      expect([200, 201]).toContain(init.status);
      // Enforce there too, so its token's empty answer is "nothing of yours", not "receipts are off".
      const mode = await hubApi().put('/v1/admin/repos/mode').set('Cookie', otherCookie).send({ repo: REMOTE, mode: 'enforce', shadowThreshold: 1 });
      expect(mode.status, JSON.stringify(mode.body)).toBe(200);
      const otherToken = await mintCiToken(otherCookie);
      const job = await ciJob(ciCheckout(p), { kind: 'verification', token: otherToken, policy: 'require', pr: 100 });
      expect(job.result.reason).toBe('no_receipt');
      expect(job.exitCode).toBe(1);
      expect(p.runs(), 'a blocked job runs nothing').toBe(1);
    });

    // The hub down when CI asks (hub_unavailable, the step runs): ci-check.test.ts "runs the step when the hub answers with an error"
    // and "runs the step when the hub does not answer in time".
    it('the hub is down when the producer publishes: the receipt stays pending, and CI runs the step', async () => {
      const p = makeProducer();
      const id = await rootCard(p);
      await closeCard(id);
      const down = await publishPendingReceipts({
        storage: storage as any, hubConfig: { ...hubConfig(), url: 'http://127.0.0.1:9' }, fetchImpl: globalThis.fetch as any,
      });
      expect(down.acked).toBe(0);
      const after = (await agent().get(`/items/${id}?records=1`)).body;
      expect(after.verificationReceipts[0].publication.state, 'not delivered is not acked').toBe('pending');
      const token = await mintCiToken();
      const job = await ciJob(ciCheckout(p), { kind: 'verification', token });
      expect(job.result.reason).toBe('no_receipt');
      expect(p.runs()).toBe(2);
      // Once the hub answers, the same receipt is delivered and reused.
      expect((await publish()).pending).toBe(0);
      const again = await ciJob(ciCheckout(p), { kind: 'verification', token });
      expect(again.exitCode, JSON.stringify(again.result)).toBe(0);
      expect(p.runs()).toBe(2);
    });
  });
});
