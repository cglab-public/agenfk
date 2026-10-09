/**
 * @file CGLAB-457 (T1) — the review range is the server's to work out, and a
 * refused review says what to do next.
 *
 * The range a review must cover is already fixed by the review-record check:
 * from where the card's work began (its first step's exit head) to a tip that
 * holds every descendant's close commit. Asking the agent to dig that start
 * commit out of the card's step records added nothing but a way to get it
 * wrong, so `range` may be left out (or given as `auto`) and the server fills
 * in `<start>..HEAD`. Uncommitted work stays pinned by the tree snapshot, so a
 * review of an uncommitted change records `<start>..<start>`.
 *
 * Nothing about independence changes: the reviewer is still read from the
 * transcript, and an explicit range is still checked exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { testDbPath } from './helpers/testDb';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('review-range-auto-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rauto-home-'));
  cleanup.push(home);
  process.env.HOME = home;
  await initStorage();
  __server = app.listen(0);
});
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  process.env.HOME = savedHome;
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });

function makeRepo(): { dir: string; base: string; tip: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-rauto-repo-'));
  cleanup.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const base = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  execSync('git add . && git commit -qm two', { cwd: dir, shell: '/bin/sh' });
  const tip = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, tip };
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
function claudeSubagentTranscript(session: string, agentId: string, lastAt: string): string {
  const proj = path.join(home, '.claude', 'projects', '-repo');
  const dir = path.join(proj, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(proj, `${session}.jsonl`), line({ type: 'user', sessionId: session, timestamp: '2026-01-01T00:00:00.000Z' }));
  const f = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f,
    line({ type: 'user', isSidechain: true, agentId, sessionId: session, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'review' } })
    + line({ type: 'assistant', isSidechain: true, agentId, sessionId: session, timestamp: lastAt, message: { role: 'assistant', content: 'findings' } }));
  return f;
}

let seq = 0;
const FUTURE = '2099-01-01T00:00:00.000Z';
const AUTHOR = { client: 'claude-code', sessionId: 'author-sess', agentId: null };
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

async function setup() {
  const repo = makeRepo();
  const f = await agent().post('/flows').send({ name: `ra-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('WORK', 1, { role: 'planning' }),
    s('LOOK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `ra-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: repo.dir, flowId: f.body.id, verifyCommand: 'exit 0' } as never);
  return { ...repo, pid: p.body.id as string };
}
/** A card at LOOK whose work began at `start`; `start: null` gives it no recorded start. */
async function cardAt(pid: string, start: string | null, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'STORY', title: `card-${++seq}`, projectId: pid });
  const stepRecords = start === null ? [] : [{ step: 'START', kind: 'exit', at: 't', head: start, clean: true, actor: AUTHOR }];
  await storage.updateItem(c.body.id, { status: 'LOOK', stepRecords, ...extra } as any);
  return c.body.id as string;
}
const record = (id: string, body: Record<string, unknown>) =>
  agent().post(`/items/${id}/review-records`).set(internal()).send(body);
const validate = (id: string) => agent().post(`/items/${id}/validate`).set(internal()).send({ evidence: 'ok' });
const reviewCheck = (body: any) => (body.checks ?? []).find((c: any) => c.id === 'review-record');

describe('CGLAB-457: the review range defaults to where the card began, up to HEAD', () => {
  it('fills in <start>..HEAD when the range is left out, and marks it as worked out', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'auto1', FUTURE), findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range).toEqual({ from: base, to: tip, auto: true });
  });

  it("takes `auto` as the same as leaving the range out", async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'auto2', FUTURE), range: 'auto', findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range).toEqual({ from: base, to: tip, auto: true });
  });

  it('keeps an explicit range exactly as given, not marked as worked out', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'explicit1', FUTURE), range: `${base}..${tip}`, findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range).toEqual({ from: base, to: tip });
  });

  it('refuses an automatic range on a card with no recorded start, and says to pass one', async () => {
    const { pid } = await setup();
    const id = await cardAt(pid, null);
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'nostart', FUTURE), findings: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start commit/);
    expect(res.body.error).toMatch(/--range <from>\.\.<to>/);
  });

  it('records a review of uncommitted work as <start>..<start>, and the card leaves its review step with it', async () => {
    const { dir, tip, pid } = await setup();
    const id = await cardAt(pid, tip);
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'not committed yet');
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'wip1', FUTURE), findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range).toEqual({ from: tip, to: tip, auto: true });
    const v = await validate(id);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
  });
});

describe("CGLAB-457 review: a parent's range covers its whole tree", () => {
  it('works out the range of a parent the roll-up moved, which has no exit record of its own, from its children', async () => {
    const { base, tip, pid } = await setup();
    const parent = await cardAt(pid, null);
    await cardAt(pid, base, { parentId: parent, status: 'END' });
    const res = await record(parent, { transcript: claudeSubagentTranscript('author-sess', 'rolled1', FUTURE), findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range).toEqual({ from: base, to: tip, auto: true });
  });

  it("starts before a child's work committed ahead of the parent's own start", async () => {
    const { dir, base, pid } = await setup();
    fs.writeFileSync(path.join(dir, 'child.txt'), 'child work');
    execSync('git add . && git commit -qm "close(task): child"', { cwd: dir, shell: '/bin/sh' });
    const later = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    const parent = await cardAt(pid, later);
    await cardAt(pid, base, { parentId: parent, status: 'END' });
    const res = await record(parent, { transcript: claudeSubagentTranscript('author-sess', 'early1', FUTURE), findings: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.range.from).toBe(base);
  });
});

describe('CGLAB-457: a refused review says what to do next', () => {
  it('with no review, names the brief, the record command and the range it would use', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await validate(id);
    expect(res.status).toBe(422);
    const detail = reviewCheck(res.body).detail as string;
    expect(detail).toContain(`agenfk review brief ${id}`);
    expect(detail).toContain(`agenfk review record ${id}`);
    expect(detail).toContain(`${base.slice(0, 12)}..HEAD`);
    expect(detail).not.toContain('--range <from>..<to>');
  });

  it('a range that starts too late says to leave the range out', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    expect((await record(id, { transcript: claudeSubagentTranscript('author-sess', 'late1', FUTURE), range: `${tip}..${tip}`, findings: [] })).status).toBe(201);
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(reviewCheck(res.body).detail).toMatch(/omit --range/i);
    expect(reviewCheck(res.body).detail).toContain(`${base.slice(0, 12)}..HEAD`);
  });

  it('a file changed after the review is named', async () => {
    const { dir, base, pid } = await setup();
    const id = await cardAt(pid, base);
    expect((await record(id, { transcript: claudeSubagentTranscript('author-sess', 'files1', FUTURE), findings: [] })).status).toBe(201);
    fs.writeFileSync(path.join(dir, 'late.txt'), 'written after the review');
    const res = await validate(id);
    expect(res.status).toBe(422);
    const detail = reviewCheck(res.body).detail as string;
    expect(detail).toMatch(/changed after the review/);
    expect(detail).toContain('late.txt');
  });

  it('a commit made after the review is told apart from an edit, and named', async () => {
    const { dir, base, pid } = await setup();
    const id = await cardAt(pid, base);
    expect((await record(id, { transcript: claudeSubagentTranscript('author-sess', 'head1', FUTURE), findings: [] })).status).toBe(201);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c');
    execSync('git add . && git commit -qm three', { cwd: dir, shell: '/bin/sh' });
    const moved = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    const res = await validate(id);
    expect(res.status).toBe(422);
    const detail = reviewCheck(res.body).detail as string;
    expect(detail).toMatch(/commit/);
    expect(detail).toContain(moved.slice(0, 12));
  });

  it('a transcript older than the tip says how to have it read the newer work', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await record(id, { transcript: claudeSubagentTranscript('author-sess', 'stale1', '2000-01-01T00:00:00.000Z'), findings: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/before/);
    expect(res.body.error).toMatch(/new message/);
  });
});
