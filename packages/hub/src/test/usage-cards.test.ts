/**
 * GH-389: the hub receives a card's token usage only on its workflow events -
 * the usage of each step on step.transitioned, the card's whole usage on
 * item.closed (payload.usage) - never per turn (tokens.logged stays dropped,
 * BUG 9c27faf6). GET /v1/usage/cards reads the closed cards with their usage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import { USAGE_FIXED_VERSION } from '../services/unfixedUsage';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
const totals = (input: number, turns = 1) => ({ turns, input, cacheRead: 10, cacheWrite: 5, output: 3, reasoning: 0, costUsd: 0, unpricedTurns: turns });
export const usage = (input: number) => ({
  byModel: [{ client: 'claude-code', model: 'claude-opus-5-5', ...totals(input) }],
  total: totals(input),
  byStep: [{ step: 'WORK', total: totals(input) }],
  cards: 1,
});

let n = 0;
export const event = (over: any) => ({
  eventId: `u-${++n}`,
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
  projectId: 'p1',
  remoteUrl: 'git@github.com:acme/api.git',
  itemType: 'TASK',
  ...over,
});

describe('usage on hub events', () => {
  let app: any;
  let db: HubDb;
  let cookie: string;
  let token: string;
  const post = (events: any[]) => supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).set('X-Agenfk-Version', USAGE_FIXED_VERSION).send({ events });
  const get = (p: string) => supertest(app).get(p).set('Cookie', cookie);

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: SECRET, sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(out.ctx.db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    cookie = login.headers['set-cookie']?.[0] ?? '';
    token = await issueApiKey(out.ctx.db, 'org', 'test');
  });
  afterEach(async () => { await drainApp(app); await db.close(); });

  it('keeps payload.usage on step.transitioned and item.closed', async () => {
    const step = { ...usage(40), step: undefined };
    await post([
      event({ type: 'step.transitioned', itemId: 'c1', payload: { fromStatus: 'WORK', toStatus: 'DONE', usage: step } }),
      event({ type: 'item.closed', itemId: 'c1', payload: { fromStatus: 'WORK', toStatus: 'DONE', usage: usage(40) } }),
    ]);
    const r = await get('/v1/timeline');
    const byType = Object.fromEntries(r.body.events.map((e: any) => [e.type, e.payload.payload.usage]));
    expect(byType['step.transitioned'].total.input).toBe(40);
    expect(byType['item.closed'].total.input).toBe(40);
  });

  it('still drops per-turn tokens.logged events', async () => {
    await post([event({ type: 'tokens.logged', itemId: 'c1', payload: { input: 1, output: 1 } })]);
    expect((await get('/v1/timeline')).body.events).toEqual([]);
  });

  describe('GET /v1/usage/cards', () => {
    it('lists each closed card with its usage', async () => {
      await post([
        event({ type: 'item.closed', itemId: 'c1', itemTitle: 'First', payload: { toStatus: 'DONE', usage: usage(40) } }),
        event({ type: 'item.closed', itemId: 'c2', itemTitle: 'Second', itemType: 'STORY', occurredAt: '2026-11-19T11:00:00.000Z', payload: { toStatus: 'DONE', usage: { ...usage(7), cards: 3 } } }),
        event({ type: 'step.transitioned', itemId: 'c3', payload: { toStatus: 'REVIEW', usage: usage(99) } }),
      ]);

      const r = await get('/v1/usage/cards');

      expect(r.status).toBe(200);
      expect(r.body.cards).toEqual([
        expect.objectContaining({ item_id: 'c2', item_title: 'Second', item_type: 'STORY', closed_at: '2026-11-19T11:00:00.000Z', usage: expect.objectContaining({ cards: 3, total: totals(7) }) }),
        expect.objectContaining({ item_id: 'c1', item_title: 'First', item_type: 'TASK', usage: expect.objectContaining({ total: totals(40) }) }),
      ]);
    });

    it('a card closed again (reopened, then closed) shows its latest close only', async () => {
      await post([
        event({ type: 'item.closed', itemId: 'c1', occurredAt: '2026-11-19T10:00:00.000Z', payload: { usage: usage(1) } }),
        event({ type: 'item.closed', itemId: 'c1', occurredAt: '2026-11-19T12:00:00.000Z', payload: { usage: usage(2) } }),
      ]);
      const cards = (await get('/v1/usage/cards')).body.cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].usage.total.input).toBe(2);
    });

    it('a card closed by a version that did not send usage is listed with no usage, not zero', async () => {
      await post([event({ type: 'item.closed', itemId: 'old', payload: { toStatus: 'DONE' } })]);
      expect((await get('/v1/usage/cards')).body.cards).toEqual([expect.objectContaining({ item_id: 'old', usage: null })]);
    });

    it('applies the board filters (time, people)', async () => {
      await post([
        event({ type: 'item.closed', itemId: 'early', occurredAt: '2026-11-01T10:00:00.000Z', payload: { usage: usage(1) } }),
        event({ type: 'item.closed', itemId: 'bob', actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@acme.com' }, payload: { usage: usage(1) } }),
        event({ type: 'item.closed', itemId: 'alice', payload: { usage: usage(1) } }),
      ]);
      const ids = async (q: string) => (await get(`/v1/usage/cards${q}`)).body.cards.map((c: any) => c.item_id).sort();
      expect(await ids('?from=2026-11-10')).toEqual(['alice', 'bob']);
      expect(await ids('?users=alice%40acme.com&from=2026-11-10')).toEqual(['alice']);
    });

    it('needs a signed-in board user', async () => {
      expect((await supertest(app).get('/v1/usage/cards')).status).toBe(401);
    });
  });
});
