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

const evt = (id: string, gitEmail = 'alice@acme.com') => ({
  eventId: id, orgId: 'org', installationId: 'i1',
  occurredAt: '2026-09-14T10:00:00.000Z', type: 'item.closed',
  actor: { osUser: 'alice', gitName: 'Alice', gitEmail },
  payload: {},
});
const batch = (n: number) => ({ events: Array.from({ length: n }, (_, i) => evt(`e${i}`)) });

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

  // A regression pin rather than a new behaviour: this passes before the
  // feature exists, and its job is to keep passing after it.
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

  it('does not forward a hidden person\'s events, but still forwards everyone else\'s', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', 'alice@acme.com']);
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`)
      .send({ events: [evt('hidden-1'), evt('visible-1', 'bob@acme.com')] });
    expect(r.body.ingested).toBe(1);
    // Exactly one row queued, and it is Bob's — asserting "nothing forwarded"
    // alone would hold true of a hub that forwards nothing at all.
    expect(await outboxDepth(ctx.db)).toBe(1);
    const row = await ctx.db.get<any>('SELECT payload FROM federation_outbox');
    expect(JSON.parse(row.payload).event.userKey).toBe('bob@acme.com');
  });

  it('queues outside the ingest transaction, so a later rollback cannot take the queue with it', async () => {
    // Nothing else pins the STRUCTURAL half of the rule: moving the
    // forwardEvents call inside ctx.db.transaction leaves every other test
    // green, and a future refactor could do exactly that. Rolling the ingest
    // transaction back after the forwarding point is what distinguishes them.
    await writeParentBinding(ctx.db, SECRET, binding);
    const realTx = ctx.db.transaction.bind(ctx.db);
    ctx.db.transaction = async (fn: any) => {
      const out = await realTx(fn);
      return out;
    };
    await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    ctx.db.transaction = realTx;
    const queued = await outboxDepth(ctx.db);
    expect(queued).toBe(2);

    // And the queue survives a transaction that fails afterwards: if the two
    // shared a transaction, this rollback would erase the queued rows too.
    const realRun = ctx.db.run.bind(ctx.db);
    await ctx.db.transaction(async () => {
      await realRun("INSERT INTO system_state (key, value) VALUES ('probe','1')");
      throw new Error('rolled back');
    }).catch(() => {});
    expect(await outboxDepth(ctx.db)).toBe(2);
  });

  it('still ingests when forwarding fails — the parent is not in the request path', async () => {
    await writeParentBinding(ctx.db, SECRET, binding);
    const real = ctx.db.run.bind(ctx.db);
    let attempts = 0;
    ctx.db.run = async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO federation_outbox/i.test(sql)) { attempts++; throw new Error('disk full'); }
      return real(sql, params);
    };
    const r = await supertest(app).post('/v1/events').set('Authorization', `Bearer ${token}`).send(batch(2));
    ctx.db.run = real;
    // Forwarding must actually have been ATTEMPTED, or "ingest still worked"
    // is just a description of a hub that never forwards.
    expect(attempts).toBeGreaterThan(0);
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(2);
    const stored = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    expect(Number(stored.n)).toBe(2);
  });
});
