// /v1/events on a child hub (CGLAB-184, task 1). The route-level guarantee:
// forwarding is a side effect of ingest and may never become a condition of it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { writeParentBinding } from '../services/federation/parentBinding';
import { outboxDepth } from '../services/federation/federationSync';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-fwd-route-${process.pid}.sqlite`);
const SECRET = 'a'.repeat(64);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const binding = { parentUrl: 'https://parent.example.com', token: 'fed_' + 'f'.repeat(64), childHubId: 'ch-1' };

const batch = (n: number) => ({
  events: Array.from({ length: n }, (_, i) => ({
    eventId: `e${i}`, orgId: 'org', installationId: 'i1', userKey: 'alice@acme.com',
    occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed', payload: {},
  })),
});

describe('/v1/events forwards to the parent without depending on it', () => {
  let app: any; let ctx: any; let token: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: SECRET, sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app; ctx = out.ctx;
    token = await issueApiKey(ctx.db, 'org', 'inst');
  });

  afterEach(async () => {
    ctx.stopWorkers?.();
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  it('queues nothing on a standalone hub, and ingests exactly as before', async () => {
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(2);
    expect(await outboxDepth(ctx.db)).toBe(0);
  });

  it('queues one row per ingested event once the hub has a parent', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(3));
    expect(r.body.ingested).toBe(3);
    expect(await outboxDepth(ctx.db)).toBe(3);
  });

  it('does not forward an event it did not ingest', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    // the same batch again: deduplicated locally, so nothing new goes upstream
    const again = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    expect(again.body.skipped).toBe(2);
    expect(await outboxDepth(ctx.db)).toBe(2);
  });

  it('does not forward a hidden person\'s events', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@acme.com']);
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    expect(r.body.ingested).toBe(0);
    expect(await outboxDepth(ctx.db)).toBe(0);
  });

  it('still ingests when forwarding fails — the parent is not in the request path', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    const real = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO federation_outbox/i.test(sql)) throw new Error('disk full');
      return real(sql, params);
    };
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    ctx.db.run = real;
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(2);
    const stored = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    expect(Number(stored.n)).toBe(2);
  });
});
