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

  it("a closing move's step and close carry ONE own snapshot, even when a turn is ingested between their reads", async () => {
    const id = await make(await project(), 'TASK');
    await turn(id, 100);
    // Ingestion advances between the move's reads of the card's turns: the
    // hub would see the close's snapshot below the step's and read a restore.
    const real = storage.queryTokenEvents.bind(storage);
    let reads = 0;
    const spy = vi.spyOn(storage, 'queryTokenEvents').mockImplementation(async (q: any) => {
      const out = await real(q);
      if (q?.itemId === id && ++reads === 2) await turn(id, 10);
      return out;
    });
    try {
      expect((await verify(id)).status).toBe(200);
    } finally { spy.mockRestore(); }

    const closed = await closedEvent(id);
    const db: any = (storage as any)['database'];
    const step = (db.prepare('SELECT payload FROM hub_outbox ORDER BY rowid').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(e => e.itemId === id && e.type === 'step.transitioned').at(-1);
    expect(step.payload.usage.own).toEqual(closed.payload.usage.own);
    // When it was read: the hub orders a card's snapshots by this, not by when
    // their events were emitted (a slow route can emit an older one later).
    expect(Number.isFinite(Date.parse(closed.payload.usage.own.asOf))).toBe(true);
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

  it('the usage is saved in the SAME write as the move, never before or after it (review findings)', async () => {
    const id = await make(await project(), 'TASK');
    await turn(id, 5);
    const writes: string[][] = [];
    // Every item write: the locked path, and the one underneath it that a move takes while holding the lock.
    const spies = (['updateItem', 'updateItemUnlocked'] as const).map((m) => {
      const real = (storage as any)[m].bind(storage);
      return vi.spyOn(storage as any, m).mockImplementation(async (itemId: any, updates: any) => {
        if (itemId === id) writes.push(Object.keys(updates));
        return real(itemId, updates);
      });
    });
    try {
      expect((await verify(id)).status).toBe(200);
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
    const moves = writes.filter((k) => k.includes('status'));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual(expect.arrayContaining(['usageByStep', 'cardUsage']));
    expect(writes.filter((k) => k.includes('usageByStep') || k.includes('cardUsage'))).toHaveLength(1);
  });

  it('a verify whose card moved while its usage was being computed is refused, and stores no usage', async () => {
    const id = await make(await project(), 'TASK');
    await turn(id, 5);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const inside = new Promise<void>((r) => { reached = r; });
    let held = false;
    const real = storage.sessionsForItem.bind(storage);
    const spy = vi.spyOn(storage, 'sessionsForItem').mockImplementation(async (itemId: string) => {
      // Hold the verify's computation only; the rollback's own goes through.
      if (itemId === id && !held) { held = true; reached(); await gate; }
      return real(itemId);
    });
    try {
      // .then() sends it: a supertest request is lazy.
      const pending = verify(id).then((r) => r);
      await inside;
      // Meanwhile, a person drags the card back on the board.
      const back = await agent().put(`/items/${id}`).set({ 'x-agenfk-ui': '1' }).send({ status: 'TODO' });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      release();
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    } finally {
      release();
      spy.mockRestore();
    }
    const card = (await agent().get(`/items/${id}`)).body;
    expect(card.status).toBe('TODO');
    expect(card.cardUsage ?? null).toBeNull();
    expect((card.usageByStep ?? []).map((r: any) => r.to)).toEqual(['TODO']);
  });

  it('a parent roll-up whose children changed while its usage was computed does not close the parent', async () => {
    const projectId = await project();
    const parent = await make(projectId, 'STORY');
    const a = await make(projectId, 'TASK', parent);
    const b = await make(projectId, 'TASK', parent);
    expect((await verify(b)).status).toBe(200); // b DONE; a still open, so the parent stays
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const inside = new Promise<void>((r) => { reached = r; });
    let held = false;
    const real = storage.sessionsForItem.bind(storage);
    const spy = vi.spyOn(storage, 'sessionsForItem').mockImplementation(async (itemId: string) => {
      if (itemId === parent && !held) { held = true; reached(); await gate; }
      return real(itemId);
    });
    try {
      const closingA = verify(a).then((r) => r); // a DONE -> the roll-up starts closing the parent
      await inside;
      // Meanwhile, b is reopened.
      const back = await agent().put(`/items/${b}`).set({ 'x-agenfk-ui': '1' }).send({ status: 'WORK' });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      release();
      expect((await closingA).status).toBe(200);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await agent().get(`/items/${parent}`)).body.status).not.toBe('DONE');
  });

  it('the close total names the step it was taken in, so a reopened card can tell it is stale', async () => {
    const id = await make(await project(), 'TASK');
    await turn(id, 5);
    expect((await verify(id)).status).toBe(200);
    expect((await agent().get(`/items/${id}`)).body.cardUsage.atStatus).toBe('DONE');

    const back = await agent().put(`/items/${id}`).set({ 'x-agenfk-ui': '1' }).send({ status: 'WORK' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const card = (await agent().get(`/items/${id}`)).body;
    expect(card.status).toBe('WORK');
    expect(card.cardUsage.atStatus).not.toBe(card.status);
    // The rollback recorded the DONE stay it left, with the move itself.
    expect(card.usageByStep.at(-1)).toMatchObject({ step: 'DONE', to: 'WORK' });
  });
});
