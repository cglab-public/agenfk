/**
 * @file CGLAB-381 (S5-T4) — a project on the built-in default flow, with no
 * flow of its own, is now gated by the default flow's roles.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = testDbPath('default-flow-enforced-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { echoRepo, A } from './helpers/echoRepo';

let __server: import('http').Server;
const agent = () => request(__server);
const dirs: string[] = [];
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => {
  await removeTestDb(TEST_DB, closeStorage);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function repo(): string {
  const dir = echoRepo(A, 'agenfk-default-enforced-');
  dirs.push(dir);
  return dir;
}
let seq = 0;
async function cardOnDefaultFlow(status: string, extra: Record<string, unknown> = {}) {
  const p = await agent().post('/projects').send({ name: `dfe-${++seq}` });
  await storage.updateProject(p.body.id, extra as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `dfe-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}
// Sent as the CLI sends it: the author running this verify (CGLAB-381).
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! })
  .send({ evidence: 'ok', actor: { client: 'claude-code', sessionId: 'the-author' } });
const check = (body: any, id: string) => (body.checks ?? []).find((c: any) => c.id === id);

describe('CGLAB-381: the default flow is enforced', () => {
  it('leaving IN_PROGRESS runs the suite: a red suite stays put', async () => {
    const id = await cardOnDefaultFlow('IN_PROGRESS', { projectRoot: repo(), verifyCommand: 'exit 1' });
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(check(res.body, 'suite-green')).toMatchObject({ outcome: 'fail', blocking: true });
  });

  it('a green suite moves on to REVIEW', async () => {
    const id = await cardOnDefaultFlow('IN_PROGRESS', { projectRoot: repo(), verifyCommand: 'exit 0' });
    expect((await validate(id)).status).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('REVIEW');
  });

  it('leaving REVIEW needs an independent review on record', async () => {
    const id = await cardOnDefaultFlow('REVIEW', { projectRoot: repo(), verifyCommand: 'exit 0' });
    const res = await validate(id);
    expect(res.status).toBe(422);
    expect(check(res.body, 'review-record')).toMatchObject({ outcome: 'fail', blocking: true });
  });
});
