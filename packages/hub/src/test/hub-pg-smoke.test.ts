// Boot the hub server backed by an in-process Postgres (pg-mem) and exercise
// the events ingest + query path end-to-end. This pins that the dialect
// translator covers the SQL the real call sites emit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { openPgMemDb } from '../db/postgres';
import { issueApiKey } from '../auth/apiKey';
import { createPasswordUser } from '../auth/password';
import type { HubDb } from '../db/types';

const SECRET = 'a'.repeat(64);

describe('hub server end-to-end on Postgres (pg-mem)', () => {
  let app: any;
  let db: HubDb;

  beforeEach(async () => {
    db = await openPgMemDb();
    const out = await createHubApp({
      // dbPath is unused when db is injected, but the type still requires it.
      dbPath: '/tmp/unused-pg-mem-test.sqlite',
      secretKey: SECRET,
      sessionSecret: 'sess-secret',
      defaultOrgId: 'org',
      db,
    });
    app = out.app;
  });

  afterEach(async () => {
    try { await db.close(); } catch { /* */ }
  });

  it('seeds default org + auth_config on first boot', async () => {
    const org = await db.get<{ id: string }>('SELECT id FROM orgs WHERE id = ?', ['org']);
    expect(org?.id).toBe('org');
    const cfg = await db.get<{ password_enabled: number }>(
      'SELECT password_enabled FROM auth_config WHERE org_id = ?', ['org']
    );
    expect(cfg?.password_enabled).toBe(1);
  });

  it('ingests an event via POST /v1/events with the dialect-translated INSERT', async () => {
    const token = await issueApiKey(db, 'org', 'pg-test');
    const event = {
      eventId: 'pg-e-1',
      installationId: 'inst-pg',
      orgId: 'org',
      occurredAt: '2026-05-03T10:00:00Z',
      actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
      type: 'item.created',
      projectId: 'p1',
      itemId: 'i1',
      payload: { title: 'demo' },
    };
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [event] });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);

    const countRow = await db.get<{ c: string | number }>('SELECT COUNT(*) AS c FROM events');
    // PG returns COUNT as bigint string; SQLite returns number. Coerce.
    expect(Number(countRow!.c)).toBe(1);
    const inst = await db.get<any>('SELECT * FROM installations WHERE id = ?', ['inst-pg']);
    expect(inst.os_user).toBe('alice');
  });

  it('queries timeline + event-types via PG (json_extract / strftime translated)', async () => {
    // Seed an admin so we can grab a session for /v1/timeline.
    await createPasswordUser(db, 'org', 'admin@x', 'longenough1', 'admin');
    const login = await supertest(app).post('/auth/login').send({ email: 'admin@x', password: 'longenough1' });
    const cookie = login.headers['set-cookie']?.[0] ?? '';
    expect(login.status).toBe(200);

    const token = await issueApiKey(db, 'org', 'pg-test');
    await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [{
          eventId: 'pg-e-2',
          installationId: 'inst-pg',
          orgId: 'org',
          occurredAt: '2026-05-03T10:00:00Z',
          actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@acme.com' },
          type: 'item.created',
          itemType: 'TASK',
          remoteUrl: 'git@x:y.git',
          itemTitle: 'Demo',
          payload: { title: 'demo' },
        }],
      });

    const tl = await supertest(app).get('/v1/timeline').set('Cookie', cookie);
    expect(tl.status).toBe(200);
    expect(tl.body.events.length).toBe(1);
    expect(tl.body.events[0].type).toBe('item.created');

    const types = await supertest(app).get('/v1/event-types').set('Cookie', cookie);
    expect(types.status).toBe(200);
    expect(types.body.types).toContain('item.created');
  });
});
