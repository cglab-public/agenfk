/**
 * GH-389: when a card reaches the end of its flow, its usage - its own turns
 * and its descendants' - goes on the card (cardUsage), in the DONE reply and
 * on the item.closed hub event (payload.usage). A parent closed by the
 * roll-up carries its children's usage.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import type { TokenEvent } from '@agenfk/core';

vi.hoisted(() => {
  process.env.AGENFK_HUB_URL = process.env.AGENFK_HUB_URL || 'http://hub.test';
  process.env.AGENFK_HUB_TOKEN = process.env.AGENFK_HUB_TOKEN || 'test-token';
  process.env.AGENFK_HUB_ORG = process.env.AGENFK_HUB_ORG || 'test-org';
});
vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('usage-card-close-test-db.sqlite');
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

async function closedEvent(itemId: string, settleMs = 5000): Promise<any | undefined> {
  const db: any = (storage as any)['database'];
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const found = (db.prepare('SELECT payload FROM hub_outbox ORDER BY rowid').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).find(e => e.itemId === itemId && e.type === 'item.closed');
    if (found) return found;
    await new Promise(r => setTimeout(r, 25));
  }
  return undefined;
}

let seq = 0;
async function project() {
  const st = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ id: `${name}-${order}-${seq}`, name, label: name, order, ...extra });
  const f = await agent().post('/flows').send({ name: `usage-close-${++seq}`, steps: [st('TODO', 0, { isAnchor: true }), st('WORK', 1), st('DONE', 2, { isAnchor: true })] });
  const dir = echoRepo(A, 'agenfk-usage-close-');
  dirs.push(dir);
  const p = await agent().post('/projects').send({ name: `usage-close-${++seq}` });
  await storage.updateProject(p.body.id, { flowId: f.body.id, projectRoot: dir, verifyCommand: 'exit 0' } as never);
  return p.body.id as string;
}
const make = async (projectId: string, type: string, parentId?: string) => {
  const c = await agent().post('/items').send({ type, title: `${type}-${++seq}`, projectId, ...(parentId ? { parentId } : {}) });
  await storage.updateItem(c.body.id, { status: 'WORK' } as any);
  return c.body.id as string;
};
let off = 0;
const turn = (itemId: string, input: number) => storage.insertTokenEvent({
  id: `close-ev-${++off}`, ts: new Date().toISOString(), client: 'pi', sessionId: 'pi-s', model: 'qwen3.8',
  input, cachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, total: input + 1, costUsd: 0.25, itemId,
  sourcePath: '/p/pi.jsonl', sourceOffset: off,
} as TokenEvent);
const verify = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });

describe('card usage on close', () => {
  it('closing a card puts its usage on the card, in the reply and on item.closed', async () => {
    const id = await make(await project(), 'TASK');
    await turn(id, 40);
    await turn(id, 2);

    const res = await verify(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/Card usage: 2 turns/);

    const card = (await agent().get(`/items/${id}`)).body;
    expect(card.cardUsage.total).toMatchObject({ turns: 2, input: 42, costUsd: 0.5, unpricedTurns: 0 });
    expect(card.cardUsage.byStep).toEqual([{ step: 'WORK', total: expect.objectContaining({ turns: 2, input: 42 }) }]);

    const closed = await closedEvent(id);
    expect(closed.payload.usage.total).toMatchObject({ turns: 2, input: 42 });
    expect(closed.payload.usage.byStep[0].step).toBe('WORK');
  });

  it('a parent closed by the roll-up carries its children usage', async () => {
    const projectId = await project();
    const parent = await make(projectId, 'STORY');
    const child = await make(projectId, 'TASK', parent);
    await turn(child, 300);
    await turn(parent, 7);

    expect((await verify(child)).status).toBe(200);
    expect((await agent().get(`/items/${parent}`)).body.status).toBe('DONE');

    const closed = await closedEvent(parent);
    expect(closed.payload.usage.total).toMatchObject({ turns: 2, input: 307 });
    expect(closed.payload.usage.cards).toBe(2);
  });
});
