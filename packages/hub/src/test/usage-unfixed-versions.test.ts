/**
 * GH-398: usage sent by agenfk versions without the subagent attribution fix
 * is unreliable, and the hub cannot tell which part of it was charged to the
 * wrong card. So:
 *
 * - From now on, the usage an event carries (step.transitioned and
 *   item.closed `payload.usage`, a usage.no-card total) is dropped at ingest
 *   when the batch's X-Agenfk-Version is older than the fix, or missing. The
 *   event itself is kept. Events a child hub forwards are judged by that
 *   child hub's version: a fixed child has already judged its own senders.
 * - Once, on upgrade, the usage already stored from such versions is cleared
 *   the same way, on SQLite and Postgres, keeping the events.
 *
 * Cleared usage reads as no usage: no notice, no new field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';
import type { HubDb } from '../db/types';
import {
  USAGE_FIXED_VERSION, usageTrustedFrom, clearUnfixedUsage, CLEAR_UNFIXED_USAGE_MIGRATION,
} from '../services/unfixedUsage';

const totals = { turns: 2, input: 100, cacheRead: 10, cacheWrite: 5, output: 7, reasoning: 0, costUsd: 0, unpricedTurns: 2 };
const usage = { byModel: [{ client: 'claude-code', model: 'claude-opus-5-5', ...totals }], total: totals, complete: true };
const ACTOR = { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@acme.com' };

let n = 0;
const ev = (type: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  eventId: `uv-${++n}`, installationId: 'inst-a', orgId: 'org', occurredAt: '2026-11-20T10:00:00.000Z',
  actor: ACTOR, projectId: 'p1', itemId: type === 'usage.no-card' ? undefined : 'card-1', itemType: 'TASK',
  type, payload, ...over,
});
const step = () => ev('step.transitioned', { fromStatus: 'WORK', toStatus: 'REVIEW', usage: { ...usage, own: usage } });
const closed = () => ev('item.closed', { fromStatus: 'REVIEW', toStatus: 'DONE', usage: { ...usage, own: usage } });
const noCard = () => ev('usage.no-card', { day: '2026-11-20', asOf: '2026-11-20T10:00:00.000Z', usage });

describe('which versions are trusted for usage', () => {
  it('trusts the fixed version and anything newer, nothing older, and no version at all', () => {
    expect(usageTrustedFrom(USAGE_FIXED_VERSION)).toBe(true);
    expect(usageTrustedFrom('v' + USAGE_FIXED_VERSION)).toBe(true);
    expect(usageTrustedFrom('2.1.0-beta.22')).toBe(true);
    expect(usageTrustedFrom('2.1.0')).toBe(true);
    expect(usageTrustedFrom('3.0.0')).toBe(true);
    expect(usageTrustedFrom('2.1.0-beta.20')).toBe(false);
    expect(usageTrustedFrom('2.1.0-beta.19')).toBe(false);
    expect(usageTrustedFrom('2.0.9')).toBe(false);
    expect(usageTrustedFrom(null)).toBe(false);
    expect(usageTrustedFrom('garbage')).toBe(false);
  });
});

describe('ingest drops usage from versions without the fix (GH-398)', () => {
  let app: any; let db: HubDb; let token: string; let cookie: string;

  const post = async (events: unknown[], version?: string) => {
    let req = supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`);
    if (version) req = req.set('X-Agenfk-Version', version);
    const r = await req.send({ events });
    expect(r.status).toBe(200);
    return r.body;
  };
  const payloadOf = async (eventId: string) =>
    JSON.parse((await db.get<{ payload: string }>('SELECT payload FROM events WHERE event_id = ?', [eventId]))!.payload).payload;

  beforeEach(async () => {
    db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: 'a'.repeat(64), sessionSecret: 's', defaultOrgId: 'org', db });
    app = out.app;
    await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
    cookie = (await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' })).headers['set-cookie']?.[0] ?? '';
    token = await issueApiKey(db, 'org', 'test');
  });
  afterEach(async () => { await drainApp(app); await db.close(); });

  it('keeps the events from an unfixed version but not their usage', async () => {
    const [s, c, nc] = [step(), closed(), noCard()];
    const r = await post([s, c, nc], '2.1.0-beta.20');
    expect(r.ingested).toBe(3);

    expect(await payloadOf(s.eventId)).toEqual({ fromStatus: 'WORK', toStatus: 'REVIEW' });
    expect(await payloadOf(c.eventId)).toEqual({ fromStatus: 'REVIEW', toStatus: 'DONE' });
    const kept = await payloadOf(nc.eventId);
    expect(kept.day).toBe('2026-11-20');
    expect(kept.usage).toEqual({ byModel: [] });
  });

  it('a batch with no version header is treated as unfixed', async () => {
    const s = step();
    await post([s]);
    expect((await payloadOf(s.eventId)).usage).toBeUndefined();
  });

  it('keeps the usage from the fixed version', async () => {
    const [s, nc] = [step(), noCard()];
    await post([s, nc], USAGE_FIXED_VERSION);
    expect((await payloadOf(s.eventId)).usage.total.input).toBe(100);
    expect((await payloadOf(nc.eventId)).usage.total.input).toBe(100);
  });

  it('the usage page shows nothing for an unfixed sender, as for a period with no usage', async () => {
    await post([step(), noCard()], '2.1.0-beta.19');
    const r = await supertest(app).get('/v1/usage/overview').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.total.input).toBe(0);
    expect(r.body.noCard.total.input).toBe(0);
    expect(r.body.malformedEvents ?? 0).toBe(0);
  });

  it('a forwarded event keeps its usage only from a child hub on the fixed version', async () => {
    const enroll = async (name: string, hubVersion: string) => {
      const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name, hubVersion } });
      expect(r.status).toBe(200);
      return r.body as { token: string; childHubId: string };
    };
    const forward = async (child: { token: string; childHubId: string }, e: any) => {
      const r = await supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${child.token}`)
        .send({ rows: [{ id: `outbox-${e.eventId}`, kind: 'event', payload: { childHubId: child.childHubId, identityPolicy: 'keep', event: { ...e, userKey: 'alice@acme.com' } } }] });
      expect(r.body).toMatchObject({ accepted: 1 });
      return `ch:${child.childHubId}:${e.eventId}`;
    };
    const oldChild = await enroll('old', '2.1.0-beta.20');
    const newChild = await enroll('new', USAGE_FIXED_VERSION);
    const fromOld = await forward(oldChild, step());
    const fromNew = await forward(newChild, step());
    expect((await payloadOf(fromOld)).usage).toBeUndefined();
    expect((await payloadOf(fromNew)).usage.total.input).toBe(100);
  });
});

for (const engine of ['sqlite', 'postgres'] as const) {
  describe(`clearUnfixedUsage on ${engine} (GH-398)`, () => {
    let db: HubDb;

    const insert = async (e: any, reportingVersion: string | null, childHubId: string | null = null) => {
      await db.run(
        `INSERT INTO events (event_id, org_id, installation_id, user_key, occurred_at, received_at, type, project_id, item_id, reporting_version, payload, child_hub_id)
         VALUES (?, 'org', 'inst-a', 'alice@acme.com', ?, ?, ?, 'p1', ?, ?, ?, ?)`,
        [e.eventId, e.occurredAt, e.occurredAt, e.type, e.itemId ?? null, reportingVersion, JSON.stringify(e), childHubId],
      );
      return e.eventId as string;
    };
    const payloadOf = async (eventId: string) =>
      JSON.parse((await db.get<{ payload: string }>('SELECT payload FROM events WHERE event_id = ?', [eventId]))!.payload).payload;
    const count = async () => Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events'))!.n);

    beforeEach(async () => {
      db = engine === 'sqlite' ? await openSqliteDb(':memory:') : await openPgMemDb();
    });
    afterEach(async () => { await db.close(); });

    it('clears the usage stored from unfixed versions, keeps the events and everything else', async () => {
      const oldStep = await insert(step(), '2.1.0-beta.19');
      const oldClose = await insert(closed(), '2.1.0-beta.20');
      const oldNoCard = await insert(noCard(), null);
      const forwarded = await insert(step(), null, 'child-1');
      const fixed = await insert(step(), USAGE_FIXED_VERSION);
      const other = await insert(ev('item.created', { title: 'x', usage: 'not usage' }), '2.1.0-beta.19');

      const r = await clearUnfixedUsage(db);

      expect(r).toEqual({ skipped: false, eventsCleared: 4 });
      expect(await count()).toBe(6);
      expect(await payloadOf(oldStep)).toEqual({ fromStatus: 'WORK', toStatus: 'REVIEW' });
      expect(await payloadOf(oldClose)).toEqual({ fromStatus: 'REVIEW', toStatus: 'DONE' });
      expect((await payloadOf(oldNoCard)).usage).toEqual({ byModel: [] });
      expect((await payloadOf(oldNoCard)).day).toBe('2026-11-20');
      expect((await payloadOf(forwarded)).usage).toBeUndefined();
      expect((await payloadOf(fixed)).usage.total.input).toBe(100);
      expect((await payloadOf(other)).usage).toBe('not usage');
    });

    it('runs once: a second call is skipped until forced, and a forced run finds nothing left', async () => {
      await insert(step(), '2.1.0-beta.19');
      expect(await clearUnfixedUsage(db)).toEqual({ skipped: false, eventsCleared: 1 });
      expect(await db.get('SELECT value FROM system_state WHERE key = ?', [CLEAR_UNFIXED_USAGE_MIGRATION])).toBeTruthy();
      expect(await clearUnfixedUsage(db)).toEqual({ skipped: true, eventsCleared: 0 });
      expect(await clearUnfixedUsage(db, { force: true })).toEqual({ skipped: false, eventsCleared: 0 });
    });

    it('clears the usage of events from unfixed versions still queued for a parent hub', async () => {
      const queue = async (e: any) => {
        await db.run(
          `INSERT INTO federation_outbox (id, kind, payload, created_at, attempts, next_attempt_at) VALUES (?, 'event', ?, ?, 0, ?)`,
          [`q-${e.eventId}`, JSON.stringify({ childHubId: 'me', identityPolicy: 'keep', event: e }), e.occurredAt, e.occurredAt],
        );
      };
      const queuedOf = async (eventId: string) =>
        JSON.parse((await db.get<{ payload: string }>('SELECT payload FROM federation_outbox WHERE id = ?', [`q-${eventId}`]))!.payload).event.payload;
      const old = step(); const fixed = step();
      await insert(old, '2.1.0-beta.20'); await queue(old);
      await insert(fixed, USAGE_FIXED_VERSION); await queue(fixed);

      await clearUnfixedUsage(db);

      expect((await queuedOf(old.eventId)).usage).toBeUndefined();
      expect((await queuedOf(fixed.eventId)).usage.total.input).toBe(100);
    });

    it('pages through a history longer than one page', async () => {
      for (let i = 0; i < 7; i++) await insert(step(), '2.1.0-beta.20');
      expect(await clearUnfixedUsage(db, { pageSize: 3 })).toEqual({ skipped: false, eventsCleared: 7 });
    });
  });
}

describe('the hub clears unfixed usage by itself on boot (GH-398)', () => {
  it('marks the migration done on a fresh hub', async () => {
    const db = await openSqliteDb(':memory:');
    const out = await createHubApp({ dbPath: ':memory:', secretKey: 'a'.repeat(64), sessionSecret: 's', defaultOrgId: 'org', db });
    try {
      const deadline = Date.now() + 5000;
      let marked: unknown = null;
      while (!marked && Date.now() < deadline) {
        marked = await db.get('SELECT value FROM system_state WHERE key = ?', [CLEAR_UNFIXED_USAGE_MIGRATION]);
        if (!marked) await new Promise((r) => setTimeout(r, 20));
      }
      expect(marked).toBeTruthy();
    } finally {
      await drainApp(out.app);
      await db.close();
    }
  });
});
