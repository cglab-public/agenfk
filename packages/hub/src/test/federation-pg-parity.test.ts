// Dual-backend parity for hub federation (CGLAB-181): the same enrollment
// scenario as federation-enroll.test.ts, run on the pg-mem backend so the new
// DDL and every runtime statement pass through the dialect translator.
import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { createPasswordUser } from '../auth/password';
import { issueApiKey } from '../auth/apiKey';
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
