/**
 * @file cb4ef070 — the item list leaves out step records.
 *
 * A capture record holds a whole run's per-test results, so one card carried
 * 1.8 MB and GET /items for one project returned 88 MB. Every verify emits
 * items_updated, every open board refetches the list, and the server
 * serialised tens of MB at a time - blocking every other request for seconds.
 * Nothing reads step records from the list (the gates, check-history and
 * warnings endpoints serve them), so the list leaves them out; GET /items/:id
 * still carries them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = path.resolve('./items-list-slim-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, storage } from '../server';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(() => { for (const s of ['', '-shm', '-wal']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });

const tests = Array.from({ length: 2000 }, (_, i) => ({ name: `t ${i}`, file: `f${i % 40}.test.js`, status: 'passed' }));
const capture = { step: 'WORK', kind: 'capture', at: '2026-09-28T10:00:00.000Z', available: true, exitCode: 0, tests };

async function heavyCard() {
  const p = await agent().post('/projects').send({ name: `slim-${Math.random().toString(36).slice(2)}` });
  const c = await agent().post('/items').send({ type: 'TASK', title: 'heavy', projectId: p.body.id });
  await storage.updateItem(c.body.id, { stepRecords: [capture], supersededRecords: [capture] } as any);
  return { pid: p.body.id as string, id: c.body.id as string };
}

describe('GET /items', () => {
  it('leaves out stepRecords and supersededRecords', async () => {
    const t = await heavyCard();
    const r = await agent().get(`/items?projectId=${t.pid}`);
    expect(r.status).toBe(200);
    const card = r.body.find((i: any) => i.id === t.id);
    expect(card).toBeTruthy();
    expect(card).not.toHaveProperty('stepRecords');
    expect(card).not.toHaveProperty('supersededRecords');
    expect(card.title).toBe('heavy');
  });

  it('stays small however many tests a card has run', async () => {
    const t = await heavyCard();
    const r = await agent().get(`/items?projectId=${t.pid}`);
    expect(JSON.stringify(r.body).length).toBeLessThan(20_000);
  });
});

describe('GET /items/:id', () => {
  // ec325925: the step records are opt-in on a single card too (?records=1).
  it('carries the step records, results included, when asked', async () => {
    const t = await heavyCard();
    const r = await agent().get(`/items/${t.id}?records=1`);
    expect(r.status).toBe(200);
    expect(r.body.stepRecords).toHaveLength(1);
    expect(r.body.stepRecords[0].tests).toHaveLength(2000);
  });
});
