/**
 * @file 9569b4d7 — the board can see a verify that is running.
 *
 * A background verify lived only in the server's memory, so the card looked
 * idle for as long as its suite ran. Item responses now carry `activeRun`
 * while one runs, and the board can read the run's latest output without the
 * agent's token (the output it shows is the project's own test output, which
 * the card's comments already carry a preview of).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./active-run-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN, io } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const internal = () => ({ 'x-agenfk-internal': VERIFY_TOKEN! });
let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });

/** A card on WORK, whose leaving runs the suite: a command that prints, then takes a while. */
async function setup(ms = 1500) {
  const f = await agent().post('/flows').send({ name: `ar-${++seq}`, steps: [
    s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('NEXT', 2), s('END', 3, { isAnchor: true }),
  ] });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ar-repo-'));
  dirs.push(repo);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `ar-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node -e "console.log('hello-from-the-run'); setTimeout(() => {}, ${ms})"` } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `ar-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return { id: c.body.id as string, pid: p.body.id as string };
}
const until = async (pred: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out');
};

describe('9569b4d7: a running verify is visible to the board', () => {
  it('item responses carry activeRun while the run lasts, and drop it when it ends', async () => {
    const t = await setup();
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
    const one = (await agent().get(`/items/${t.id}`)).body;
    expect(one.activeRun).toMatchObject({ runId: v.body.runId, step: 'WORK' });
    expect(Number.isNaN(Date.parse(one.activeRun.startedAt))).toBe(false);
    const listed = (await agent().get('/items').query({ projectId: t.pid })).body.find((i: any) => i.id === t.id);
    expect(listed.activeRun).toMatchObject({ runId: v.body.runId });
    await until(async () => !(await agent().get(`/items/${t.id}`)).body.activeRun);
    expect((await agent().get(`/items/${t.id}`)).body.status).toBe('NEXT');
  });

  it("serves the run's latest output to the board, without the agent's token, while it runs", async () => {
    const t = await setup();
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status).toBe(202);
    await until(async () => /hello-from-the-run/.test((await agent().get(`/items/${t.id}/active-run`)).body?.output ?? ''));
    const r = await agent().get(`/items/${t.id}/active-run`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ runId: v.body.runId, step: 'WORK' });
    await until(async () => (await agent().get(`/items/${t.id}/active-run`)).status === 404);
  });

  it("streams a capture's output to the agent following the run, so the chat is not silent for the whole suite", async () => {
    const t = await setup();
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status).toBe(202);
    await until(async () => /hello-from-the-run/.test((await agent().get(`/items/validate-runs/${v.body.runId}`).set(internal())).body?.output ?? ''));
    await until(async () => (await agent().get(`/items/${t.id}/active-run`)).status === 404);
  });

  it('keeps only the last 8 KiB of an output far past the followers\' 256 KiB head', async () => {
    const t = await setup(0);
    await storage.updateProject(t.pid, { verifyCommand: `node -e "for (let i = 0; i < 40000; i++) console.log('line ' + i); setTimeout(() => {}, 3000)"` } as never);
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status).toBe(202);
    await until(async () => /line 39999/.test((await agent().get(`/items/${t.id}/active-run`)).body?.output ?? ''));
    const out: string = (await agent().get(`/items/${t.id}/active-run`)).body.output;
    expect(out.length).toBeLessThanOrEqual(8192);
    expect(out).toContain('line 39999');
  });

  it('a runner that leaves a process behind does not hold the run open (review)', async () => {
    const t = await setup(0);
    await storage.updateProject(t.pid, { verifyCommand: 'sleep 30 & echo started-a-leftover' } as never);
    const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status).toBe(202);
    const t0 = Date.now();
    await until(async () => (await agent().get(`/items/${t.id}/active-run`)).status === 404, 8000);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('tells the board a run started, while it runs', async () => {
    const t = await setup();
    const emit = vi.spyOn(io, 'emit');
    try {
      const before = emit.mock.calls.filter(c => c[0] === 'items_updated').length;
      const v = await agent().post(`/items/${t.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
      expect(v.status).toBe(202);
      expect((await agent().get(`/items/${t.id}`)).body.activeRun).toBeDefined();
      expect(emit.mock.calls.filter(c => c[0] === 'items_updated').length).toBeGreaterThan(before);
      await until(async () => !(await agent().get(`/items/${t.id}`)).body.activeRun);
    } finally { emit.mockRestore(); }
  });

  it("a capture's output and then the verify command's reach the follower in order, never rewound (review)", async () => {
    const f = await agent().post('/flows').send({ name: `ar-both-${++seq}`, steps: [
      s('START', 0, { isAnchor: true }), s('WORK', 1, { checks: [{ id: 'suite-green' }] }), s('END', 2, { isAnchor: true }),
    ] });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-ar-both-'));
    dirs.push(repo);
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo report.xml > .gitignore && git add . && git commit -qm one', { cwd: repo, shell: '/bin/sh' });
    const runner = path.join(repo, '..', `ar-runner-${seq}.js`);
    dirs.push(runner);
    fs.writeFileSync(runner, `console.log('from-the-capture'); require('fs').writeFileSync('report.xml', '<testsuites><testsuite name="s"><testcase classname="t" name="ok" file="t.test.js"/></testsuite></testsuites>'); setTimeout(() => {}, 800);`);
    const p = await agent().post('/projects').send({ name: `ar-both-${++seq}` });
    await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: repo, verifyCommand: `node -e "console.log('from-the-command'); setTimeout(() => {}, 800)"`, testReport: { format: 'junit-xml', command: `node ${runner}`, reportPath: 'report.xml' } } as never);
    const c = await agent().post('/items').send({ type: 'TASK', title: `ar-both-${++seq}`, projectId: p.body.id });
    await storage.updateItem(c.body.id, { status: 'WORK' } as any);
    const v = await agent().post(`/items/${c.body.id}/validate`).set(internal()).send({ evidence: 'ok', async: true });
    expect(v.status, JSON.stringify(v.body)).toBe(202);
    let last = '';
    let done = false;
    while (!done) {
      const r = (await agent().get(`/items/validate-runs/${v.body.runId}`).set(internal())).body;
      const out: string = r.output ?? '';
      expect(out.startsWith(last)).toBe(true);
      last = out;
      done = r.status !== 'running';
      await new Promise(res => setTimeout(res, 40));
    }
    expect(last.indexOf('from-the-capture')).toBeGreaterThanOrEqual(0);
    expect(last.indexOf('from-the-command')).toBeGreaterThan(last.indexOf('from-the-capture'));
  });

  it('answers 404 for a card with nothing running, and carries no activeRun', async () => {
    const t = await setup();
    expect((await agent().get(`/items/${t.id}/active-run`)).status).toBe(404);
    expect((await agent().get(`/items/${t.id}`)).body.activeRun).toBeUndefined();
  });
});
