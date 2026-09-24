/**
 * Hub closure events, pinned by behaviour (BUG dfb85b2f).
 *
 * The hub rolls up closed items from `step.transitioned` events whose
 * `payload.toStatus` is DONE (packages/hub/src/rollup.ts), and the hub UI
 * filters closures by the separate `item.closed` event. A card is closed by
 * validate_progress, never by PUT: since CGLAB-377 PUT /items/:id refuses
 * every route into DONE, so it must emit neither.
 *
 * This file used to count occurrences of `type: 'item.closed'` in server.ts,
 * which kept an unreachable PUT branch alive only because deleting it lowered
 * the count. It now drives the real routes and reads hub_outbox.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});
vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./hub-validate-step-transition-test-db.sqlite');
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

/** recordHubEvent enqueues without being awaited by the route, so poll. */
async function outboxFor(itemId: string, settleMs = 1500): Promise<any[]> {
  const db: any = (storage as any)['database'];
  const deadline = Date.now() + settleMs;
  let events: any[] = [];
  while (Date.now() < deadline) {
    events = (db.prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(e => e.itemId === itemId);
    if (events.some(e => e.type === 'item.closed')) return events;
    await new Promise(r => setTimeout(r, 25));
  }
  return events;
}

let seq = 0;
async function cardAt(status: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hub-close-'));
  dirs.push(dir);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t && echo a > a && git add . && git commit -qm one', { cwd: dir, shell: '/bin/sh' });
  const p = await agent().post('/projects').send({ name: `close-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: dir, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `close-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return c.body.id as string;
}

describe('closing a card emits the hub closure events', () => {
  it('validate landing DONE emits step.transitioned with toStatus DONE, and item.closed', async () => {
    const id = await cardAt('TEST');
    const res = await agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('DONE');

    const events = await outboxFor(id);
    const transitioned = events.find(e => e.type === 'step.transitioned' && e.payload?.toStatus === 'DONE');
    expect(transitioned, JSON.stringify(events.map(e => e.type))).toBeDefined();
    const closed = events.find(e => e.type === 'item.closed');
    expect(closed).toBeDefined();
    expect(closed.payload).toMatchObject({ fromStatus: 'TEST', toStatus: 'DONE', itemType: 'TASK' });
  });

  it('PUT cannot land DONE, so it emits no item.closed', async () => {
    const id = await cardAt('TEST');
    const res = await agent().put(`/items/${id}`).send({ status: 'DONE' });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/verify/);
    expect((await agent().get(`/items/${id}`)).body.status).toBe('TEST');
    expect((await outboxFor(id, 300)).some(e => e.type === 'item.closed')).toBe(false);
  });
});
