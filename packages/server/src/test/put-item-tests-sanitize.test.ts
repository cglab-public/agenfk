/**
 * BUG 93d9fbd0 — PUT /items/:id accepted malformed test records, and one null
 * in a DONE sibling's tests made every sibling's final verify answer 500,
 * because sibling propagation read `test.status` on it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./put-item-tests-sanitize-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let seq = 0;
async function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-tests-sanitize-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `sanitize-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
async function task(projectId: string, extra: Record<string, unknown> = {}) {
  const c = await agent().post('/items').send({ type: 'TASK', title: `t-${++seq}`, projectId, ...extra });
  return c.body.id as string;
}

describe('PUT /items/:id tests', () => {
  it('refuses a tests value that is not an array, and stores nothing', async () => {
    const id = await task(await project());
    const res = await agent().put(`/items/${id}`).send({ tests: 'not-a-list' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tests/);
    expect((await agent().get(`/items/${id}`)).body.tests ?? []).toEqual([]);
  });

  it('drops entries that are not objects and keeps the rest', async () => {
    const id = await task(await project());
    const res = await agent().put(`/items/${id}`).send({ tests: [null, 5, 'x', { id: 't1', command: 'c', status: 'FAILED' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tests = (await agent().get(`/items/${id}`)).body.tests;
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ id: 't1', command: 'c', status: 'FAILED' });
  });
});

describe('sibling propagation over a stored malformed test record', () => {
  it('a null in a DONE sibling\'s tests does not make another sibling\'s final verify 500', async () => {
    const projectId = await project();
    const parent = (await agent().post('/items').send({ type: 'STORY', title: `p-${++seq}`, projectId })).body.id;
    const done = await task(projectId, { parentId: parent });
    const next = await task(projectId, { parentId: parent });
    // Stored directly: records written before the PUT sanitised them.
    await storage.updateItem(done, { status: 'DONE', tests: [null] } as any);
    await storage.updateItem(next, { status: 'TEST' } as any);
    const res = await agent().post(`/items/${next}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${next}`)).body.status).toBe('DONE');
  });

  it('a stored tests value that is not a list (an object) does not make another sibling\'s final verify 500', async () => {
    const projectId = await project();
    const parent = (await agent().post('/items').send({ type: 'STORY', title: `p-${++seq}`, projectId })).body.id;
    const done = await task(projectId, { parentId: parent });
    const next = await task(projectId, { parentId: parent });
    await storage.updateItem(done, { status: 'DONE', tests: {} } as any);
    await storage.updateItem(next, { status: 'TEST' } as any);
    const res = await agent().post(`/items/${next}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${next}`)).body.status).toBe('DONE');
  });
});

describe('a card whose own stored tests are malformed', () => {
  for (const [label, stored] of [['[null]', [null]], ['an object', {}]] as const) {
    it(`with ${label}: verify lands DONE and stamps the new green with its commit`, async () => {
      const id = await task(await project());
      await storage.updateItem(id, { status: 'TEST', tests: stored } as any);
      const res = await agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'done' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = (await agent().get(`/items/${id}`)).body;
      expect(after.status).toBe('DONE');
      const green = after.tests.filter((t: any) => t && t.status === 'PASSED');
      expect(green).toHaveLength(1);
      expect(green[0].commit).toMatch(/^[0-9a-f]{40}$/);
    });
  }
});
