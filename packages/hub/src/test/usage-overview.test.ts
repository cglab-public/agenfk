/**
 * GH-389 follow-up: GET /v1/usage/overview, the org's AI usage over the board
 * filters, broken down by installation, by user, by harness/model and by PR.
 *
 * Tokens come from step.transitioned payload.usage: each step's own sessions,
 * so closed and in-flight cards both count and a parent never re-counts its
 * children (item.closed carries the card's whole subtree and is NOT summed).
 * A PR's usage is its anchor card's latest item.closed usage (card + subtree).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);
const totals = (input: number, output = 3, costUsd = 0, unpricedTurns = 1) =>
  ({ turns: 1, input, cacheRead: 10, cacheWrite: 5, output, reasoning: 0, costUsd, unpricedTurns });
const model = (client: string, name: string, input: number, costUsd = 0, unpricedTurns = 1) =>
  ({ client, model: name, ...totals(input, 3, costUsd, unpricedTurns) });
/** A step's usage, as step.transitioned carries it. */
const stepUsage = (...byModel: ReturnType<typeof model>[]) => {
  const total = byModel.reduce((t, m) => ({
    turns: t.turns + m.turns, input: t.input + m.input, cacheRead: t.cacheRead + m.cacheRead,
    cacheWrite: t.cacheWrite + m.cacheWrite, output: t.output + m.output, reasoning: t.reasoning + m.reasoning,
    costUsd: t.costUsd + m.costUsd, unpricedTurns: t.unpricedTurns + m.unpricedTurns,
  }), { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, unpricedTurns: 0 });
  return { byModel, total, enteredAt: '2026-11-19T09:00:00.000Z', leftAt: '2026-11-19T10:00:00.000Z', complete: true };
};
const opus = (input: number) => model('claude-code', 'claude-opus-5-5', input);
const qwen = (input: number, cost = 0.5) => model('pi', 'qwen3.8:27b', input, cost, 0);

const ALICE = { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@acme.com' };
const BOB = { osUser: 'bob', gitName: 'Bob', gitEmail: 'bob@acme.com' };

let n = 0;
const event = (over: any) => ({
  eventId: `ov-${++n}`,
  installationId: 'inst-a',
  orgId: 'org',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actor: ALICE,
  projectId: 'p1',
  remoteUrl: 'git@github.com:acme/api.git',
  itemType: 'TASK',
  ...over,
});
const step = (itemId: string, usage: unknown, over: any = {}) =>
  event({ type: 'step.transitioned', itemId, payload: { fromStatus: 'WORK', toStatus: 'REVIEW', ...(usage ? { usage } : {}) }, ...over });

describe('GET /v1/usage/overview', () => {
  let app: any;
  let db: HubDb;
  let cookie: string;
  let token: string;
  const post = async (events: any[]) => {
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
    expect(r.status).toBe(200);
  };
  // A row stored before ingest refused unparseable times (GH-391): ingest now
  // rejects one, so the old row is made by rewriting a stored event.
  const legacyTime = async (eventId: string, occurredAt: string) => {
    const r = await db.run(
      "UPDATE events SET occurred_at = ?, payload = json_set(payload, '$.occurredAt', ?) WHERE event_id = ?",
      [occurredAt, occurredAt, eventId],
    );
    expect(r.changes).toBe(1);
  };
  const overview = async (q = '') => {
    const r = await supertest(app).get(`/v1/usage/overview${q}`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    return r.body;
  };

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

  it('needs a signed-in board user', async () => {
    expect((await supertest(app).get('/v1/usage/overview')).status).toBe(401);
  });

  it('is empty, not an error, with no usage yet', async () => {
    const body = await overview();
    expect(body.total.input).toBe(0);
    expect(body.cards).toBe(0);
    expect(body.byInstallation).toEqual([]);
    expect(body.byUser).toEqual([]);
    expect(body.byModel).toEqual([]);
    expect(body.byPr).toEqual([]);
    expect(body.byDay).toEqual([]);
  });

  it('sums step usage of closed and in-flight cards, and never adds item.closed on top', async () => {
    await post([
      step('closed', stepUsage(opus(100))),
      event({ type: 'item.closed', itemId: 'closed', payload: { toStatus: 'DONE', usage: { ...stepUsage(opus(100)), byStep: [], cards: 1 } } }),
      step('open', stepUsage(opus(20))),
      step('open', stepUsage(opus(5)), { occurredAt: '2026-11-19T11:00:00.000Z' }),
    ]);
    const body = await overview();
    expect(body.total.input).toBe(125);
    expect(body.total.turns).toBe(3);
    expect(body.cards).toBe(2);
    expect(body.steps).toBe(3);
  });

  it('a step from a version that sent no usage is counted as unmeasured, not as zero usage', async () => {
    await post([step('old', null), step('new', stepUsage(opus(7)))]);
    const body = await overview();
    expect(body.unmeasuredSteps).toBe(1);
    expect(body.steps).toBe(1);
    expect(body.cards).toBe(1);
    expect(body.total.input).toBe(7);
  });

  it('a duplicate delivery of the same event is counted once', async () => {
    const e = step('c1', stepUsage(opus(9)));
    await post([e]);
    await post([e]);
    expect((await overview()).total.input).toBe(9);
  });

  it('merges models across events by client + model, keeping the reported cost', async () => {
    await post([
      step('c1', stepUsage(opus(10), qwen(1, 0.25))),
      step('c2', stepUsage(opus(30), qwen(2, 0.5))),
    ]);
    const byModel = (await overview()).byModel;
    expect(byModel).toEqual([
      expect.objectContaining({ client: 'claude-code', model: 'claude-opus-5-5', input: 40, turns: 2, unpricedTurns: 2, costUsd: 0 }),
      expect.objectContaining({ client: 'pi', model: 'qwen3.8:27b', input: 3, turns: 2, unpricedTurns: 0, costUsd: 0.75 }),
    ]);
  });

  it('breaks down by installation and by user, each with its own models, biggest first', async () => {
    await post([
      step('a1', stepUsage(opus(10))),
      step('a2', stepUsage(qwen(5))),
      step('b1', stepUsage(opus(300)), { installationId: 'inst-b', actor: BOB }),
    ]);
    const body = await overview();

    expect(body.byInstallation.map((r: any) => [r.installation_id, r.cards, r.total.input])).toEqual([
      ['inst-b', 1, 300],
      ['inst-a', 2, 15],
    ]);
    expect(body.byInstallation[1].byModel.map((m: any) => m.model)).toEqual(['claude-opus-5-5', 'qwen3.8:27b']);
    // The installation's identity, so the page can name it without the admin API.
    expect(body.byInstallation[0].label).toBe('Bob <bob@acme.com>');

    expect(body.byUser.map((r: any) => [r.user_key, r.cards, r.total.input])).toEqual([
      ['bob@acme.com', 1, 300],
      ['alice@acme.com', 2, 15],
    ]);
    expect(body.byUser[0].byModel).toEqual([expect.objectContaining({ client: 'claude-code', input: 300 })]);
  });

  describe('turns a step missed are recovered at close (item.closed usage.own)', () => {
    const close = (itemId: string, own: number | null, over: any = {}) => event({
      type: 'item.closed', itemId,
      payload: { toStatus: 'DONE', usage: { ...stepUsage(opus(own ?? 0)), byStep: [], cards: 2, ...(own === null ? {} : { own: stepUsage(opus(own)) }) } },
      occurredAt: '2026-11-19T12:00:00.000Z', ...over,
    });

    it("adds what the card's own close total has beyond its recorded steps, once", async () => {
      await post([step('c1', stepUsage(opus(10))), close('c1', 15)]);
      const body = await overview();
      expect(body.total.input).toBe(15);
      expect(body.byModel).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', input: 15 })]);
      expect(body.recoveredAtClose.input).toBe(5);
      expect(body.cards).toBe(1);
    });

    it('a card reopened and closed again is not recovered twice', async () => {
      await post([
        step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-19T10:00:00.000Z' }),
        close('c1', 15, { occurredAt: '2026-11-19T11:00:00.000Z' }),
        step('c1', stepUsage(opus(4)), { occurredAt: '2026-11-19T12:00:00.000Z' }),
        close('c1', 20, { occurredAt: '2026-11-19T13:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(20);
    });

    it('the closing step and its close at the same instant are not counted twice, whatever their event ids', async () => {
      await post([
        step('c1', stepUsage(opus(10)), { eventId: 'zz-step', occurredAt: '2026-11-19T12:00:00.000Z' }),
        close('c1', 10, { eventId: 'aa-close', occurredAt: '2026-11-19T12:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(10);
    });

    it('a close from a version that sent no own usage adds nothing (its total includes the children)', async () => {
      await post([step('c1', stepUsage(opus(10))), close('c1', null)]);
      expect((await overview()).total.input).toBe(10);
    });

    it('the recovered remainder counts when the close is in the window, against the steps of all time', async () => {
      await post([
        step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-01T10:00:00.000Z' }),
        close('c1', 15, { occurredAt: '2026-11-19T12:00:00.000Z' }),
      ]);
      expect((await overview('?from=2026-11-10')).total.input).toBe(5);
      expect((await overview('?to=2026-11-10')).total.input).toBe(10);
    });
  });

  describe('cumulative snapshots (usage.own on every step and close) reconcile per card', () => {
    const snap = (itemId: string, stepIn: number, ownIn: number, over: any = {}, extra: any = {}) => event({
      type: 'step.transitioned', itemId,
      payload: { fromStatus: 'WORK', toStatus: 'REVIEW', usage: { ...stepUsage(opus(stepIn)), own: stepUsage(opus(ownIn)) }, ...extra },
      ...over,
    });
    const closeOwn = (itemId: string, ownIn: number, over: any = {}) => event({
      type: 'item.closed', itemId,
      payload: { fromStatus: 'REVIEW', toStatus: 'DONE', usage: { ...stepUsage(opus(ownIn)), byStep: [], cards: 1, own: stepUsage(opus(ownIn)) } }, ...over,
    });

    it('a later snapshot picks up turns ingested after their step was counted', async () => {
      await post([
        snap('c1', 10, 10, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        snap('c1', 5, 18, { occurredAt: '2026-11-19T11:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(18);
    });

    it('a close stamped before its own closing step does not count that step twice, nor reads as a reopen', async () => {
      await post([
        closeOwn('s1', 100, { occurredAt: '2026-11-19T12:00:00.000Z' }),
        snap('s1', 100, 100, { occurredAt: '2026-11-19T12:00:00.001Z' }, { fromStatus: 'REVIEW', toStatus: 'DONE' }),
        event({ type: 'pr.opened', itemId: 's1', payload: { prNumber: 3, repo: 'acme/api' }, occurredAt: '2026-11-19T13:00:00.000Z' }),
      ]);
      const body = await overview();
      expect(body.total.input).toBe(100);
      expect(body.byPr[0].usage.total.input).toBe(100);
    });

    it('turns recovered at a close are not counted again by the step that reopens the card', async () => {
      await post([
        snap('c1', 10, 10, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        closeOwn('c1', 12, { occurredAt: '2026-11-19T11:00:00.000Z' }),
        // The reopening step's window overlaps the 2 late turns: it carries 5, of which 3 are new.
        snap('c1', 5, 15, { occurredAt: '2026-11-19T12:00:00.000Z' }, { fromStatus: 'DONE', toStatus: 'WORK' }),
        closeOwn('c1', 15, { occurredAt: '2026-11-19T13:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(15);
    });

    it('the total is always the sum of the model rows, even when a snapshot is lower for one model', async () => {
      await post([
        snap('c1', 100, 100, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        event({ type: 'step.transitioned', itemId: 'c1', occurredAt: '2026-11-19T11:00:00.000Z',
          payload: { usage: { ...stepUsage(qwen(20)), own: stepUsage(opus(90), qwen(20)) } } }),
      ]);
      const body = await overview();
      const sumOf = (k: string) => body.byModel.reduce((n: number, m: any) => n + m[k], 0);
      expect(body.total.input).toBe(sumOf('input'));
      expect(body.total.turns).toBe(sumOf('turns'));
      expect(body.total.input).toBe(120);
    });

    it("an older version's step (no snapshot) and a newer one's snapshot on one card are not double counted", async () => {
      await post([
        step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-19T10:00:00.000Z' }),
        snap('c1', 8, 18, { occurredAt: '2026-11-19T11:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(18);
    });

    it('after a database restored from a backup (the snapshot drops), later spend is credited again, once', async () => {
      await post([
        snap('c1', 100, 100, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        // Restored to a backup, then some spent: the hub cannot tell the backup's
        // point from the spend in this first snapshot after it, so it credits none of it...
        snap('c1', 10, 90, { occurredAt: '2026-11-19T11:00:00.000Z' }),
        // ...but every snapshot after it counts again: +5 here, not swallowed by the old high mark.
        snap('c1', 5, 95, { occurredAt: '2026-11-19T12:00:00.000Z' }),
        snap('c1', 20, 115, { occurredAt: '2026-11-19T13:00:00.000Z' }),
      ]);
      expect((await overview()).total.input).toBe(125);
    });

    it('orders a card by when each snapshot was read (own.asOf), so an older one emitted late is not a restore', async () => {
      const at = (input: number, asOf: string) => ({ ...stepUsage(opus(input)), asOf });
      const ev = (ownIn: number, asOf: string, occurredAt: string) => event({ type: 'step.transitioned', itemId: 'c1', occurredAt,
        payload: { usage: { ...stepUsage(opus(1)), own: at(ownIn, asOf) } } });
      await post([
        ev(110, '2026-11-19T10:00:02.000Z', '2026-11-19T10:00:03.000Z'),
        // A rollback read at 10:00:01 but emitted after the move above.
        ev(100, '2026-11-19T10:00:01.000Z', '2026-11-19T10:00:04.000Z'),
        ev(110, '2026-11-19T10:00:05.000Z', '2026-11-19T10:00:05.000Z'),
      ]);
      expect((await overview()).total.input).toBe(110);
      // Disjoint windows add up to the whole: an event emitted after a window
      // can still precede one inside it by read order.
      const early = (await overview('?to=2026-11-19T10%3A00%3A03.000Z')).total.input;
      const late = (await overview('?from=2026-11-19T10%3A00%3A04.000Z')).total.input;
      expect(early + late).toBe(110);
    });

    it('only the snapshots inside the window are credited, against the card history before it', async () => {
      await post([
        snap('c1', 10, 10, { occurredAt: '2026-11-01T10:00:00.000Z' }),
        snap('c1', 5, 15, { occurredAt: '2026-11-19T10:00:00.000Z' }),
      ]);
      expect((await overview('?from=2026-11-10')).total.input).toBe(5);
    });
  });

  describe('byDay: the timeline', () => {
    it('credits each event on its day, oldest first, with the models to price it', async () => {
      await post([
        step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-18T10:00:00.000Z' }),
        step('c2', stepUsage(opus(5), qwen(2, 0.5)), { occurredAt: '2026-11-19T10:00:00.000Z' }),
        step('c3', stepUsage(qwen(1, 0.25)), { occurredAt: '2026-11-19T11:00:00.000Z' }),
      ]);
      const days = (await overview()).byDay;
      expect(days.map((d: any) => [d.day, d.total.input, d.cards])).toEqual([['2026-11-18', 10, 1], ['2026-11-19', 8, 2]]);
      expect(days[1].byModel).toHaveLength(2);
      expect(days[1].byModel).toEqual(expect.arrayContaining([
        expect.objectContaining({ client: 'claude-code', input: 5 }),
        expect.objectContaining({ client: 'pi', input: 3, costUsd: 0.75 }),
      ]));
    });

    it("files an event under the viewer's day (tz)", async () => {
      await post([step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-19T02:00:00.000Z' })]);
      expect((await overview('?tz=America%2FSao_Paulo')).byDay.map((d: any) => d.day)).toEqual(['2026-11-18']);
      expect((await overview('?tzOffsetMin=-180')).byDay.map((d: any) => d.day)).toEqual(['2026-11-18']);
      expect((await overview()).byDay.map((d: any) => d.day)).toEqual(['2026-11-19']);
    });

    it('a late-turn credit at close lands on the close day, and the days add up to the total', async () => {
      await post([
        step('c1', stepUsage(opus(10)), { occurredAt: '2026-11-18T10:00:00.000Z' }),
        event({ type: 'item.closed', itemId: 'c1', occurredAt: '2026-11-19T10:00:00.000Z',
          payload: { toStatus: 'DONE', usage: { ...stepUsage(opus(15)), byStep: [], cards: 1, own: stepUsage(opus(15)) } } }),
      ]);
      const body = await overview();
      expect(body.byDay.map((d: any) => [d.day, d.total.input])).toEqual([['2026-11-18', 10], ['2026-11-19', 5]]);
      expect(body.byDay.reduce((n: number, d: any) => n + d.total.input, 0)).toBe(body.total.input);
    });
  });

  it('an event stored with a timestamp that does not parse is skipped and counted, not a failed request', async () => {
    await post([step('bad', stepUsage(opus(5)), { eventId: 'ov-bad' }), step('ok', stepUsage(opus(7)))]);
    await legacyTime('ov-bad', 'not-a-time');
    const r = await supertest(app).get('/v1/usage/overview').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.total.input).toBe(7);
    expect(r.body.malformedEvents).toBe(1);
  });

  it('counts the steps whose session logs could not be read in time', async () => {
    await post([step('c1', { ...stepUsage(opus(1)), complete: false }), step('c2', stepUsage(opus(1)))]);
    const body = await overview();
    expect(body.incompleteSteps).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.prsTruncated).toBe(false);
  });

  it('applies the board filters (time window, people, projects)', async () => {
    await post([
      step('early', stepUsage(opus(1)), { occurredAt: '2026-11-01T10:00:00.000Z' }),
      step('bob', stepUsage(opus(20)), { actor: BOB, installationId: 'inst-b' }),
      step('alice', stepUsage(opus(300))),
      step('web', stepUsage(opus(4000)), { remoteUrl: 'git@github.com:acme/web.git' }),
    ]);
    expect((await overview('?from=2026-11-10')).total.input).toBe(4320);
    expect((await overview('?from=2026-11-10&users=alice%40acme.com')).total.input).toBe(4300);
    expect((await overview('?projects=git%40github.com%3Aacme%2Fapi.git&from=2026-11-10')).total.input).toBe(320);
  });

  it('ignores a ?types= filter: the overview always reads step usage', async () => {
    await post([step('c1', stepUsage(opus(3)))]);
    expect((await overview('?types=item.closed')).total.input).toBe(3);
  });

  describe('usage on no card (GH-394)', () => {
    /** One installation's running total for a project and local day, as the server sends it. */
    const noCard = (day: string, asOf: string, usage: unknown, over: any = {}) =>
      event({ type: 'usage.no-card', itemType: undefined, occurredAt: `${day}T15:00:00.000Z`, payload: { day, asOf, usage }, ...over });
    const ncUsage = (input: number) => ({ byModel: [opus(input)], total: opus(input) });

    it('counts in the headline total and on its own, and stays out of every card breakdown', async () => {
      await post([
        step('c1', stepUsage(opus(100))),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40)),
      ]);
      const body = await overview();
      expect(body.total.input).toBe(140);
      expect(body.total.turns).toBe(2);
      expect(body.noCard.total).toMatchObject({ input: 40, turns: 1 });
      expect(body.noCard.byModel).toEqual([expect.objectContaining({ client: 'claude-code', model: 'claude-opus-5-5', input: 40 })]);
      expect(body.cards).toBe(1);
      expect(body.byInstallation.map((r: any) => r.total.input)).toEqual([100]);
      expect(body.byUser.map((r: any) => r.total.input)).toEqual([100]);
      expect(body.byModel.map((r: any) => r.input)).toEqual([100]);
      expect(body.noCard.byInstallation).toEqual([expect.objectContaining({ installation_id: 'inst-a', total: expect.objectContaining({ input: 40 }) })]);
      expect(body.noCard.byUser).toEqual([expect.objectContaining({ user_key: 'alice@acme.com', total: expect.objectContaining({ input: 40 }) })]);
    });

    it('a resend replaces the earlier total, whichever of the two arrives first', async () => {
      await post([noCard('2026-11-19', '2026-11-19T18:00:00.000Z', ncUsage(70), { occurredAt: '2026-11-19T17:30:00.000Z' })]);
      await post([noCard('2026-11-19', '2026-11-19T12:00:00.000Z', ncUsage(40), { occurredAt: '2026-11-19T11:30:00.000Z' })]);
      expect((await overview()).noCard.total.input).toBe(70);
      await post([noCard('2026-11-19', '2026-11-19T20:00:00.000Z', ncUsage(90), { occurredAt: '2026-11-19T19:30:00.000Z' })]);
      const body = await overview();
      expect(body.noCard.total.input).toBe(90);
      expect(body.total.input).toBe(90);
    });

    it('the same delivery twice is counted once', async () => {
      const e = noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40), { eventId: 'nc-dup' });
      await post([e]);
      await post([e]);
      expect((await overview()).noCard.total.input).toBe(40);
    });

    it('a total from a restored database (lower, but sent later) replaces the higher one instead of adding to it', async () => {
      await post([
        noCard('2026-11-19', '2026-11-19T12:00:00.000Z', ncUsage(80)),
        noCard('2026-11-19', '2026-11-19T13:00:00.000Z', ncUsage(30)),
      ]);
      expect((await overview()).noCard.total.input).toBe(30);
    });

    it('each installation, project and day is its own total, and they add up', async () => {
      await post([
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(50)),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(7), { projectId: 'p2', remoteUrl: 'git@github.com:acme/web.git' }),
        noCard('2026-11-18', '2026-11-18T16:00:00.000Z', ncUsage(3)),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(11), { installationId: 'inst-b', actor: BOB }),
      ]);
      const body = await overview();
      expect(body.noCard.total.input).toBe(71);
      expect(body.noCard.byDay.map((d: any) => [d.day, d.total.input])).toEqual([['2026-11-18', 3], ['2026-11-19', 68]]);
      expect(body.noCard.byInstallation.map((r: any) => [r.installation_id, r.total.input])).toEqual([['inst-a', 60], ['inst-b', 11]]);
    });

    it('files each total under the viewer\'s day', async () => {
      await post([noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(5), { occurredAt: '2026-11-19T01:00:00.000Z' })]);
      expect((await overview('?tz=America%2FSao_Paulo')).noCard.byDay.map((d: any) => d.day)).toEqual(['2026-11-18']);
    });

    it('the people and project filters apply to it, and an item-type filter leaves it out', async () => {
      await post([
        step('c1', stepUsage(opus(100))),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40)),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(11), { installationId: 'inst-b', actor: BOB }),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(7), { projectId: 'p2', remoteUrl: 'git@github.com:acme/web.git' }),
      ]);
      expect((await overview('?users=bob%40acme.com')).noCard.total.input).toBe(11);
      expect((await overview('?projects=git%40github.com%3Aacme%2Fweb.git')).noCard.total.input).toBe(7);
      // Even a total a client sent with an item type on it: no card is no item type.
      await post([noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(5), { projectId: 'p9', itemType: 'TASK' })]);
      const typed = await overview('?itemTypes=TASK');
      expect(typed.noCard.total.input).toBe(0);
      expect(typed.total.input).toBe(100);
    });

    it('follows the child-hub filter like the rest of the usage', async () => {
      await post([
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40), { eventId: 'nc-local' }),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(9), { eventId: 'nc-child', installationId: 'inst-c' }),
      ]);
      const r = await db.run('UPDATE events SET child_hub_id = ? WHERE event_id = ?', ['hub-child-1', 'nc-child']);
      expect(r.changes).toBe(1);
      expect((await overview('?childHubId=local')).noCard.total.input).toBe(40);
      expect((await overview('?childHubId=hub-child-1')).noCard.total.input).toBe(9);
      expect((await overview()).noCard.total.input).toBe(49);
    });

    it("reads the history of the picked installations' picked projects only, never a crossed pair", async () => {
      await post([
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40), { projectId: 'pa', remoteUrl: 'git@github.com:acme/a.git' }),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(9), { projectId: 'pb', remoteUrl: 'git@github.com:acme/b.git', installationId: 'inst-b', actor: BOB }),
        // The crossed pairs, the day before the window: near enough to be read if the pairs were crossed.
        noCard('2026-11-18', '2026-11-18T16:00:00.000Z', ncUsage(1), { projectId: 'pb', remoteUrl: 'git@github.com:acme/b.git' }),
        noCard('2026-11-18', '2026-11-18T16:00:00.000Z', ncUsage(2), { projectId: 'pa', remoteUrl: 'git@github.com:acme/a.git', installationId: 'inst-b', actor: BOB }),
      ]);
      const all = vi.spyOn(db, 'all');
      const body = await overview('?from=2026-11-19T00:00:00.000Z');
      const historyRows = (await Promise.all(all.mock.calls
        .map((c, i) => ({ sql: String(c[0]), result: all.mock.results[i].value }))
        .filter(c => /type = \? AND installation_id = \?/.test(c.sql))
        .map(c => c.result))).flat() as any[];
      all.mockRestore();
      expect(body.noCard.total.input).toBe(49);
      expect(historyRows.map(r => `${r.installation_id}/${r.project_id}`).sort()).toEqual(['inst-a/pa', 'inst-b/pb']);
    });

    it('is never a PR', async () => {
      await post([noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(40))]);
      expect((await overview()).byPr).toEqual([]);
    });

    it('a window credits a day\'s total by its latest send, so windows that do not overlap add up to the whole', async () => {
      await post([
        noCard('2026-11-19', '2026-11-19T10:00:00.000Z', ncUsage(10), { occurredAt: '2026-11-19T09:00:00.000Z' }),
        noCard('2026-11-19', '2026-11-19T21:00:00.000Z', ncUsage(30), { occurredAt: '2026-11-19T20:00:00.000Z' }),
      ]);
      const before = (await overview('?to=2026-11-19T12:00:00.000Z')).noCard.total.input;
      const after = (await overview('?from=2026-11-19T12:00:00.000Z')).noCard.total.input;
      expect([before, after]).toEqual([0, 30]);
      expect((await overview()).noCard.total.input).toBe(30);
    });

    it('a total with no day or no usage is skipped and counted as malformed, not a failed request', async () => {
      await post([
        event({ type: 'usage.no-card', itemType: undefined, payload: { asOf: '2026-11-19T16:00:00.000Z', usage: ncUsage(5) } }),
        event({ type: 'usage.no-card', itemType: undefined, payload: { day: '2026-11-19', asOf: '2026-11-19T16:00:00.000Z' } }),
        noCard('2026-11-19', '2026-11-19T16:00:00.000Z', ncUsage(4), { projectId: 'p3' }),
      ]);
      const body = await overview();
      expect(body.noCard.total.input).toBe(4);
      expect(body.malformedEvents).toBe(2);
    });

    it('is zero, with empty breakdowns, when nothing was sent', async () => {
      const body = await overview();
      expect(body.noCard.total.input).toBe(0);
      expect(body.noCard.byModel).toEqual([]);
      expect(body.noCard.byDay).toEqual([]);
    });
  });

  describe('byPr', () => {
    const pr = (type: 'pr.opened' | 'pr.updated', itemId: string, prNumber: number, over: any = {}) =>
      event({ type, itemId, itemType: 'STORY', itemTitle: `Story ${itemId}`, payload: { prNumber, repo: 'acme/api', sizing: { epic: 0, story: 1, task: 2, bug: 0 }, model: 'claude-opus-5-5', harness: 'claude-code' }, ...over });
    const closed = (itemId: string, input: number, over: any = {}) =>
      event({ type: 'item.closed', itemId, itemType: 'STORY', payload: { toStatus: 'DONE', usage: { ...stepUsage(opus(input)), byStep: [], cards: 3, complete: true } }, ...over });

    it("a PR's usage is its anchor card's latest close: the card and its subtree", async () => {
      await post([
        closed('s1', 50, { occurredAt: '2026-11-19T09:00:00.000Z' }),
        closed('s1', 80, { occurredAt: '2026-11-19T09:30:00.000Z' }),
        pr('pr.opened', 's1', 42),
      ]);
      const rows = (await overview()).byPr;
      expect(rows).toEqual([expect.objectContaining({
        repo: 'acme/api', pr_number: 42, item_id: 's1', item_title: 'Story s1',
        usage: expect.objectContaining({ cards: 3, total: expect.objectContaining({ input: 80 }) }),
      })]);
    });

    it('a PR opened and then updated is one row', async () => {
      await post([
        closed('s1', 5),
        pr('pr.opened', 's1', 7, { occurredAt: '2026-11-19T11:00:00.000Z' }),
        pr('pr.updated', 's1', 7, { occurredAt: '2026-11-19T12:00:00.000Z' }),
      ]);
      expect((await overview()).byPr).toHaveLength(1);
    });

    it('an anchor card closed after the PR opened still gives the PR its usage', async () => {
      await post([
        pr('pr.opened', 's1', 8, { occurredAt: '2026-11-19T08:00:00.000Z' }),
        closed('s1', 12, { occurredAt: '2026-11-19T09:00:00.000Z' }),
      ]);
      expect((await overview()).byPr[0].usage.total.input).toBe(12);
    });

    it('a PR whose anchor card is not closed yet has no usage (null), not a partial number', async () => {
      await post([step('s1', stepUsage(opus(99))), pr('pr.opened', 's1', 9)]);
      expect((await overview()).byPr).toEqual([expect.objectContaining({ pr_number: 9, item_id: 's1', usage: null })]);
    });

    it('newest PR first, and two repos with the same PR number stay apart', async () => {
      await post([
        closed('s1', 1), closed('s2', 2),
        pr('pr.opened', 's1', 5, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        event({ type: 'pr.opened', itemId: 's2', occurredAt: '2026-11-19T11:00:00.000Z', remoteUrl: 'git@github.com:acme/web.git',
          payload: { prNumber: 5, repo: 'acme/web' } }),
      ]);
      expect((await overview()).byPr.map((r: any) => [r.repo, r.pr_number, r.item_id])).toEqual([
        ['acme/web', 5, 's2'],
        ['acme/api', 5, 's1'],
      ]);
    });

    it('a PR whose anchor card was reopened after its close has no usage (null)', async () => {
      await post([
        closed('s1', 50, { occurredAt: '2026-11-19T09:00:00.000Z' }),
        step('s1', stepUsage(opus(1)), { occurredAt: '2026-11-19T09:30:00.000Z', payload: { fromStatus: 'DONE', toStatus: 'WORK', usage: stepUsage(opus(1)) } }),
        pr('pr.opened', 's1', 11),
      ]);
      expect((await overview()).byPr).toEqual([expect.objectContaining({ pr_number: 11, usage: null })]);
    });

    it("the PR's anchor is its latest registration, even when a filter hides that event", async () => {
      await post([
        closed('A', 1), closed('B', 2, { actor: BOB, installationId: 'inst-b' }),
        pr('pr.opened', 'A', 42, { occurredAt: '2026-11-19T10:00:00.000Z' }),
        pr('pr.updated', 'B', 42, { occurredAt: '2026-11-19T11:00:00.000Z', actor: BOB, installationId: 'inst-b' }),
      ]);
      const rows = (await overview('?users=alice%40acme.com')).byPr;
      expect(rows).toEqual([expect.objectContaining({ pr_number: 42, item_id: 'B', opened_at: '2026-11-19T10:00:00.000Z' })]);
      expect(rows[0].usage.total.input).toBe(2);
    });

    it('a PR registered from a fork and again from upstream is one PR, anchored by its latest registration', async () => {
      await post([
        closed('A', 1), closed('B', 2),
        pr('pr.opened', 'A', 77, { occurredAt: '2026-11-19T10:00:00.000Z', remoteUrl: 'git@github.com:alice/api.git' }),
        pr('pr.updated', 'B', 77, { occurredAt: '2026-11-19T11:00:00.000Z', remoteUrl: 'git@github.com:acme/api.git', actor: BOB, installationId: 'inst-b' }),
      ]);
      const rows = (await overview('?users=alice%40acme.com')).byPr;
      expect(rows).toEqual([expect.objectContaining({ pr_number: 77, item_id: 'B' })]);
    });

    it("a malformed close of a PR's anchor is skipped and counted, never a failed request or a lost valid close", async () => {
      await post([
        closed('s1', 9, { occurredAt: '2026-11-19T09:00:00.000Z' }),
        closed('s1', 1, { eventId: 'cl-bad' }),
        pr('pr.opened', 's1', 13),
      ]);
      await legacyTime('cl-bad', 'not-a-time');
      const r = await supertest(app).get('/v1/usage/overview').set('Cookie', cookie);
      expect(r.status).toBe(200);
      expect(r.body.byPr[0].usage.total.input).toBe(9);
      expect(r.body.malformedEvents).toBe(1);
    });

    it('two closes at the same instant: the later event id wins, the same on every database', async () => {
      await post([
        closed('s1', 1, { eventId: 'cl-a', occurredAt: '2026-11-19T09:00:00.000Z' }),
        closed('s1', 2, { eventId: 'cl-b', occurredAt: '2026-11-19T09:00:00.000Z' }),
        pr('pr.opened', 's1', 12),
      ]);
      const row = (await overview()).byPr[0];
      expect(row.usage.total.input).toBe(2);
      expect(row.closed_at).toBe('2026-11-19T09:00:00.000Z');
    });

    it('lists PRs opened in the window, under the people filter', async () => {
      await post([
        closed('old', 1), closed('bobs', 1),
        pr('pr.opened', 'old', 1, { occurredAt: '2026-10-01T10:00:00.000Z' }),
        pr('pr.opened', 'bobs', 2, { actor: BOB, installationId: 'inst-b' }),
        pr('pr.opened', 's1', 3),
      ]);
      const nums = async (q: string) => (await overview(q)).byPr.map((r: any) => r.pr_number).sort();
      expect(await nums('?from=2026-11-01')).toEqual([2, 3]);
      expect(await nums('?from=2026-11-01&users=alice%40acme.com')).toEqual([3]);
    });
  });
});
