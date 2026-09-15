// Dual-backend parity for hub federation (CGLAB-181): the same enrollment
// scenario as federation-enroll.test.ts, run on the pg-mem backend so the new
// DDL and every runtime statement pass through the dialect translator.
import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
import { writeParentBinding } from '../services/federation/parentBinding';
import { enqueueOutbox, outboxDepth, federationTick } from '../services/federation/federationSync';
import { recomputeRollups } from '../rollup';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

async function bootHubOnPg(): Promise<{ app: any; db: HubDb; cookie: string }> {
  const db = await openPgMemDb();
  const out = await createHubApp({
    dbPath: '/tmp/unused-federation-pg-parity.sqlite',
    secretKey: SECRET,
    sessionSecret: 'sess-secret',
    defaultOrgId: 'org',
    db,
  });
  await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
  const login = await supertest(out.app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
  return { app: out.app, db, cookie: login.headers['set-cookie']?.[0] ?? '' };
}

describe('PG parity: hub federation enrollment (CGLAB-181)', () => {
  it('boots with child_hubs + federation_keys and runs invite → enroll → ping → directives', async () => {
    const { app, db, cookie } = await bootHubOnPg();

    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    expect(inv.status).toBe(200);

    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child', hubVersion: '1.1.19' },
    });
    expect(enr.status).toBe(200);
    expect(enr.body.token).toMatch(/^fed_/);

    const row = await db.get<any>('SELECT * FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(row.name).toBe('pg-child');
    expect(row.detached_at).toBeNull();

    const ping = await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ hubVersion: '1.2.0' });
    expect(ping.status).toBe(200);
    const after = await db.get<any>('SELECT hub_version FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(after.hub_version).toBe('1.2.0');

    // A malformed version sends NULL into COALESCE(?, hub_version). That
    // untyped-parameter shape is exactly what the dialect translator has to
    // get right, and the SQLite test alone never exercises it here.
    const junk = await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ hubVersion: 'not-a-version' });
    expect(junk.status).toBe(200);
    const kept = await db.get<any>('SELECT hub_version FROM child_hubs WHERE id = ?', [enr.body.childHubId]);
    expect(kept.hub_version).toBe('1.2.0');

    const dir = await supertest(app).get('/v1/federation/directives').set('Authorization', `Bearer ${enr.body.token}`);
    expect(dir.status).toBe(204);

    // single-use invite on PG too
    const again = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name: 'x' } });
    expect(again.status).toBe(400);

    // principal separation on PG
    const inst = await issueApiKey(db, 'org', 'inst');
    expect((await supertest(app).post('/v1/federation/ping').set('Authorization', `Bearer ${inst}`).send({})).status).toBe(401);
    expect((await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${enr.body.token}`)).status).toBe(401);

    await db.close();
  });
});

describe('PG parity: child-hub administration (CGLAB-181)', () => {
  it('lists, renames and detaches a child hub, with Date-shaped timestamps normalised', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child', hubVersion: '1.1.19' },
    });
    expect(enr.status).toBe(200);

    // Postgres hands back Date objects where SQLite hands back strings, and
    // the list both serialises those and derives `live` from them — the one
    // place this route can differ between backends.
    const list = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.isParent).toBe(true);
    expect(list.body.childHubs).toHaveLength(1);
    const row = list.body.childHubs[0];
    expect(row).toMatchObject({ name: 'pg-child', hubVersion: '1.1.19', detached: false, live: true });
    expect(typeof row.lastSeen).toBe('string');
    expect(new Date(row.lastSeen).toISOString()).toBe(row.lastSeen);
    expect(JSON.stringify(list.body)).not.toMatch(/fed_/);

    const renamed = await supertest(app).put(`/v1/admin/child-hubs/${enr.body.childHubId}`)
      .set('Cookie', cookie).send({ name: '  pg-renamed  ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('pg-renamed');

    const det = await supertest(app).post(`/v1/admin/child-hubs/${enr.body.childHubId}/detach`)
      .set('Cookie', cookie).send({});
    expect(det.status).toBe(200);
    expect(det.body.revokedKeys).toBe(1);
    expect(typeof det.body.detachedAt).toBe('string');

    // enforcement reaches the child on PG too
    expect((await supertest(app).post('/v1/federation/ping')
      .set('Authorization', `Bearer ${enr.body.token}`).send({})).status).toBe(401);

    // detached is hidden by default, visible and flagged on request
    expect((await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie)).body.childHubs).toEqual([]);
    const all = await supertest(app).get('/v1/admin/child-hubs?includeDetached=1').set('Cookie', cookie);
    expect(all.body.childHubs[0]).toMatchObject({ detached: true, live: false });
    expect(all.body.isParent).toBe(true);

    // re-detaching is idempotent on PG as well
    const again = await supertest(app).post(`/v1/admin/child-hubs/${enr.body.childHubId}/detach`)
      .set('Cookie', cookie).send({});
    expect(again.body.revokedKeys).toBe(0);
    expect(again.body.detachedAt).toBe(det.body.detachedAt);

    await db.close();
  });
});

describe('PG parity: child-side federation outbox (CGLAB-181)', () => {
  it('queues, orders, retries and drains on Postgres', async () => {
    const db = await openPgMemDb();
    const SEC = 'a'.repeat(64);
    await writeParentBinding(db, SEC, {
      parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1',
    });

    // BIGSERIAL rather than MAX(seq)+1 is the whole point: two connections in
    // the pool would otherwise read the same maximum and collide.
    for (const n of [1, 2, 3]) expect(await enqueueOutbox(db, 'event', { n })).toBe(true);
    expect(await outboxDepth(db)).toBe(3);

    const seen: any[] = [];
    const failing = {
      ping: async () => ({ ok: true }),
      directives: async () => null,
      deliver: async () => { throw Object.assign(new Error('nope'), { response: { status: 503 } }); },
    };
    const retried = await federationTick({ db, secretKey: SEC, transport: failing as any });
    expect(retried.ok).toBe(false);
    expect(await outboxDepth(db)).toBe(3);
    // ISO string into TIMESTAMPTZ, then compared with <= on the way back out
    const row = await db.get<any>('SELECT attempts, next_attempt_at FROM federation_outbox ORDER BY seq ASC');
    expect(Number(row.attempts)).toBe(1);

    const notYet = await federationTick({ db, secretKey: SEC, transport: { ...failing, deliver: async (r: any[]) => { seen.push(...r); return {}; } } as any });
    expect(notYet.delivered).toBe(0);
    expect(seen).toHaveLength(0);

    await db.run("UPDATE federation_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
    const drained = await federationTick({
      db, secretKey: SEC,
      transport: { ...failing, deliver: async (r: any[]) => { seen.push(...r); return {}; } } as any,
    });
    expect(drained.delivered).toBe(3);
    expect(seen.map((r: any) => r.payload.n)).toEqual([1, 2, 3]);
    expect(await outboxDepth(db)).toBe(0);

    await db.close();
  });
});

describe('PG parity: release requests (CGLAB-181)', () => {
  it('records a request, keeps the original timestamp, and surfaces it on the roster', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
    const enr = await supertest(app).post('/v1/federation/enroll').send({
      inviteToken: inv.body.inviteToken, childHub: { name: 'pg-child' },
    });
    expect(enr.status).toBe(200);

    // An untyped NULL into release_reason TEXT and an ISO string into
    // COALESCE(release_requested_at, $1) against TIMESTAMPTZ — exactly the
    // parameter shapes this file exists to catch.
    const first = await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({});
    expect(first.status).toBe(200);

    const MARKER = '2020-01-01T00:00:00.000Z';
    await db.run('UPDATE child_hubs SET release_requested_at = ? WHERE id = ?', [MARKER, enr.body.childHubId]);
    const second = await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({ reason: 'splitting off' });
    expect(second.status).toBe(200);

    const list = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    const row = list.body.childHubs[0];
    expect(row).toMatchObject({ releaseRequested: true, releaseReason: 'splitting off' });
    // Date-shaped on real pg, string on pg-mem; the DTO must emit one shape
    expect(new Date(row.releaseRequestedAt).toISOString()).toBe(MARKER);

    // re-asking with no reason must not erase the sentence the admin is reading
    await supertest(app).post('/v1/federation/release-request')
      .set('Authorization', `Bearer ${enr.body.token}`).send({});
    const after = await supertest(app).get('/v1/admin/child-hubs').set('Cookie', cookie);
    expect(after.body.childHubs[0].releaseReason).toBe('splitting off');

    await db.close();
  });
});

describe('PG parity: parent-side ingest of forwarded events (CGLAB-184)', () => {
  it('stores, deduplicates and rolls up per child hub on Postgres', async () => {
    const { app, db, cookie } = await bootHubOnPg();
    const enrol = async (name: string) => {
      const inv = await supertest(app).post('/hub/federation/invite/create').set('Cookie', cookie).send({});
      const r = await supertest(app).post('/v1/federation/enroll').send({ inviteToken: inv.body.inviteToken, childHub: { name } });
      expect(r.status).toBe(200);
      return r.body as { token: string; childHubId: string };
    };
    const row = (id: string) => ({
      id: `outbox-${id}`, kind: 'event',
      payload: { identityPolicy: 'keep', event: {
        eventId: id, orgId: 'org', installationId: 'i1', userKey: 'alice@acme.com',
        occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed', itemId: `item-${id}`, payload: {},
      } },
    });

    const a = await enrol('pg-alpha');
    const b = await enrol('pg-beta');
    const deliver = (token: string, rows: unknown[]) =>
      supertest(app).post('/v1/federation/deliver').set('Authorization', `Bearer ${token}`).send({ rows });

    expect((await deliver(a.token, [row('e1'), row('e2')])).body).toMatchObject({ accepted: 2, duplicates: 0 });
    // at-least-once delivery means this WILL happen in production
    expect((await deliver(a.token, [row('e1'), row('e2')])).body).toMatchObject({ accepted: 0, duplicates: 2 });
    // the same ids from another child are a different series, not a collision
    expect((await deliver(b.token, [row('e1')])).body).toMatchObject({ accepted: 1 });

    // The rollup's new PRIMARY KEY column and its GROUP BY, on the backend
    // where the key had to be swapped in place rather than rebuilt.
    await recomputeRollups(db, { full: true });
    const rolled = await db.all<any>(
      "SELECT child_hub_id, events_count FROM rollups_daily WHERE child_hub_id <> '' ORDER BY events_count DESC",
    );
    expect(rolled).toHaveLength(2);
    expect(Number(rolled[0].events_count)).toBe(2);
    expect(Number(rolled[1].events_count)).toBe(1);

    // --- the childHubId query facet (CGLAB-184, task 3) on Postgres ---
    //
    // The filter is the one place the two backends can silently disagree.
    // `child_hub_id` is NULLable on events and NOT NULL DEFAULT '' on
    // rollups_daily, so the two tables get different SQL for the same question —
    // COALESCE(child_hub_id,'') on events, the plain column on rollups_daily —
    // and the dialect translator has to carry both through, alongside an IN list.
    const token = await issueApiKey(db, 'org', 'pg-local');
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({
      events: [{
        eventId: 'pg-local-1', orgId: 'org', installationId: 'inst-local',
        occurredAt: '2026-09-14T08:00:00.000Z',
        actor: { osUser: 'zoe', gitName: 'Z', gitEmail: 'zoe@acme.com' },
        type: 'item.created', itemType: 'TASK', itemId: 'i-pg-1',
        remoteUrl: 'git@github.com:acme/pg.git', payload: {},
      }],
    });
    await recomputeRollups(db, { full: true });

    const q = (url: string) => supertest(app).get(url).set('Cookie', cookie);

    const localUsers = await q('/v1/users?childHubId=local');
    expect(localUsers.status).toBe(200);
    expect(localUsers.body.map((u: any) => u.user_key)).toEqual(['zoe@acme.com']);

    const alphaUsers = await q(`/v1/users?childHubId=${a.childHubId}`);
    expect(alphaUsers.body.map((u: any) => u.user_key)).toEqual(['alice@acme.com']);

    // The rollups path, where the column is NOT NULL DEFAULT '' and the
    // predicate is therefore the plain column. Both spellings of the selection:
    // the sentinel, and an actual child hub id — the IN-list form had no
    // Postgres assertion at all, which is the half that regressed once.
    const localMetrics = await q('/v1/metrics?childHubId=local');
    expect(localMetrics.status).toBe(200);
    expect(localMetrics.body.series.map((s: any) => s.user_key)).toEqual(['zoe@acme.com']);

    const childMetrics = await q(`/v1/metrics?childHubId=${a.childHubId}`);
    expect(childMetrics.status).toBe(200);
    expect(childMetrics.body.series.map((s: any) => s.user_key)).toEqual(['alice@acme.com']);
    expect(childMetrics.body.series.reduce((n: number, s: any) => n + s.events_count, 0)).toBe(2);

    const bothMetrics = await q(`/v1/metrics?childHubId=local,${a.childHubId}`);
    expect(bothMetrics.body.series.map((s: any) => s.user_key).sort())
      .toEqual(['alice@acme.com', 'zoe@acme.com']);

    const facet = await q('/v1/child-hubs');
    expect(facet.status).toBe(200);
    expect(facet.body.childHubs.map((c: any) => c.id).sort())
      .toEqual([a.childHubId, b.childHubId].sort());
    expect(facet.body.childHubs.every((c: any) => typeof c.events === 'number')).toBe(true);
    expect(facet.body.hasLocal).toBe(true);

    await db.close();
  });
});
