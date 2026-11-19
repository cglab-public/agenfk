/**
 * GH-389: every state change of a card records the usage of the step it left
 * - on the card (usageByStep), in the verify reply, and on the step.transitioned
 * hub event (payload.usage). That covers verify and the rollback path (PUT).
 * Per-turn events never reach the hub, and storing the usage adds no hub event
 * of its own.
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

const TEST_DB = testDbPath('usage-step-transition-test-db.sqlite');
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

async function outbox(itemId: string, type: string, settleMs = 5000): Promise<any[]> {
  const db: any = (storage as any)['database'];
  const deadline = Date.now() + settleMs;
  let events: any[] = [];
  while (Date.now() < deadline) {
    events = (db.prepare('SELECT payload FROM hub_outbox ORDER BY rowid').all() as { payload: string }[])
      .map(r => JSON.parse(r.payload)).filter(e => e.itemId === itemId && e.type === type);
    if (events.length) return events;
    await new Promise(r => setTimeout(r, 25));
  }
  return events;
}

let seq = 0;
async function cardAt(status: string) {
  const dir = echoRepo(A, 'agenfk-usage-step-');
  dirs.push(dir);
  const p = await agent().post('/projects').send({ name: `usage-${++seq}` });
  await storage.updateProject(p.body.id, { projectRoot: dir, verifyCommand: 'exit 0' } as never);
  const c = await agent().post('/items').send({ type: 'TASK', title: `usage-${++seq}`, projectId: p.body.id });
  await storage.updateItem(c.body.id, { status } as any);
  return { id: c.body.id as string, projectId: p.body.id as string };
}

let off = 0;
async function turn(itemId: string | undefined, over: Partial<TokenEvent> = {}) {
  await storage.insertTokenEvent({
    id: `ev-${++off}`, ts: new Date().toISOString(), client: 'claude-code', sessionId: 'sess', model: 'claude-opus-5-5',
    input: 100, cachedInput: 1500, cacheRead: 1000, cacheWrite: 500, output: 40, reasoning: 0, total: 1640,
    ...(itemId ? { itemId } : {}), sourcePath: '/p/s.jsonl', sourceOffset: off, ...over,
  });
}
const validate = (id: string) => agent().post(`/items/${id}/validate`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ evidence: 'green' });

describe('usage of the step a card leaves', () => {
  it('a verify records the step usage on the card, in the reply and on step.transitioned', async () => {
    const c = await cardAt('IN_PROGRESS');
    await turn(c.id);
    await turn(c.id, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cachedInput: 7 });
    await turn('someone-else');

    const res = await validate(c.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const card = (await agent().get(`/items/${c.id}`)).body;
    expect(card.usageByStep).toHaveLength(1);
    expect(card.usageByStep[0]).toMatchObject({ step: 'IN_PROGRESS', to: 'REVIEW' });
    expect(card.usageByStep[0].total).toMatchObject({ turns: 2, input: 101, output: 42, cacheRead: 1003, cacheWrite: 504 });

    expect(res.body.message).toMatch(/Usage in IN_PROGRESS: 2 turns/);

    const [moved] = await outbox(c.id, 'step.transitioned');
    expect(moved.payload.usage.total).toMatchObject({ turns: 2, input: 101, output: 42 });
    expect(moved.payload.usage.byModel[0]).toMatchObject({ client: 'claude-code', model: 'claude-opus-5-5', turns: 2 });
  });

  it('a step with no recorded turns still records a zero row, so "measured nothing" is visible', async () => {
    const c = await cardAt('IN_PROGRESS');
    await validate(c.id);
    const card = (await agent().get(`/items/${c.id}`)).body;
    expect(card.usageByStep[0].total.turns).toBe(0);
  });

  it('a rollback through PUT records the usage of the step it leaves too', async () => {
    const c = await cardAt('REVIEW');
    await turn(c.id, { input: 9 });

    const res = await agent().put(`/items/${c.id}`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ status: 'IN_PROGRESS' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const card = (await agent().get(`/items/${c.id}`)).body;
    expect(card.usageByStep.at(-1)).toMatchObject({ step: 'REVIEW', to: 'IN_PROGRESS' });
    expect(card.usageByStep.at(-1).total.input).toBe(9);
    const moved = await outbox(c.id, 'step.transitioned');
    expect(moved.at(-1).payload.usage.total.input).toBe(9);
  });

  it('re-entering a step adds a new row, it never overwrites the earlier visit', async () => {
    const c = await cardAt('IN_PROGRESS');
    await turn(c.id, { input: 5 });
    await validate(c.id); // IN_PROGRESS -> REVIEW
    await agent().put(`/items/${c.id}`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ status: 'IN_PROGRESS' });
    await turn(c.id, { input: 6 });
    await validate(c.id); // IN_PROGRESS -> REVIEW again

    const rows = (await agent().get(`/items/${c.id}`)).body.usageByStep;
    expect(rows.map((r: any) => [r.step, r.total.input])).toEqual([['IN_PROGRESS', 5], ['REVIEW', 0], ['IN_PROGRESS', 6]]);
  });

  it('storing the usage sends the hub no item.updated, and never a per-turn event', async () => {
    const c = await cardAt('IN_PROGRESS');
    await turn(c.id);
    await validate(c.id);
    await outbox(c.id, 'step.transitioned');
    expect(await outbox(c.id, 'item.updated', 300)).toEqual([]);
    expect(await outbox(c.id, 'tokens.logged', 300)).toEqual([]);
  });

  it('a caller cannot write usage: PUT ignores usageByStep', async () => {
    const c = await cardAt('IN_PROGRESS');
    const forged = [{ step: 'IN_PROGRESS', to: 'REVIEW', enteredAt: 'a', leftAt: 'b', complete: true, byModel: [], total: { turns: 1 } }];
    await agent().put(`/items/${c.id}`).set({ 'x-agenfk-internal': VERIFY_TOKEN! }).send({ title: 'renamed', usageByStep: forged });
    const card = (await agent().get(`/items/${c.id}`)).body;
    expect(card.title).toBe('renamed');
    expect(card.usageByStep ?? []).toEqual([]);
  });
});

