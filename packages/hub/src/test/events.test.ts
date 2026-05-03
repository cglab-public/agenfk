import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-events-test-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

const sampleEvent = (overrides: Partial<any> = {}) => ({
  eventId: 'e-' + Math.random().toString(36).slice(2),
  installationId: 'inst-1',
  orgId: 'org',
  occurredAt: '2026-05-03T10:00:00Z',
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail: 'alice@example.com' },
  type: 'item.created',
  projectId: 'p1',
  itemId: 'i1',
  payload: { title: 'demo' },
  ...overrides,
});

describe('hub /v1 events', () => {
  let app: any;
  let ctx: any;
  let token: string;

  beforeEach(() => {
    cleanup();
    const out = createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app;
    ctx = out.ctx;
    token = issueApiKey(ctx.db, 'org', 'test');
  });

  afterEach(() => { ctx.db.close(); cleanup(); });

  it('rejects requests without bearer', async () => {
    const r = await supertest(app).get('/v1/ping');
    expect(r.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const r = await supertest(app).get('/v1/ping').set('Authorization', 'Bearer garbage');
    expect(r.status).toBe(401);
  });

  it('ping returns ok with valid token', async () => {
    const r = await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, orgId: 'org' });
  });

  it('rejects revoked token', async () => {
    ctx.db.prepare('UPDATE api_keys SET revoked_at = datetime(\'now\')').run();
    const r = await supertest(app).get('/v1/ping').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
  });

  it('ingests valid events', async () => {
    const events = [sampleEvent({ eventId: 'e1' }), sampleEvent({ eventId: 'e2' })];
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Installation-Id', 'inst-1')
      .send({ events });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ ingested: 2, skipped: 0, rejected: 0 }));

    const count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
    expect(count).toBe(2);
    const inst = ctx.db.prepare('SELECT * FROM installations WHERE id = ?').get('inst-1') as any;
    expect(inst.os_user).toBe('alice');
    expect(inst.git_email).toBe('alice@example.com');
  });

  it('is idempotent on event_id', async () => {
    const events = [sampleEvent({ eventId: 'dup' })];
    let r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
    expect(r.body.ingested).toBe(1);
    r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
    expect(r.body.ingested).toBe(0);
    expect(r.body.skipped).toBe(1);
    const count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
    expect(count).toBe(1);
  });

  it('rejects events with mismatched orgId', async () => {
    const events = [sampleEvent({ orgId: 'someone-else' })];
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events });
    expect(r.body.rejected).toBe(1);
    expect(r.body.ingested).toBe(0);
  });

  it('rejects malformed payloads', async () => {
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [] });
    expect(r.status).toBe(400);

    const r2 = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send({ events: [{ nope: 1 }] });
    expect(r2.body.rejected).toBe(1);
    expect(r2.body.ingested).toBe(0);
  });

  it('user_key normalizes to lower(gitEmail) when present', async () => {
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1', actor: { osUser: 'alice', gitName: 'A', gitEmail: 'Alice@Example.COM' } })] });
    expect(r.status).toBe(200);
    const row = ctx.db.prepare('SELECT user_key FROM events').get() as any;
    expect(row.user_key).toBe('alice@example.com');
  });
});
