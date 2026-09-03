// Tests for CGLAB-31 ingest behaviour: events from hidden people (keyed on
// user_key = lowercased git email) are dropped BEFORE the installations
// upsert, so a hidden install cannot resurrect via the events stream.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { createHubApp } from '../server';
import { issueApiKey } from '../auth/apiKey';
import { drainApp } from './helpers/drainApp';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hub-events-hidden-${process.pid}.sqlite`);
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

describe('hub /v1/events — hidden users dropped at ingest (CGLAB-31)', () => {
  let app: any;
  let ctx: any;
  let token: string;

  beforeEach(async () => {
    cleanup();
    const out = await createHubApp({ dbPath: TEST_DB, secretKey: '0'.repeat(64), sessionSecret: 'sess', defaultOrgId: 'org' });
    app = out.app;
    ctx = out.ctx;
    token = await issueApiKey(ctx.db, 'org', 'test');
  });

  afterEach(async () => {
    // Drain in-flight responses before closing the DB — see helpers/drainApp.ts
    await drainApp(app);
    await ctx.db.close();
    cleanup();
  });

  const hide = (userKey: string) =>
    ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org', userKey]);

  it('drops events from a hidden person and does NOT store them', async () => {
    await hide('alice@example.com');
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1' })] });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(0);
    const c = await ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events');
    expect(c!.c).toBe(0);
  });

  it('does NOT upsert the hidden person\'s installation (hidden install cannot resurrect)', async () => {
    await hide('alice@example.com');
    await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1' })] });
    const inst = await ctx.db.get('SELECT id FROM installations WHERE id = ?', ['inst-1']);
    expect(inst).toBeUndefined();
  });

  it('does not touch last_seen of a pre-existing hidden installation', async () => {
    await ctx.db.run(
      `INSERT INTO installations (id, org_id, first_seen, last_seen, os_user, git_email)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['inst-1', 'org', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'alice', 'alice@example.com'],
    );
    await hide('alice@example.com');
    await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1' })] });
    const inst = await ctx.db.get<{ last_seen: string }>('SELECT last_seen FROM installations WHERE id = ?', ['inst-1']);
    expect(inst!.last_seen).toBe('2026-01-01T00:00:00Z');
  });

  it('still ingests events from non-hidden people in the same batch', async () => {
    await hide('alice@example.com');
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [
          sampleEvent({ eventId: 'e-hidden', actor: { osUser: 'alice', gitName: 'A', gitEmail: 'alice@example.com' } }),
          sampleEvent({ eventId: 'e-visible', installationId: 'inst-2', actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@example.com' } }),
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    const rows = await ctx.db.all<{ event_id: string }>('SELECT event_id FROM events');
    expect(rows.map(x => x.event_id)).toEqual(['e-visible']);
    // Visible person's installation upserted; hidden one's is not.
    expect(await ctx.db.get('SELECT id FROM installations WHERE id = ?', ['inst-2'])).toBeTruthy();
    expect(await ctx.db.get('SELECT id FROM installations WHERE id = ?', ['inst-1'])).toBeUndefined();
  });

  it('matches the hidden user_key case-insensitively (event git email in any case)', async () => {
    await hide('alice@example.com');
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1', actor: { osUser: 'alice', gitName: 'A', gitEmail: 'Alice@Example.COM' } })] });
    expect(r.body.ingested).toBe(0);
    const c = await ctx.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events');
    expect(c!.c).toBe(0);
  });

  it('reports dropped events in the response so operators can see the filter working', async () => {
    await hide('alice@example.com');
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [
          sampleEvent({ eventId: 'e1' }),
          sampleEvent({ eventId: 'e2' }),
          sampleEvent({ eventId: 'e3', installationId: 'inst-2', actor: { osUser: 'bob', gitName: 'B', gitEmail: 'bob@example.com' } }),
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(r.body.hiddenDropped ?? r.body.dropped ?? 0).toBe(2);
  });

  it('unhiding restores ingest (reversible)', async () => {
    await hide('alice@example.com');
    await ctx.db.run('DELETE FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org', 'alice@example.com']);
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1' })] });
    expect(r.body.ingested).toBe(1);
  });

  it('hidden in another org does not affect this org\'s ingest', async () => {
    await ctx.db.run('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)', ['org-b', 'org-b']);
    await ctx.db.run('INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)', ['org-b', 'alice@example.com']);
    const r = await supertest(app).post('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: [sampleEvent({ eventId: 'e1' })] });
    expect(r.body.ingested).toBe(1);
  });
});
