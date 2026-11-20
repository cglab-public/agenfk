/**
 * GH-394, through the server: the board reads a project's usage on no card
 * from the local store (GET /usage/no-card), and the server queues that usage
 * for the hub as one usage.no-card total per project per local day - totals
 * only, never a turn.
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

const TEST_DB = testDbPath('usage-no-card-route-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, sendNoCardUsageNow } from '../server';
import { localDayOf } from '../usage/noCardUsage';

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => { await new Promise<void>(r => __server.close(() => r())); });
afterAll(async () => { await removeTestDb(TEST_DB, closeStorage); });

let n = 0;
const turn = (over: Partial<TokenEvent>): TokenEvent => ({
  id: `nc-${++n}`, ts: new Date().toISOString(), client: 'claude-code', sessionId: 'nc-session-77', model: 'claude-opus-5-5',
  input: 10, cachedInput: 150, cacheRead: 100, cacheWrite: 50, output: 20, reasoning: 0, total: 180,
  sourcePath: '/logs/nc-session-77.jsonl', sourceOffset: n, ...over,
});

describe('usage on no card', () => {
  let projectId: string;
  let otherId: string;
  beforeAll(async () => {
    projectId = (await agent().post('/projects').send({ name: 'no-card-usage' })).body.id;
    otherId = (await agent().post('/projects').send({ name: 'no-card-other' })).body.id;
    const card = (await agent().post('/items').send({ type: 'TASK', title: 'carded', projectId })).body.id;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await storage.insertTokenEvent(turn({ projectId }));
    await storage.insertTokenEvent(turn({ projectId, client: 'pi', model: 'qwen3.8:27b', costUsd: 0.5 }));
    await storage.insertTokenEvent(turn({ projectId, ts: yesterday }));
    await storage.insertTokenEvent(turn({ projectId, itemId: card }));
    await storage.insertTokenEvent(turn({ projectId: otherId, input: 999 }));
  });

  it('GET /usage/no-card gives the project its usage on no card, in total and per local day', async () => {
    const r = await agent().get('/usage/no-card').query({ projectId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.projectId).toBe(projectId);
    expect(r.body.total).toMatchObject({ turns: 3, input: 30, cacheRead: 300, cacheWrite: 150, output: 60, costUsd: 0.5 });
    expect(r.body.byModel.map((m: any) => `${m.client}/${m.model}`).sort()).toEqual(['claude-code/claude-opus-5-5', 'pi/qwen3.8:27b']);
    const today = localDayOf(new Date());
    expect(r.body.byDay.find((d: any) => d.day === today).total.turns).toBe(2);
    expect(r.body.byDay.map((d: any) => d.day)).toEqual([...r.body.byDay.map((d: any) => d.day)].sort());
  });

  it('GET /usage/no-card needs a project', async () => {
    expect((await agent().get('/usage/no-card')).status).toBe(400);
  });

  it('GET /usage/no-card counts only the days asked for', async () => {
    const r = await agent().get('/usage/no-card').query({ projectId, days: 1 });
    expect(r.status).toBe(200);
    expect(r.body.total.turns).toBe(2);
  });

  it('GET /usage/no-card refuses a day count that is not a whole number of days in range', async () => {
    for (const days of ['0', '-3', 'x', '1.5', '400']) {
      expect((await agent().get('/usage/no-card').query({ projectId, days })).status, days).toBe(400);
    }
  });

  it('queues one usage.no-card total per project per local day for the hub, with no turn in it', async () => {
    const queuedNoCard = () => ((storage as any)['database'].prepare('SELECT payload FROM hub_outbox').all() as { payload: string }[])
      .map(row => JSON.parse(row.payload)).filter(e => e.type === 'usage.no-card');
    const before = queuedNoCard().length;

    const sent = await sendNoCardUsageNow();

    const queued = queuedNoCard().slice(before);
    expect(sent).toBe(3);
    expect(queued).toHaveLength(3);
    const today = queued.find(e => e.projectId === projectId && e.payload.day === localDayOf(new Date()));
    expect(today.payload.usage.total).toMatchObject({ turns: 2, input: 20, costUsd: 0.5 });
    expect(today.itemId).toBeUndefined();
    const text = JSON.stringify(queued);
    expect(text).not.toContain('nc-session-77');
    expect(text).not.toContain('/logs/');

    expect(await sendNoCardUsageNow()).toBe(0);
  });
});
