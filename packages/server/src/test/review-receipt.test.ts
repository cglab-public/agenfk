/**
 * @file RFC-002 (task 95ba0ec5) — recording an independent review leaves a
 * REVIEW RECEIPT on the card.
 *
 * A review record is a local note: it says who reviewed what, in this checkout.
 * A review receipt is the same claim made so another machine can honour it —
 * the reviewer's identity as read from its transcript, the range it covered,
 * the independence verdict the server itself reached, the human gates under it,
 * and the tree it all points at. It is made when the record is stored, for a
 * ROOT card of a project in receipts mode; a child is reviewed with its parent
 * and a project outside receipts mode leaves no claim for anyone else to
 * honour, so neither gets one.
 *
 * The verdict is the receipt's worth, so the tests are mostly the ways it comes
 * back false: a reviewer who is also an author, a tree with uncommitted work —
 * and each is still written down, because Shadow mode measures how often real
 * reviews fail this rather than hiding them.
 *
 * What never leaves is the transcript's path. The receipt is a claim about a
 * file, not a pointer into someone's home directory: it carries the hash.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('review-receipt-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { bindRoleLessDefaultFlow } from './helpers/roleLessFlow';
import { posixShell } from './helpers/posixShell';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipt-home-'));
  cleanup.push(home);
  process.env.HOME = process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  process.env.HOME = savedHome; process.env.USERPROFILE = savedUserProfile;
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

/** A repo with two commits; returns both SHAs and the tip's commit time. */
function makeRepo(): { dir: string; base: string; tip: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-receipt-repo-')));
  cleanup.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: posixShell() });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: posixShell() });
  const base = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  execSync('git add . && git commit -qm two', { cwd: dir, shell: posixShell() });
  const tip = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, tip };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
/** A Claude Code sub-agent transcript under the sandboxed ~/.claude/projects. */
function claudeSubagentTranscript(session: string, agentId: string, lastAt: string, opts: { toolUses?: Array<Record<string, unknown>>; parent?: boolean } = {}): string {
  const proj = path.join(home, '.claude', 'projects', '-repo');
  const dir = path.join(proj, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  // The parent session's own transcript: a sub-agent's log sits beside it.
  if (opts.parent !== false) fs.writeFileSync(path.join(proj, `${session}.jsonl`), line({ type: 'user', sessionId: session, timestamp: '2026-01-01T00:00:00.000Z' }));
  const f = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f,
    line({ type: 'user', isSidechain: true, agentId, sessionId: session, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'review' } })
    + (opts.toolUses ?? []).map(u => line({ type: 'assistant', isSidechain: true, agentId, sessionId: session, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', ...u }] } })).join('')
    + line({ type: 'assistant', isSidechain: true, agentId, sessionId: session, timestamp: lastAt, message: { role: 'assistant', content: 'findings' } }));
  return f;
}

/** The hub's settings for the repository, as the sync stores them — in receipts mode. */
const hubSettings = (receiptsMode: 'off' | 'shadow' | 'enforce') => ({
  remoteUrl: 'git@github.com:acme/app.git',
  verifyCommand: 'npm test',
  revision: 2,
  receiptsMode,
  shadowThreshold: null,
  producers: [],
  syncedAt: new Date().toISOString(),
});

let seq = 0;
/**
 * A project in receipts mode with a card whose tree is `dir`. Returns both ids:
 * the project is where the receipts mode lives, the card where the receipt lands.
 */
async function cardIn(dir: string, receiptsMode: 'off' | 'shadow' | 'enforce' = 'shadow'): Promise<{ id: string; projectId: string }> {
  const p = await agent().post('/projects').send({ name: `receipt-${++seq}` });
  const projectId = p.body.id as string;
  await storage.updateProject(projectId, {
    projectRoot: dir,
    hubRepoSettings: hubSettings(receiptsMode),
  } as never);
  await bindRoleLessDefaultFlow(storage, projectId);
  const c = await agent().post('/items').send({ type: 'STORY', title: `card-${++seq}`, projectId });
  return { id: c.body.id as string, projectId };
}

/**
 * The card's work: an exit record at the range's base, by `author-session`.
 * Without an author there is no independence to judge — the receipt would be a
 * receipt that says nothing.
 */
const authored = (id: string, base: string, authorSession = 'author-session') =>
  storage.updateItem(id, {
    stepRecords: [{
      kind: 'exit', step: 'WORK', at: '2026-01-01T00:00:00.000Z', head: base,
      actor: { client: 'claude-code', sessionId: authorSession, agentId: null },
    }],
  } as never);

const record = (id: string, body: Record<string, unknown>) =>
  agent().post(`/items/${id}/review-records`).set(internal()).send(body);
const FUTURE = '2099-01-01T00:00:00.000Z';
const findings = [{ title: 'null deref in x', state: 'fixed' }, { title: 'rename y', state: 'rejected', reason: 'out of scope' }];
const item = async (id: string) => (await agent().get(`/items/${id}?records=1`)).body;
const reviewReceipts = async (id: string): Promise<any[]> => (await item(id))?.reviewReceipts ?? [];
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// An argv, not a shell string: cmd.exe on Windows reads `^` as its escape and git got `HEAD{tree}`.
const revParse = (dir: string, ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();
/** A fresh reviewer: a Claude Code sub-agent transcript of its own session. */
const reviewer = (session: string, agentId: string) => claudeSubagentTranscript(session, agentId, FUTURE);
/** A person's approval on the card, as the board writes one. */
const approved = async (id: string) => {
  const current: any = await storage.getItem(id);
  await storage.updateItem(id, {
    stepRecords: [...(current?.stepRecords ?? []), { kind: 'approval', step: 'REVIEW', at: '2026-01-02T00:00:00.000Z' }],
  } as never);
};

describe('RFC-002 (95ba0ec5): a recorded review leaves a review receipt', () => {
  it('a root card, an independent reviewer, a clean tree: the receipt says so, in full', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    await authored(id, base);
    const transcript = reviewer('sess-receipt-1', 'agentR1');
    await approved(id);
    const res = await record(id, { transcript, range: `${base}..${tip}`, findings });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const receipts = await reviewReceipts(id);
    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    expect(r.kind).toBe('review');
    expect(r.version).toBe(1);
    expect(typeof r.id).toBe('string');
    expect(r.repo).toBe('git@github.com:acme/app.git');
    expect(r.receiptsMode).toBe('shadow');

    // The card the receipt speaks for.
    expect(r.card.id).toBe(id);
    expect(typeof r.card.title).toBe('string');
    expect(r.card.type).toBe('STORY');
    expect(r.card).toHaveProperty('owner');
    // Who recorded it, as git knows them: this is the machine that ran the server.
    expect(Object.keys(r.card.recordedBy).sort()).toEqual(['email', 'name']);
    expect(r.card).toHaveProperty('link');

    // The review, as the server judged it rather than as the caller described it.
    const rec = (await item(id)).reviewRecords[0];
    expect(r.review.recordId).toBe(rec.id);
    expect(r.review.recordedAt).toBe(rec.at);
    expect(r.review.reviewer).toEqual({ client: 'claude-code', sessionId: 'sess-receipt-1', agentId: 'agentR1' });
    expect(r.review.authors).toEqual([{ client: 'claude-code', sessionId: 'author-session', agentId: null }]);
    expect(r.review.independence.outcome).toBe('pass');
    expect(typeof r.review.independence.detail).toBe('string');
    expect(r.review.range).toEqual({ from: base, to: tip });
    expect(r.review.lenses).toEqual(['general']);
    expect(r.review.findings).toEqual(findings);
    expect(r.review.transcriptSha256).toBe(sha256(transcript));

    expect(r.humanGates).toEqual([{ kind: 'approval', step: 'REVIEW', at: '2026-01-02T00:00:00.000Z' }]);
    expect(r.content.commit).toBe(tip);
    expect(r.content.gitTree).toBe(revParse(dir, `${tip}^{tree}`));
    expect(r.reusable).toBe(true);
    expect(r.notReusableReason).toBeNull();

    // A receipt crosses machines. The transcript it was read from does not.
    const json = JSON.stringify(r);
    expect(json).not.toContain(transcript);
    expect(json).not.toContain(home);
  });

  it('the lenses the review was run through are stored and receipted, de-duplicated in order', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    await authored(id, base);
    const res = await record(id, {
      transcript: reviewer('sess-lens-1', 'agentL1'), range: `${base}..${tip}`, findings: [],
      lenses: ['security', 'general', 'security'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.lenses).toEqual(['security', 'general']);
    expect((await item(id)).reviewRecords[0].lenses).toEqual(['security', 'general']);
    const receipts = await reviewReceipts(id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].review.lenses).toEqual(['security', 'general']);
  });

  it('a lens that is not a lens, or none at all, is refused: nothing recorded, nothing receipted', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    await authored(id, base);
    const transcript = reviewer('sess-lens-2', 'agentL2');
    // Each of these is a request that must change nothing on the card.
    const bad = await record(id, { transcript, range: `${base}..${tip}`, findings: [], lenses: ['Security!'] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/lens/i);
    // An empty list asks for no lens at all, which is not a thing a review is
    // run through; more than eight is a list, not a set of lenses; and a bare
    // string is not a list.
    expect((await record(id, { transcript, range: `${base}..${tip}`, findings: [], lenses: [] })).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => `lens-${i}`);
    expect((await record(id, { transcript, range: `${base}..${tip}`, findings: [], lenses: nine })).status).toBe(400);
    expect((await record(id, { transcript, range: `${base}..${tip}`, findings: [], lenses: 'security' })).status).toBe(400);

    // Nothing above may be recorded — each refusal is asked of the same card.
    const after = await item(id);
    expect(after.reviewRecords ?? []).toHaveLength(0);
    expect(after.reviewReceipts ?? []).toHaveLength(0);
  });

  it('a reviewer who is an author is receipted as it is: not reusable, and saying why', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    // The reviewer IS an author: the same session AND agent advanced the card.
    // (A different sub-agent of the author's session would be independent, as
    // judgeReview compares session and agent id.)
    await storage.updateItem(id, {
      stepRecords: [{
        kind: 'exit', step: 'WORK', at: '2026-01-01T00:00:00.000Z', head: base,
        actor: { client: 'claude-code', sessionId: 'author-session', agentId: 'agentSelf' },
      }],
    } as never);
    const res = await record(id, {
      transcript: claudeSubagentTranscript('author-session', 'agentSelf', FUTURE),
      range: `${base}..${tip}`, findings: [],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const receipts = await reviewReceipts(id);
    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    expect(r.reusable).toBe(false);
    expect(r.notReusableReason).toBe('not_independent');
    expect(r.review.independence.outcome).toBe('fail');
    expect(r.review.reviewer.sessionId).toBe('author-session');
    expect(r.review.authors.map((a: any) => a.sessionId)).toContain('author-session');
  });

  it('a tree with uncommitted work receipts nothing reusable: the tip is not what the tree holds', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    await authored(id, base);
    fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'not committed\n');
    // `auto` resolves to base..HEAD, and HEAD is what is NOT clean here: the
    // receipt is judged against the tree it was recorded in, not only the range.
    const res = await record(id, { transcript: reviewer('sess-dirty', 'agentDirty'), findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const receipts = await reviewReceipts(id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].reusable).toBe(false);
    expect(receipts[0].notReusableReason).toBe('uncommitted_changes');
    // It still says what it was a review of.
    expect(receipts[0].content.commit).toBe(tip);
    expect(receipts[0].review.independence.outcome).toBe('pass');
  });

  it('CONTROL — a child card is reviewed with its parent, so it leaves no receipt', async () => {
    const { dir, base, tip } = makeRepo();
    const { id: parentId } = await cardIn(dir);
    const c = await agent().post('/items').send({ type: 'TASK', title: 'child-card', projectId: (await item(parentId)).projectId, parentId });
    const childId = c.body.id as string;
    await authored(childId, base);
    const res = await record(childId, { transcript: reviewer('sess-child', 'agentChild'), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(((await item(childId)).reviewRecords ?? [])).toHaveLength(1);
    expect(await reviewReceipts(childId)).toHaveLength(0);
  });

  it('CONTROL — a project outside receipts mode records the review and receipts nothing', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir, 'off');
    await authored(id, base);
    const res = await record(id, { transcript: reviewer('sess-off', 'agentOff'), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(((await item(id)).reviewRecords ?? [])).toHaveLength(1);
    expect(await reviewReceipts(id)).toHaveLength(0);
  });

  it('the human gates under the review ride on the receipt, on the card and on its children', async () => {
    const { dir, base, tip } = makeRepo();
    const { id, projectId } = await cardIn(dir);
    await authored(id, base);
    const c = await agent().post('/items').send({ type: 'TASK', title: 'gated-child', projectId, parentId: id });
    const childId = c.body.id as string;
    await storage.updateItem(childId, {
      stepRecords: [
        { kind: 'approval', step: 'ACCEPTANCE', at: '2026-01-03T00:00:00.000Z', by: 'board', covers: [] },
        { kind: 'override', step: 'REVIEW', at: '2026-01-04T00:00:00.000Z', by: 'board', check: 'suite-green', reason: 'flaky on the runner' },
      ],
    } as never);

    await approved(id);
    const res = await record(id, { transcript: reviewer('sess-gates', 'agentG1'), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const gates = (await reviewReceipts(id))[0].humanGates as any[];
    expect(gates).toHaveLength(3);
    expect(gates).toContainEqual({ kind: 'approval', step: 'REVIEW', at: '2026-01-02T00:00:00.000Z' });
    expect(gates).toContainEqual({ kind: 'approval', step: 'ACCEPTANCE', at: '2026-01-03T00:00:00.000Z' });
    expect(gates).toContainEqual({ kind: 'override', step: 'REVIEW', at: '2026-01-04T00:00:00.000Z' });
  });

  it('a card with no human gate receipts an empty list, not a missing field', async () => {
    const { dir, base, tip } = makeRepo();
    const { id } = await cardIn(dir);
    await authored(id, base);
    expect((await item(id)).stepRecords.some((r: any) => r.kind === 'approval' || r.kind === 'override')).toBe(false);
    const res = await record(id, { transcript: reviewer('sess-nogate', 'agentG2'), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await reviewReceipts(id))[0].humanGates).toEqual([]);
  });
});
