/**
 * @file CGLAB-381 (S5-T3) — a parent never skips its own review.
 *
 * Reviews happen at the parent (user decision 2026-09-23), and the parent
 * used to follow its children forward on its own: when the last task of S4
 * closed, the story jumped to DONE past its review step. A parent now stops at
 * the first step whose checks include the review record, and only verify moves
 * it on. A flow with no such step keeps the old behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => {
  const mockAxios = vi.fn() as any;
  mockAxios.get = vi.fn();
  mockAxios.post = vi.fn();
  mockAxios.create = vi.fn(() => mockAxios);
  return { default: mockAxios };
});

const TEST_DB = path.resolve('./parent-stops-at-review-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage, VERIFY_TOKEN } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

let seq = 0;
const s = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}`, name, label: name, order, ...extra });
async function projectWith(steps: any[]) {
  const f = await agent().post('/flows').send({ name: `psr-${++seq}`, steps });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const p = await agent().post('/projects').send({ name: `psr-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
async function card(pid: string, status: string, extra: Record<string, unknown> = {}, type = 'TASK') {
  const c = await agent().post('/items').send({ type, title: `c-${++seq}`, projectId: pid });
  await storage.updateItem(c.body.id, { status, ...extra } as any);
  return c.body.id as string;
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'ok' });
const statusOf = async (id: string) => (await agent().get(`/items/${id}`)).body.status;

describe('CGLAB-381: parents stop at their review step', () => {
  it('when the last child finishes, the parent lands on its review step, not the end', async () => {
    const pid = await projectWith([s('START', 0, { isAnchor: true }), s('WORK', 1, { role: 'planning' }), s('LOOK', 2, { role: 'review' }), s('END', 3, { isAnchor: true, role: 'closing' })]);
    const parent = await card(pid, 'WORK', {}, 'STORY');
    const child = await card(pid, 'LOOK', { parentId: parent });
    const res = await validate(child);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(child)).toBe('END');
    expect(await statusOf(parent)).toBe('LOOK');
  });

  it('a parent already on its review step is not moved past it', async () => {
    const pid = await projectWith([s('START', 0, { isAnchor: true }), s('LOOK', 1, { role: 'review' }), s('END', 2, { isAnchor: true, role: 'closing' })]);
    const parent = await card(pid, 'LOOK', {}, 'STORY');
    const child = await card(pid, 'LOOK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(await statusOf(parent)).toBe('LOOK');
  });

  it('a flow with no review step keeps following its children to the end', async () => {
    const pid = await projectWith([s('START', 0, { isAnchor: true }), s('WORK', 1), s('END', 2, { isAnchor: true })]);
    const parent = await card(pid, 'WORK', {}, 'STORY');
    const child = await card(pid, 'WORK', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(await statusOf(parent)).toBe('END');
  });

  it('a parent still follows its children through the steps before its review', async () => {
    const pid = await projectWith([s('START', 0, { isAnchor: true }), s('A', 1, { role: 'planning' }), s('B', 2, { role: 'planning' }), s('LOOK', 3, { role: 'review' }), s('END', 4, { isAnchor: true, role: 'closing' })]);
    const parent = await card(pid, 'A', {}, 'STORY');
    const child = await card(pid, 'A', { parentId: parent });
    expect((await validate(child)).status).toBe(200);
    expect(await statusOf(parent)).toBe('B');
  });
});
