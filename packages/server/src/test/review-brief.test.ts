/**
 * @file CGLAB-457 (T2) — the reviewer's brief, written by the server.
 *
 * `GET /items/:id/review-brief` is what the author hands an independent
 * reviewer. Everything in it is already on the card or in its tree: the
 * range the review must cover (the same one `review record` fills in), the
 * files the card changed (uncommitted ones included), the warnings its tree
 * left its steps with and their answers, the evidence the author recorded -
 * labelled as the author's claims, not facts - the tests already run, and what
 * the server will run when the card leaves the step, so the reviewer does not
 * spend a suite run the server makes anyway. The rules a reviewer must keep to
 * stay independent come from the server too, so they cannot drift from the
 * checks that judge them.
 *
 * It is a read: asking for a brief changes nothing on the card.
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

const TEST_DB = testDbPath('review-brief-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const cleanup: string[] = [];
const savedHome = process.env.HOME;
beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-brief-home-'));
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

function makeRepo(): { dir: string; base: string; tip: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-brief-repo-'));
  cleanup.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execSync('git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const base = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  execSync('git add . && git commit -qm two', { cwd: dir, shell: '/bin/sh' });
  const tip = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, tip };
}

let seq = 0;
const AUTHOR = { client: 'claude-code', sessionId: 'author-sess', agentId: null };
const CRITERIA = 'Hunt for defects in the change as an adversarial reviewer.';
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

async function setup() {
  const repo = makeRepo();
  const f = await agent().post('/flows').send({ name: `rb-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('WORK', 1, { role: 'planning' }),
    s('LOOK', 2, { role: 'review', exitCriteria: CRITERIA }), s('END', 3, { isAnchor: true, role: 'closing' }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `rb-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: repo.dir, flowId: f.body.id, verifyCommand: 'exit 0' } as never);
  return { ...repo, pid: p.body.id as string };
}
async function cardAt(pid: string, start: string, status = 'LOOK', extra: Record<string, unknown> = {}, type = 'STORY') {
  const c = await agent().post('/items').send({ type, title: `card-${++seq}`, projectId: pid });
  const { stepRecords = [], ...rest } = extra as any;
  await storage.updateItem(c.body.id, { status, stepRecords: [{ step: 'START', kind: 'exit', at: 't', head: start, clean: true, actor: AUTHOR }, ...stepRecords], ...rest } as any);
  return c.body.id as string;
}
const brief = (id: string) => agent().get(`/items/${id}/review-brief`);

describe('CGLAB-457: GET /items/:id/review-brief', () => {
  it('gives the range the review must cover and the record command, with the range left to the server', async () => {
    const { base, tip, pid } = await setup();
    const id = await cardAt(pid, base);
    const res = await brief(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ itemId: id, step: 'LOOK', range: { from: base, to: tip } });
    expect(res.body.recordCommand).toContain(`agenfk review record ${id}`);
    expect(res.body.recordCommand).not.toContain('--range');
  });

  it("lists the card's changed files since it began, uncommitted and untracked ones included", async () => {
    const { dir, base, pid } = await setup();
    const id = await cardAt(pid, base);
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edited\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    const res = await brief(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.files.map((f: any) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
    expect(res.body.text).toContain(`git diff ${base}`);
  });

  it('carries the step\'s exit criteria, what leaving it runs, and the rules that keep the reviewer independent', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    const { body } = await brief(id);
    expect(body.exitCriteria).toBe(CRITERIA);
    expect(body.text).toContain(CRITERIA);
    expect(body.leavePlan).toMatch(/Leaving LOOK runs the project's verify command/);
    expect(body.text).toContain(body.leavePlan);
    expect(body.text).toMatch(/do not run the full suite/i);
    expect(body.text).toMatch(/do not run `agenfk verify`/i);
    expect(body.text).toMatch(/read-only/i);
    expect(body.findingsSchema).toMatchObject({ type: 'array' });
  });

  it("hands over the tree's warnings and each answer", async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    await cardAt(pid, base, 'END', { parentId: id, stepRecords: [{ step: 'WORK', kind: 'exit', at: 't2', head: base, clean: true, checks: [
      { id: 'new-tests-born-green', severity: 'warn', outcome: 'fail', detail: 'x.test passed before any code', answer: 'it pins behaviour that already exists' },
    ] }] }, 'TASK');
    const { body } = await brief(id);
    expect(body.treeWarnings).toHaveLength(1);
    expect(body.treeWarnings[0]).toMatchObject({ check: 'new-tests-born-green', answer: 'it pins behaviour that already exists' });
    expect(body.text).toContain('it pins behaviour that already exists');
  });

  it("gives the author's recorded evidence, labelled as claims, and leaves other comments out", async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base, 'LOOK', { comments: [
      { id: 'c1', author: 'agent', content: '**Evidence [WORK]:** implemented the parser and its tests', timestamp: new Date(), step: 'WORK' },
      { id: 'c2', author: 'agent', content: 'just a progress note', timestamp: new Date(), step: 'WORK' },
    ] });
    const { body } = await brief(id);
    expect(body.evidence).toEqual([{ step: 'WORK', text: 'implemented the parser and its tests' }]);
    expect(body.text).toMatch(/author's claims/i);
    expect(body.text).toContain('implemented the parser and its tests');
    expect(body.text).not.toContain('just a progress note');
  });

  it('says which tests already ran on the card, from its latest usable capture', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base, 'LOOK', { stepRecords: [{ step: 'WORK', kind: 'capture', at: 't3', head: base, clean: false, available: true, format: 'junit-xml', tests: [
      { name: 'a > one', file: 'a', status: 'passed' }, { name: 'a > two', file: 'a', status: 'passed' }, { name: 'a > three', file: 'a', status: 'failed' },
    ] }] });
    const { body } = await brief(id);
    expect(body.tests).toMatchObject({ step: 'WORK', passed: 2, failed: 1 });
    expect(body.text).toMatch(/2 passed, 1 failed/);
  });

  it("briefs a parent the roll-up moved, with no exit record of its own, from its children's start", async () => {
    const { base, pid } = await setup();
    const c = await agent().post('/items').send({ type: 'STORY', title: `rolled-${++seq}`, projectId: pid });
    await storage.updateItem(c.body.id, { status: 'LOOK', stepRecords: [] } as any);
    await cardAt(pid, base, 'END', { parentId: c.body.id }, 'TASK');
    const res = await brief(c.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.range.from).toBe(base);
  });

  it('keeps the most recent evidence, by time, across the tree', async () => {
    const { base, pid } = await setup();
    const old = new Date('2026-01-01T00:00:00Z');
    const id = await cardAt(pid, base, 'LOOK', { comments: [{ id: 'p1', author: 'agent', content: '**Evidence [WORK]:** the parent, newest', timestamp: new Date('2026-06-01T00:00:00Z'), step: 'WORK' }] });
    await cardAt(pid, base, 'END', { parentId: id, comments: Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, author: 'agent', content: `**Evidence [WORK]:** old child claim ${i}`, timestamp: old, step: 'WORK' })) }, 'TASK');
    const { body } = await brief(id);
    expect(body.evidence).toHaveLength(30);
    expect(body.evidence.map((e: any) => e.text)).toContain('the parent, newest');
  });

  it('says a reviewer may run a test only where it writes nothing into the tree', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    expect((await brief(id)).body.text).toMatch(/writes nothing into the tree/);
  });

  it('is refused off a review step', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base, 'WORK');
    const res = await brief(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/review/);
  });

  it('is refused on a child reviewed with its parent, naming the parent', async () => {
    const { base, pid } = await setup();
    const parent = await cardAt(pid, base, 'WORK');
    const child = await cardAt(pid, base, 'LOOK', { parentId: parent }, 'TASK');
    const res = await brief(child);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(parent.slice(0, 8));
  });

  it('is named on the verify that brings a card onto its review step', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base, 'WORK');
    const res = await agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'built it' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toContain(`agenfk review brief ${id}`);
  });

  it('is a 404 for a card that does not exist', async () => {
    expect((await brief('no-such-card')).status).toBe(404);
  });

  it('changes nothing on the card', async () => {
    const { base, pid } = await setup();
    const id = await cardAt(pid, base);
    const before = (await agent().get(`/items/${id}?records=1`)).body;
    expect((await brief(id)).status).toBe(200);
    const after = (await agent().get(`/items/${id}?records=1`)).body;
    for (const k of ['status', 'comments', 'stepRecords', 'reviewRecords', 'updatedAt']) expect(after[k], k).toEqual(before[k]);
  });
});
